import { mkdtempSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const PROBE_ATTEMPTS = 20;
const PROBE_WAIT_MS = 50;
const REARM_MS = 1_000;
const MAX_REARM_MS = 30_000;

export interface RecursiveWatchOptions {
  ignored(absPath: string): boolean;
  onEvent(absPath: string): void;
  onError(error: Error): void;
  probePrefix?: string;
  probeAttempts?: number;
  probeWaitMs?: number;
  discardProbeEvents?: boolean;
}

export interface RecursiveWatch {
  ready: Promise<void>;
  close(): Promise<void>;
}

export function watchRecursive(root: string, o: RecursiveWatchOptions): RecursiveWatch {
  let closed = false;
  let watcher: FSWatcher | null = null;
  let probe: FSWatcher | null = null;
  let probeDir: string | null = null;
  let probeSeen = false;
  let rearmTimer: NodeJS.Timeout | undefined;
  let rearmMs = REARM_MS;

  const arm = (): void => {
    // libuv names an event on the watched directory itself by its basename, always as a change, which reads like a child.
    const rootName = basename(realpathSync(root));
    const current = watch(root, { recursive: true }, (type, filename) => {
      if (closed || current !== watcher || filename == null) return;
      const name = filename.toString();
      if (type === 'change' && name === rootName) return;
      const abs = join(root, name);
      if (!o.ignored(abs)) o.onEvent(abs);
    });
    watcher = current;
    current.on('error', (error) => {
      o.onError(error);
      if (current === watcher) rearm();
    });
  };
  // Node closes the handle after a real watch error; a later open picks the root up again, e.g. once it is recreated.
  const rearm = (): void => {
    if (closed || rearmTimer) return;
    rearmTimer = setTimeout(() => {
      rearmTimer = undefined;
      if (closed) return;
      watcher?.close();
      watcher = null;
      try {
        arm();
        rearmMs = REARM_MS;
      } catch (error) {
        o.onError(error as Error);
        rearmMs = Math.min(rearmMs * 2, MAX_REARM_MS);
        rearm();
      }
    }, rearmMs);
    rearmTimer.unref();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(rearmTimer);
    watcher?.close();
    // closed only here: closing it earlier rebuilds the shared stream and drops events meanwhile
    probe?.close();
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  };

  const ready = (async () => {
    arm();
    // No started callback on macOS; libuv shares one FSEvents stream, so a probe watched after the root proves both live.
    probeDir = mkdtempSync(join(tmpdir(), o.probePrefix ?? 'watch-probe-'));
    probe = watch(probeDir, () => {
      if (!o.discardProbeEvents) probeSeen = true;
    });
    probe.on('error', (error) => o.onError(error));
    const attempts = o.probeAttempts ?? PROBE_ATTEMPTS;
    const waitMs = o.probeWaitMs ?? PROBE_WAIT_MS;
    for (let i = 0; i < attempts && !probeSeen; i++) {
      writeFileSync(join(probeDir, `p${i}`), '');
      for (let waited = 0; waited < waitMs && !probeSeen && !closed; waited += 5) await new Promise((r) => setTimeout(r, 5));
      if (closed) throw new Error('file watch closed before it was live');
    }
    if (!probeSeen) throw new Error('file watch probe never reported: the file watcher is not delivering events');
  })();
  ready.catch(() => {});
  return { ready, close };
}
