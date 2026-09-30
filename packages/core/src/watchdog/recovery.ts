import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChangeView, Policy, ToolStatus } from '@ide/protocol';
import { classifyPaths } from '../gate/paths';
import { ScanError, scanTree, type Baselines, type Drift } from '../history/baselines';
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
}

export async function recoverBaselines(o: RecoverBaselinesOptions): Promise<void> {
  try {
    const { seeded, drift } = await scanTree(o.root, o.policy, o.shadow, o.baselines);
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
    if (enforced.length === 0) return;
    const made = await o.changes.recordDrift(enforced, o.crashed ? 'unknown' : 'human');
    if (o.crashed) o.watchdog.raiseUnknown(made.filter((c: ChangeView) => c.enforcement === 'enforced'));
  } catch (error) {
    const reason = error instanceof ScanError ? error.message : error instanceof Error ? error.message : String(error);
    console.error('recovery: could not check the files changed while the core was down', error);
    o.notice?.(`The IDE could not check which files changed while it was not running (${reason}).`);
  }
}

export interface RecoveredMessage { kind: 'message'; id: string; text: string; ts: number }
export interface RecoveredTool { kind: 'tool'; toolUseId: string; tool: string; input: unknown; status: ToolStatus; toolUseAt: number; endedAt: number | null }
export type RecoveredItem = RecoveredMessage | RecoveredTool;

export interface RecoverTranscriptOptions { claudeSessionId: string; cwd: string; since: number; dir: string }

export const defaultTranscriptsDir = (): string => join(homedir(), '.claude', 'projects');

const slug = (cwd: string): string => {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* the directory is gone; use the recorded path */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function recoverTranscript(o: RecoverTranscriptOptions): Promise<{ items: RecoveredItem[]; unreadable: boolean }> {
  let raw: string;
  try {
    raw = await readFile(join(o.dir, slug(o.cwd), `${o.claudeSessionId}.jsonl`), 'utf8');
  } catch {
    return { items: [], unreadable: true };
  }
  const items: RecoveredItem[] = [];
  const tools = new Map<string, RecoveredTool>();
  let parsed = 0;
  raw.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return; }
    if (!isObject(entry)) return;
    parsed += 1;
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(ts) || entry.isSidechain === true) return;
    const content = isObject(entry.message) && Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (entry.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
        if (ts <= o.since || block.text.trim() === '') continue;
        const id = `recovered-${typeof entry.uuid === 'string' ? entry.uuid : index}`;
        items.push({ kind: 'message', id, text: block.text, ts });
      } else if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (ts <= o.since || tools.has(block.id)) continue;
        const tool: RecoveredTool = { kind: 'tool', toolUseId: block.id, tool: block.name, input: block.input ?? null, status: 'unfinished', toolUseAt: ts, endedAt: null };
        tools.set(block.id, tool);
        items.push(tool);
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const tool = tools.get(block.tool_use_id);
        if (!tool || tool.endedAt !== null) continue;
        tool.status = block.is_error === true ? 'error' : 'ok';
        tool.endedAt = ts;
      }
    }
  });
  return { items, unreadable: parsed === 0 };
}
