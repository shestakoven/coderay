import type { ToolClass } from '../gate/tools';

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
}

export interface Attribution {
  origin: 'agent' | 'agent-tool' | 'human';
  toolUseIds: string[];
  allowedOnce: boolean;
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
      if (entry.to !== null) continue;
      if (entry.call.toolClass === 'mcp') entry.interruptedAt = now;
      else entry.to = now;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  attribute(rel: string, at: number): Attribution {
    const active = [...this.entries.values()].filter((entry) => this.active(entry, at) && this.reaches(entry.call, rel));
    const covering = active.filter((entry) => WRITING.has(entry.call.toolClass) && (entry.call.allTracked || entry.call.targets.some((target) => under(rel, target))));
    if (covering.length > 0) return { origin: 'agent', toolUseIds: ids(covering), allowedOnce: covering.some((entry) => entry.call.allowedOnce) };
    const once = active.filter((entry) => entry.call.allowedOnce);
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

  private reaches(call: ToolCall, rel: string): boolean {
    if (!call.background) return true;
    return call.allTracked || call.targets.some((target) => under(rel, target)) || (call.cwdRel !== null && under(rel, call.cwdRel));
  }
}

function ids(entries: Entry[]): string[] {
  return entries.map((entry) => entry.call.toolUseId);
}
