import { readdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { watchRecursive, type RecursiveWatch } from '../watch/recursive';

export interface FsEvent {
  rel: string;
  exists: boolean;
  at: number;
  wall: number;
}

const EXCLUDED = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
const READY_MS = 10_000;
const GIT_KEEP = /^\.git\/(HEAD$|refs(\/|$)|hooks(\/|$)|config$|info(\/|$))/;

interface Pending {
  timer: NodeJS.Timeout;
  at: number;
  wall: number;
}

export interface WatchdogWatcherOptions {
  root: string;
  settleMs?: number;
  probeAttempts?: number;
  probeWaitMs?: number;
  readyMs?: number;
  testHooks?: {
    swallowReady?: boolean;
    discardProbeEvents?: boolean;
    dropRawFileEvents?: (rel: string) => boolean;
  };
}

export class WatchdogWatcher {
  private watcher: RecursiveWatch | null = null;
  private generation = 0;
  private abortStart: ((error: Error) => void) | null = null;
  private readonly listeners = new Set<(e: FsEvent) => void>();
  private readonly timers = new Map<string, Pending>();
  private readonly settleMs: number;

  constructor(private readonly o: WatchdogWatcherOptions) {
    this.settleMs = o.settleMs ?? 40;
  }

  onEvent(l: (e: FsEvent) => void): () => boolean {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async start(): Promise<void> {
    if (this.watcher) throw new Error('watchdog watcher already started');
    try {
      await this.open();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async open(): Promise<void> {
    const watcher = watchRecursive(this.o.root, {
      ignored: (abs) => this.ignored(abs),
      onEvent: (abs) => {
        if (!this.o.testHooks?.dropRawFileEvents?.(this.rel(abs))) this.touch(abs);
      },
      onError: (error) => console.error('watchdog: watch error', error),
      probePrefix: 'watchdog-probe-',
      probeAttempts: this.o.probeAttempts,
      probeWaitMs: this.o.probeWaitMs,
      discardProbeEvents: this.o.testHooks?.discardProbeEvents,
    });
    this.watcher = watcher;
    const generation = this.generation;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watchdog watcher never reported ready')), this.o.readyMs ?? READY_MS);
      this.abortStart = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      if (this.o.testHooks?.swallowReady) return;
      watcher.ready.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    this.abortStart = null;
    if (generation !== this.generation) throw new Error('watchdog watcher stopped during start');
  }

  private rel(abs: string): string {
    return relative(this.o.root, abs).split(sep).join('/');
  }

  private ignored(abs: string): boolean {
    const r = this.rel(abs);
    // the root itself carries no file to report, and scanning it would replay the whole project
    if (r === '') return true;
    if (r.split('/').some((s) => EXCLUDED.has(s))) return true;
    return r.startsWith('.git/') && !GIT_KEEP.test(r);
  }

  private touch(abs: string): void {
    const r = this.rel(abs);
    if (this.timers.has(r)) return;
    const at = performance.now();
    const wall = Date.now();
    this.timers.set(r, { at, wall, timer: setTimeout(() => void this.settle(r), this.settleMs) });
  }

  private scan(abs: string): void {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (this.ignored(child)) continue;
      if (entry.isDirectory()) this.scan(child);
      else this.touch(child);
    }
  }

  private async settle(r: string): Promise<void> {
    const entry = this.timers.get(r);
    this.timers.delete(r);
    if (!entry) return;
    const abs = join(this.o.root, r);
    const stat = await lstat(abs).then((s) => s, () => null);
    if (!this.watcher) return;
    // a directory moved in reports only itself, and its files can land in the same tick as it
    if (stat?.isDirectory()) return this.scan(abs);
    for (const l of this.listeners) l({ rel: r, exists: stat !== null, at: entry.at, wall: entry.wall });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.abortStart?.(new Error('watchdog watcher stopped during start'));
    this.abortStart = null;
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
  }
}
