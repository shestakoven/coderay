import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

export interface FsEvent {
  rel: string;
  exists: boolean;
  at: number;
  wall: number;
}

const EXCLUDED = new Set(['node_modules', '.venv', 'venv', '__pycache__']);
const PROBE_ATTEMPTS = 20;
const PROBE_WAIT_MS = 50;
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
  private watcher: FSWatcher | null = null;
  private probeDir: string | null = null;
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
    const rel = (abs: string): string => relative(this.o.root, abs).split(sep).join('/');
    // fs.watch on macOS has no started callback; a write to a second watched dir proves the stream is live.
    // The probe dir is removed only in stop(): removing it earlier silently killed watching of root.
    const probeDir = mkdtempSync(join(tmpdir(), 'watchdog-probe-'));
    this.probeDir = probeDir;
    const inProbe = (abs: string): boolean => abs === probeDir || abs.startsWith(probeDir + sep);
    const ignored = (abs: string): boolean => {
      if (inProbe(abs)) return false;
      const r = rel(abs);
      if (r === '') return false;
      if (r.split('/').some((s) => EXCLUDED.has(s))) return true;
      return r.startsWith('.git/') && !GIT_KEEP.test(r);
    };
    let probeSeen = false;
    const watcher = watch([this.o.root, probeDir], { ignoreInitial: true, followSymlinks: false, ignorePermissionErrors: true, atomic: false, ignored });
    this.watcher = watcher;
    const touch = (abs: string): void => {
      const r = rel(abs);
      if (this.timers.has(r)) return;
      const at = performance.now();
      const wall = Date.now();
      this.timers.set(r, { at, wall, timer: setTimeout(() => void this.settle(r), this.settleMs) });
    };
    const raw = (abs: string): void => {
      if (inProbe(abs)) {
        if (!this.o.testHooks?.discardProbeEvents) probeSeen = true;
        return;
      }
      if (this.o.testHooks?.dropRawFileEvents?.(rel(abs))) return;
      touch(abs);
    };
    const scan = (abs: string): void => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(abs, entry.name);
        if (ignored(child)) continue;
        if (entry.isDirectory()) scan(child);
        else touch(child);
      }
    };
    watcher.on('add', raw).on('change', raw).on('unlink', raw);
    watcher.on('error', (error) => console.error('watchdog: watch error', error));
    // a file written into a directory in the same tick as its creation can be missed by chokidar's own scan
    watcher.on('addDir', (abs) => {
      if (!inProbe(abs)) scan(abs);
    });
    const generation = this.generation;
    const stopped = (): Error => new Error('watchdog watcher stopped during start');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watchdog watcher never reported ready')), this.o.readyMs ?? READY_MS);
      this.abortStart = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      if (!this.o.testHooks?.swallowReady) {
        watcher.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
    this.abortStart = null;
    if (generation !== this.generation) throw stopped();
    const attempts = this.o.probeAttempts ?? PROBE_ATTEMPTS;
    const waitMs = this.o.probeWaitMs ?? PROBE_WAIT_MS;
    for (let i = 0; i < attempts && !probeSeen; i++) {
      writeFileSync(join(probeDir, `p${i}`), '');
      for (let waited = 0; waited < waitMs && !probeSeen && generation === this.generation; waited += 5) await new Promise((r) => setTimeout(r, 5));
      if (generation !== this.generation) throw stopped();
    }
    if (!probeSeen) throw new Error('watchdog watcher probe never reported: the file watcher is not delivering events');
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
    this.generation++;
    this.abortStart?.(new Error('watchdog watcher stopped during start'));
    this.abortStart = null;
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
    if (this.probeDir) rmSync(this.probeDir, { recursive: true, force: true });
    this.probeDir = null;
  }
}
