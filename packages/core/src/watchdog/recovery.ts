import { realpathSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChangeView, Policy, ToolStatus } from '@ide/protocol';
import { classifyPaths } from '../gate/paths';
import { scanTree, type Baselines, type Drift, type ScanCache } from '../history/baselines';
import type { ChangeService } from '../history/changes';
import type { ShadowRepo } from '../history/shadow';
import type { BaselineRecord } from '../store/store';
import type { Watchdog } from './watchdog';

export interface RecoverBaselinesOptions {
  root: string;
  shadow: ShadowRepo;
  baselines: Baselines;
  policy: Policy;
  changes: ChangeService;
  watchdog: Watchdog;
  crashed: boolean;
  notice?: (text: string) => void;
  cache?: ScanCache;
}

export const UNCLEAN_STOP_KEY = 'unclean-stop-pending';

export function largest(values: Iterable<number>): number {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}

async function scanAndRecord(o: RecoverBaselinesOptions): Promise<void> {
  const { seeded, drift } = await scanTree(o.root, o.policy, o.shadow, o.baselines, o.cache, { unsighted: (rels) => o.changes.markUnsighted(rels) });
  if (seeded || drift.length === 0) return;
  const infos = await classifyPaths(drift.map((d) => join(o.root, d.path)), { root: o.root, policy: o.policy });
  const enforced: Drift[] = [];
  const rows: BaselineRecord[] = [];
  const removed: string[] = [];
  drift.forEach((d, i) => {
    if (infos[i]!.cls === 'enforced') return void enforced.push(d);
    if (d.after) rows.push({ path: d.path, hash: d.after.hash, stored: d.after.stored, size: d.after.size, mode: d.after.mode });
    else removed.push(d.path);
  });
  if (rows.length > 0 || removed.length > 0) o.baselines.setMany(rows, removed);
  if (enforced.length > 0) await o.changes.recordDrift(enforced, o.crashed ? 'unknown' : 'human');
}

export async function recoverBaselines(o: RecoverBaselinesOptions): Promise<void> {
  let complete = false;
  try {
    await scanAndRecord(o);
    complete = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('recovery: could not check the files changed while the core was down', error);
    o.notice?.(`The IDE could not check which files changed while it was not running (${reason}).`);
  }
  try {
    const orphans = o.changes.changes().filter((c: ChangeView) => c.origin === 'unknown' && c.enforcement === 'enforced' && c.eventId === null && c.resolution === null);
    if (orphans.length > 0) o.watchdog.raiseUnknown(orphans);
  } catch (error) {
    complete = false;
    console.error('recovery: could not raise the unknown-origin event', error);
  }
  if (complete) o.baselines.setMeta(UNCLEAN_STOP_KEY, '');
}

export interface RecoveredMessage { kind: 'message'; id: string; text: string; ts: number }
export interface RecoveredTool { kind: 'tool'; toolUseId: string; tool: string; input: unknown; status: ToolStatus; toolUseAt: number; endedAt: number | null }
export type RecoveredItem = RecoveredMessage | RecoveredTool;

export interface RecoverTranscriptOptions { claudeSessionId: string; cwd: string; since: number; dir: string }

export const defaultTranscriptsDir = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

const slug = (cwd: string): string => {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* the directory is gone; use the recorded path */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const transcriptPath = (dir: string, cwd: string, claudeSessionId: string): string => join(dir, slug(cwd), `${claudeSessionId}.jsonl`);

export async function recoverTranscript(o: RecoverTranscriptOptions): Promise<{ items: RecoveredItem[]; unreadable: boolean }> {
  const file = transcriptPath(o.dir, o.cwd, o.claudeSessionId);
  const entries: RecoveredItem[] = [];
  const tools = new Map<string, RecoveredTool>();
  let parsed = 0;
  try {
    if (!(await stat(file)).isFile()) return { items: [], unreadable: true };
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let index = 0;
    for await (const line of lines) {
      index += 1;
      if (line.trim() === '') continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!isObject(entry)) continue;
      parsed += 1;
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (Number.isNaN(ts) || entry.isSidechain === true) continue;
      const content = isObject(entry.message) && Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (entry.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
          if (ts <= o.since || block.text.trim() === '') continue;
          entries.push({ kind: 'message', id: `recovered-${typeof entry.uuid === 'string' ? entry.uuid : index}`, text: block.text, ts });
        } else if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          if (tools.has(block.id)) continue;
          const tool: RecoveredTool = {
            kind: 'tool', toolUseId: block.id, tool: block.name, input: ts > o.since ? block.input ?? null : null,
            status: 'unfinished', toolUseAt: ts, endedAt: null,
          };
          tools.set(block.id, tool);
          entries.push(tool);
        } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const tool = tools.get(block.tool_use_id);
          if (!tool || tool.endedAt !== null) continue;
          tool.status = block.is_error === true ? 'error' : 'ok';
          tool.endedAt = ts;
        }
      }
    }
  } catch {
    return { items: [], unreadable: true };
  }
  const items = entries.filter((item) => item.kind === 'message' || item.toolUseAt > o.since || (item.endedAt ?? 0) > o.since);
  return { items, unreadable: parsed === 0 };
}
