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
const MAX_SCAN_DEPTH = 32;
const PROBE_ATTEMPTS = 20;
const PROBE_WAIT_MS = 50;
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
  private probeDir: string | null = null;
  private readonly known = new Map<string, string>();
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
    // fs.watch on macOS has no started callback; a write to a second watched dir proves the stream is live.
    // The probe dir is removed only in stop(): removing it earlier silently killed watching of root.
    const probeDir = mkdtempSync(join(tmpdir(), 'watchdog-probe-'));
    this.probeDir = probeDir;
    let probeSeen = false;
    const watcher = watch([this.o.root, probeDir], { ignoreInitial: true, followSymlinks: false, ignorePermissionErrors: true, atomic: false, ignored });
    this.watcher = watcher;
    const touch = (abs: string): void => {
      if (abs.startsWith(probeDir)) {
        probeSeen = true;
        return;
      }
      const r = rel(abs);
      if (this.timers.has(r)) return;
      const at = performance.now();
      const wall = Date.now();
      this.timers.set(r, { at, wall, timer: setTimeout(() => void this.settle(r), this.settleMs) });
    };
    const scan = (abs: string, depth: number): void => {
      if (depth > MAX_SCAN_DEPTH) return;
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(abs, entry.name);
        if (ignored(child)) continue;
        if (entry.isDirectory()) scan(child, depth + 1);
        else touch(child);
      }
    };
    watcher.on('add', touch).on('change', touch).on('unlink', touch);
    // a file written into a directory in the same tick as its creation can be missed by chokidar's own scan
    watcher.on('addDir', (abs) => scan(abs, 0));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    for (let i = 0; i < PROBE_ATTEMPTS && !probeSeen; i++) {
      writeFileSync(join(probeDir, `p${i}`), '');
      for (let waited = 0; waited < PROBE_WAIT_MS && !probeSeen; waited += 5) await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async settle(r: string): Promise<void> {
    const entry = this.timers.get(r);
    this.timers.delete(r);
    if (!entry) return;
    const stat = await lstat(join(this.o.root, r)).then((s) => s, () => null);
    if (stat?.isDirectory()) return;
    if (stat) {
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (this.known.get(r) === stamp) return;
      this.known.set(r, stamp);
    } else this.known.delete(r);
    if (!this.watcher) return;
    for (const l of this.listeners) l({ rel: r, exists: stat !== null, at: entry.at, wall: entry.wall });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    this.known.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
    if (this.probeDir) rmSync(this.probeDir, { recursive: true, force: true });
    this.probeDir = null;
  }
}
