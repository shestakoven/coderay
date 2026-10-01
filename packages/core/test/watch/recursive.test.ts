import { mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchRecursive, type RecursiveWatch, type RecursiveWatchOptions } from '../../src/watch/recursive';
import { tempDir, waitFor } from '../helpers';

type Listener = (type: string, filename: string | null) => void;
const spy = vi.hoisted(() => ({
  recursive: [] as { watcher: FSWatcher; listener: Listener }[],
  failRecursive: 0,
  recursiveCalls: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = (...args: unknown[]): FSWatcher => {
    const recursive = (args[1] as { recursive?: boolean } | undefined)?.recursive === true;
    if (recursive) {
      spy.recursiveCalls++;
      if (spy.failRecursive > 0) {
        spy.failRecursive--;
        throw new Error('watch refused');
      }
    }
    const watcher = (actual.watch as (...a: unknown[]) => FSWatcher)(...args);
    if (recursive) spy.recursive.push({ watcher, listener: args[2] as Listener });
    return watcher;
  };
  return { ...actual, watch };
});

const open: RecursiveWatch[] = [];
afterEach(async () => {
  vi.useRealTimers();
  spy.failRecursive = 0;
  spy.recursive.length = 0;
  spy.recursiveCalls = 0;
  await Promise.all(open.splice(0).map((w) => w.close()));
});

interface Harness {
  root: string;
  events: string[];
  errors: Error[];
  watch: RecursiveWatch;
  ignoredCalls: string[];
}

function start(overrides: Partial<RecursiveWatchOptions> = {}, root = tempDir('rw-')): Harness {
  const events: string[] = [];
  const errors: Error[] = [];
  const ignoredCalls: string[] = [];
  const watch = watchRecursive(root, {
    ignored: (p) => {
      ignoredCalls.push(p);
      return false;
    },
    onEvent: (p) => events.push(p),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  open.push(watch);
  return { root, events, errors, watch, ignoredCalls };
}

const seen = (h: Harness, abs: string): Promise<string> => waitFor(() => h.events.find((p) => p === abs), `event for ${abs}`);
const lastWatcher = (): { watcher: FSWatcher; listener: Listener } => spy.recursive.at(-1)!;
const probeDirs = (prefix: string): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));

describe('watchRecursive events', { timeout: 60_000 }, () => {
  it('reports a created file', async () => {
    const h = start();
    await h.watch.ready;
    const file = join(h.root, 'created.ts');
    writeFileSync(file, 'x');
    await seen(h, file);
  });

  it('reports a modified file', async () => {
    const root = tempDir('rw-');
    const file = join(root, 'mod.ts');
    writeFileSync(file, '1');
    const h = start({}, root);
    await h.watch.ready;
    writeFileSync(file, '22');
    await seen(h, file);
  });

  it('reports a deleted file', async () => {
    const root = tempDir('rw-');
    const file = join(root, 'del.ts');
    writeFileSync(file, '1');
    const h = start({}, root);
    await h.watch.ready;
    rmSync(file);
    await seen(h, file);
  });

  it('reports both the old and the new path of a renamed file', async () => {
    const root = tempDir('rw-');
    const from = join(root, 'old.ts');
    const to = join(root, 'new.ts');
    writeFileSync(from, '1');
    const h = start({}, root);
    await h.watch.ready;
    renameSync(from, to);
    await seen(h, from);
    await seen(h, to);
  });

  it('reports a file inside a directory created after the watch started', async () => {
    const h = start();
    await h.watch.ready;
    const dir = join(h.root, 'nested', 'deeper');
    mkdirSync(dir, { recursive: true });
    await seen(h, join(h.root, 'nested'));
    const file = join(dir, 'late.ts');
    writeFileSync(file, 'x');
    await seen(h, file);
  });

  it('reports absolute paths under the watched root', async () => {
    const h = start();
    await h.watch.ready;
    writeFileSync(join(h.root, 'abs.ts'), 'x');
    await seen(h, join(h.root, 'abs.ts'));
    expect(h.events.every((p) => p.startsWith(`${h.root}/`))).toBe(true);
  });
});

describe('watchRecursive filtering', { timeout: 60_000 }, () => {
  it('never delivers an ignored path while its neighbours arrive', async () => {
    const h = start({ ignored: (p) => p.includes('/node_modules/') || p.endsWith('/node_modules') });
    await h.watch.ready;
    mkdirSync(join(h.root, 'node_modules'));
    writeFileSync(join(h.root, 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(h.root, 'kept.ts'), 'x');
    await seen(h, join(h.root, 'kept.ts'));
    writeFileSync(join(h.root, 'kept2.ts'), 'x');
    await seen(h, join(h.root, 'kept2.ts'));
    expect(h.events.filter((p) => p.includes('node_modules'))).toEqual([]);
  });

  it('consults ignored with the absolute path of the changed entry', async () => {
    const h = start();
    await h.watch.ready;
    const file = join(h.root, 'asked.ts');
    writeFileSync(file, 'x');
    await waitFor(() => h.ignoredCalls.includes(file), 'ignored consulted');
  });

  it('drops the change the platform reports under the root folder own name', async () => {
    const h = start();
    await h.watch.ready;
    const rootName = basename(h.root);
    lastWatcher().listener('change', rootName);
    expect(h.events).toEqual([]);
    expect(h.ignoredCalls).toEqual([]);
  });

  it('keeps a rename of an entry that happens to share the root folder name', async () => {
    const h = start();
    await h.watch.ready;
    lastWatcher().listener('rename', basename(h.root));
    expect(h.events).toEqual([join(h.root, basename(h.root))]);
  });

  it('keeps a change to a nested entry that shares the root folder name', async () => {
    const h = start();
    await h.watch.ready;
    const nested = join(basename(h.root), 'x');
    lastWatcher().listener('change', nested);
    expect(h.events).toEqual([join(h.root, nested)]);
  });

  it('drops events with no filename', async () => {
    const h = start();
    await h.watch.ready;
    lastWatcher().listener('change', null);
    lastWatcher().listener('rename', null);
    expect(h.events).toEqual([]);
    expect(h.ignoredCalls).toEqual([]);
  });

  it('does not report touching the root directory itself', async () => {
    const h = start();
    await h.watch.ready;
    utimesSync(h.root, new Date(), new Date(Date.now() + 5_000));
    writeFileSync(join(h.root, 'after-touch.ts'), 'x');
    await seen(h, join(h.root, 'after-touch.ts'));
    expect(h.events).not.toContain(h.root);
    expect(h.events).not.toContain(join(h.root, basename(h.root)));
  });
});

describe('watchRecursive lifecycle', { timeout: 60_000 }, () => {
  it('resolves ready only once the watcher delivers events and removes its probe directory on close', async () => {
    const prefix = `rw-probe-${process.pid}-${Date.now()}-`;
    const h = start({ probePrefix: prefix });
    expect(probeDirs(prefix)).toHaveLength(1);
    await h.watch.ready;
    expect(probeDirs(prefix)).toHaveLength(1);
    await h.watch.close();
    expect(probeDirs(prefix)).toEqual([]);
  });

  it('does not hand probe activity to the caller', async () => {
    const h = start();
    await h.watch.ready;
    expect(h.events).toEqual([]);
    expect(h.ignoredCalls).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('rejects ready when the probe never reports because its events are discarded', async () => {
    const h = start({ discardProbeEvents: true, probeAttempts: 2, probeWaitMs: 15 });
    await expect(h.watch.ready).rejects.toThrow(/never reported/);
  });

  it('rejects ready and removes the probe when closed before it was live', async () => {
    const prefix = `rw-early-${process.pid}-${Date.now()}-`;
    const h = start({ probePrefix: prefix, probeAttempts: 200, probeWaitMs: 50 });
    const settled = h.watch.ready.then(() => 'resolved', (e: Error) => e.message);
    await h.watch.close();
    expect(await settled).toMatch(/closed before it was live/);
    expect(probeDirs(prefix)).toEqual([]);
  });

  it('stops delivering events after close', async () => {
    const h = start();
    await h.watch.ready;
    const live = join(h.root, 'live.ts');
    writeFileSync(live, 'x');
    await seen(h, live);
    await h.watch.close();
    const before = h.events.length;
    writeFileSync(join(h.root, 'after-close.ts'), 'x');
    lastWatcher().listener('rename', 'late.ts');
    await new Promise((r) => setTimeout(r, 400));
    expect(h.events.length).toBe(before);
  });

  it('close is idempotent', async () => {
    const h = start();
    await h.watch.ready;
    await h.watch.close();
    await expect(h.watch.close()).resolves.toBeUndefined();
    expect(h.errors).toEqual([]);
  });

  it('resumes events after the root is removed and recreated', async () => {
    const h = start();
    await h.watch.ready;
    rmSync(h.root, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 300));
    mkdirSync(h.root);
    const file = join(h.root, 'reborn.ts');
    await waitFor(() => {
      writeFileSync(file, `${Math.random()}`);
      return h.events.includes(file);
    }, 'event after recreation', 20_000);
  });
});

describe('watchRecursive error recovery', { timeout: 60_000 }, () => {
  const readyWith = async (): Promise<Harness> => {
    const h = start();
    await h.watch.ready;
    return h;
  };

  it('reports a watcher error to onError', async () => {
    const h = await readyWith();
    const error = new Error('fsevents died');
    lastWatcher().watcher.emit('error', error);
    expect(h.errors).toEqual([error]);
  });

  it('re-opens the watch only after one second and then delivers events again', async () => {
    const h = await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const callsBefore = spy.recursiveCalls;
    lastWatcher().watcher.emit('error', new Error('boom'));
    vi.advanceTimersByTime(999);
    expect(spy.recursiveCalls).toBe(callsBefore);
    vi.advanceTimersByTime(1);
    expect(spy.recursiveCalls).toBe(callsBefore + 1);
    vi.useRealTimers();
    const file = join(h.root, 'after-rearm.ts');
    await waitFor(() => {
      writeFileSync(file, `${Math.random()}`);
      return h.events.includes(file);
    }, 'event after re-open', 20_000);
  });

  it('closes the failed watcher when it re-opens', async () => {
    await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = lastWatcher();
    const closeSpy = vi.spyOn(first.watcher, 'close');
    first.watcher.emit('error', new Error('boom'));
    vi.advanceTimersByTime(1_000);
    expect(closeSpy).toHaveBeenCalled();
    expect(lastWatcher().watcher).not.toBe(first.watcher);
  });

  it('ignores events from the stale watcher after re-opening', async () => {
    const h = await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stale = lastWatcher();
    stale.watcher.emit('error', new Error('boom'));
    vi.advanceTimersByTime(1_000);
    stale.listener('rename', 'stale.ts');
    expect(h.events).toEqual([]);
  });

  it('schedules one re-open for a burst of errors', async () => {
    await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const callsBefore = spy.recursiveCalls;
    const { watcher } = lastWatcher();
    watcher.emit('error', new Error('1'));
    watcher.emit('error', new Error('2'));
    watcher.emit('error', new Error('3'));
    vi.advanceTimersByTime(60_000);
    expect(spy.recursiveCalls).toBe(callsBefore + 1);
  });

  it('doubles the delay while re-opening keeps failing and caps it at 30 seconds', async () => {
    const h = await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    spy.failRecursive = 100;
    const callsBefore = spy.recursiveCalls;
    lastWatcher().watcher.emit('error', new Error('boom'));
    const attempts = (): number => spy.recursiveCalls - callsBefore;
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of delays.entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(attempts(), `before attempt ${i + 1}`).toBe(i);
      vi.advanceTimersByTime(1);
      expect(attempts(), `at attempt ${i + 1}`).toBe(i + 1);
    }
    expect(h.errors.filter((e) => e.message === 'watch refused')).toHaveLength(delays.length);
  });

  it('goes back to a one second delay after a re-open succeeds', async () => {
    await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    spy.failRecursive = 2;
    lastWatcher().watcher.emit('error', new Error('first'));
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(4_000);
    const settled = spy.recursiveCalls;
    lastWatcher().watcher.emit('error', new Error('second'));
    vi.advanceTimersByTime(999);
    expect(spy.recursiveCalls).toBe(settled);
    vi.advanceTimersByTime(1);
    expect(spy.recursiveCalls).toBe(settled + 1);
  });

  it('does not re-open after close', async () => {
    const h = await readyWith();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const callsBefore = spy.recursiveCalls;
    lastWatcher().watcher.emit('error', new Error('boom'));
    await h.watch.close();
    vi.advanceTimersByTime(60_000);
    expect(spy.recursiveCalls).toBe(callsBefore);
  });
});
