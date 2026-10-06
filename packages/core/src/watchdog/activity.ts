import type { ToolClass } from '../gate/tools';

// A git command that can move HEAD: the repository's top, its place under the project root ("" for the root), and HEAD before the call.
export interface HistoryCall {
  dir: string;
  top: string;
  head: string | null;
}

export interface ToolCall {
  toolUseId: string;
  parentToolUseId: string | null;
  tool: string;
  toolClass: ToolClass;
  targets: string[];
  allTracked: boolean;
  cwdRel: string | null;
  background: boolean;
  allowedOnce: boolean;
  history?: HistoryCall[];
}

export interface Attribution {
  origin: 'agent' | 'agent-tool' | 'git' | 'human';
  toolUseIds: string[];
  allowedOnce: boolean;
}

export interface AttributionScope {
  tracked?: boolean;
  enforced?: boolean;
  deleted?: boolean;
}

export interface ActivityLedgerOptions {
  now?: () => number;
  graceMs?: number;
  lingerMs?: number;
}

interface Entry {
  call: ToolCall;
  from: number;
  to: number | null;
  interruptedAt: number | null;
}

const GRACE_MS = 2_000;
const LINGER_MS = 60_000;
const KEEP_ENDED_MS = 3_600_000;
const COUNTING = new Set<ToolClass>(['file-writer', 'shell', 'subagent', 'mcp', 'unknown']);
const WRITING = new Set<ToolClass>(['file-writer', 'shell']);

export const isGitState = (rel: string): boolean => rel === '.git/HEAD' || rel === '.git/refs' || rel.startsWith('.git/refs/');

const under = (rel: string, base: string): boolean => {
  const dir = base.replace(/\/+$/, '');
  return dir === '' || dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
};

export class ActivityLedger {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly lingerMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: ActivityLedgerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.graceMs = options.graceMs ?? GRACE_MS;
    this.lingerMs = options.lingerMs ?? LINGER_MS;
  }

  allowed(call: ToolCall): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.to !== null && entry.to < now - KEEP_ENDED_MS) this.entries.delete(id);
    }
    const existing = this.entries.get(call.toolUseId);
    if (existing) existing.call = call;
    else this.entries.set(call.toolUseId, { call, from: now, to: null, interruptedAt: null });
  }

  unjudged(call: ToolCall, from: number, to: number): void {
    if (!this.entries.has(call.toolUseId)) this.entries.set(call.toolUseId, { call, from, to, interruptedAt: null });
  }

  ended(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.to === null && !entry.call.background) entry.to = this.now();
  }

  taskEnded(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.to === null) entry.to = this.now();
  }

  interrupted(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.to !== null || entry.call.background) continue;
      if (entry.call.toolClass !== 'mcp') entry.to = now;
      else entry.interruptedAt ??= now;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  attribute(rel: string, at: number, scope: AttributionScope = {}): Attribution {
    const allTracked = scope.tracked !== false;
    const active = [...this.entries.values()].filter((entry) => this.active(entry, at) && this.reaches(entry.call, rel, allTracked));
    const covering = active.filter((entry) => WRITING.has(entry.call.toolClass) && ((allTracked && entry.call.allTracked) || entry.call.targets.some((target) => under(rel, target))));
    if (covering.length > 0) return { origin: 'agent', toolUseIds: ids(covering), allowedOnce: covering.some((entry) => entry.call.allowedOnce) };
    const history = active.filter((entry) => WRITING.has(entry.call.toolClass) && historyMade(entry.call, rel, scope));
    if (history.length > 0) return { origin: 'git', toolUseIds: ids(history), allowedOnce: false };
    const once = scope.enforced === false ? [] : active.filter((entry) => entry.call.allowedOnce);
    if (once.length > 0) return { origin: 'agent', toolUseIds: ids(once), allowedOnce: true };
    if (active.length > 0) return { origin: 'agent-tool', toolUseIds: ids(active), allowedOnce: false };
    return { origin: 'human', toolUseIds: [], allowedOnce: false };
  }

  windowOf(id: string): { from: number; to: number | null } | undefined {
    const entry = this.entries.get(id);
    return entry ? { from: entry.from, to: entry.to } : undefined;
  }

  runningSubagents(): number {
    return this.openBackground('subagent').length;
  }

  runningShell(): boolean {
    return this.openBackground('shell').length > 0;
  }

  private openBackground(toolClass: ToolClass): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.call.background && entry.call.toolClass === toolClass && entry.to === null);
  }

  private active(entry: Entry, at: number): boolean {
    if (!COUNTING.has(entry.call.toolClass) || at < entry.from) return false;
    if (entry.to !== null) return at <= entry.to + this.graceMs;
    return entry.interruptedAt === null || at <= entry.interruptedAt + this.lingerMs;
  }

  // A background call at the project root would otherwise claim every file anyone writes while it runs.
  private reaches(call: ToolCall, rel: string, allTracked: boolean): boolean {
    if (!call.background) return true;
    return (allTracked && call.allTracked) || call.targets.some((target) => under(rel, target)) || (call.cwdRel !== null && call.cwdRel !== '' && call.cwdRel !== '.' && under(rel, call.cwdRel)) || (call.history?.some((h) => h.dir !== '' && under(rel, h.dir)) ?? false);
  }
}

// A history call may write every file it leaves tracked or deletes in its repository, and the repository's refs.
function historyMade(call: ToolCall, rel: string, scope: AttributionScope): boolean {
  const history = call.history ?? [];
  if (history.length === 0) return false;
  return isGitState(rel) || ((scope.tracked !== false || scope.deleted === true) && history.some((h) => under(rel, h.dir)));
}

function ids(entries: Entry[]): string[] {
  return entries.map((entry) => entry.call.toolUseId);
}
