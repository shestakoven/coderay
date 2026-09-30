import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

export interface FsEvent {
  rel: string;
  exists: boolean;
  at: number;
  wall: number;
}

const EXCLUDED = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
const GIT_KEEP = /^\.git\/(HEAD$|refs(\/|$)|hooks(\/|$)|config$|info(\/|$))/;

interface Pending {
  timer: NodeJS.Timeout;
  at: number;
  wall: number;
}

export class WatchdogWatcher {
  private watcher: FSWatcher | null = null;
  private readonly listeners = new Set<(e: FsEvent) => void>();
  private readonly timers = new Map<string, Pending>();
  private readonly settleMs: number;

  constructor(private readonly o: { root: string; settleMs?: number }) {
    this.settleMs = o.settleMs ?? 40;
  }

  onEvent(l: (e: FsEvent) => void): () => boolean {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async start(): Promise<void> {
    const rel = (abs: string): string => relative(this.o.root, abs).split(sep).join('/');
    const ignored = (abs: string): boolean => {
      const r = rel(abs);
      if (r === '') return false;
      if (r.split('/').some((s) => EXCLUDED.has(s))) return true;
      return r.startsWith('.git/') && !GIT_KEEP.test(r);
    };
    const watcher = watch(this.o.root, { ignoreInitial: true, followSymlinks: false, ignorePermissionErrors: true, atomic: false, ignored });
    this.watcher = watcher;
    const touch = (abs: string): void => {
      const r = rel(abs);
      if (this.timers.has(r)) return;
      const at = performance.now();
      const wall = Date.now();
      this.timers.set(r, { at, wall, timer: setTimeout(() => void this.settle(r), this.settleMs) });
    };
    watcher.on('add', touch).on('change', touch).on('unlink', touch);
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    // chokidar 'ready' can precede live delivery on macOS: a write right after it is sometimes lost
    await new Promise((r) => setTimeout(r, 100));
  }

  private async settle(r: string): Promise<void> {
    const entry = this.timers.get(r);
    this.timers.delete(r);
    if (!entry) return;
    const stat = await lstat(join(this.o.root, r)).then((s) => s, () => null);
    if (stat?.isDirectory()) return;
    if (!this.watcher) return;
    for (const l of this.listeners) l({ rel: r, exists: stat !== null, at: entry.at, wall: entry.wall });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
  }
}
