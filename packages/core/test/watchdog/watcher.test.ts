import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { onTestFinished, describe, expect, it, vi } from 'vitest';
import { WatchdogWatcher, type FsEvent } from '../../src/watchdog/watcher';
import { tempDir, waitFor } from '../helpers';

const created = vi.hoisted(() => ({ watchers: [] as unknown[] }));
vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>();
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => { const w = actual.watch(...args); created.watchers.push(w); return w; } };
});

async function watched(settleMs = 20): Promise<{ root: string; events: FsEvent[]; received: number[]; watcher: WatchdogWatcher }> {
  const root = tempDir('watch-');
  mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
  const events: FsEvent[] = [];
  const received: number[] = [];
  const watcher = new WatchdogWatcher({ root, settleMs });
  watcher.onEvent((e) => { events.push(e); received.push(performance.now()); });
  await watcher.start();
  onTestFinished(() => watcher.stop());
  return { root, events, received, watcher };
}

// fsevents can drop an event under load, so a sentinel that has not shown up is written again.
const sentinel = async (root: string, events: FsEvent[], name: string): Promise<void> => {
  let writes = 0;
  let lastWrite = 0;
  await waitFor(() => {
    if (events.some((e) => e.rel === name)) return true;
    if (Date.now() - lastWrite > 5_000) {
      writeFileSync(join(root, name), `s${writes++}`);
      lastWrite = Date.now();
    }
    return false;
  }, `sentinel ${name}`, 60_000);
};

const rels = (events: FsEvent[]): string[] => events.map((e) => e.rel);
const uniqueRels = (events: FsEvent[]): string[] => [...new Set(rels(events))].sort();
const probeDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('watchdog-probe-'));

function privateTmpdir(): void {
  const dir = tempDir('watch-private-tmp-');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  onTestFinished(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  });
}

describe('WatchdogWatcher', { timeout: 120_000 }, () => {
  it('reports a created file once with exists true', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, 'a.ts'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'create event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts').map((e) => e.exists)).not.toContain(false);
  });

  it('reports a modification and a deletion with the right exists', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length > 0, 'create');
    writeFileSync(join(root, 'a.ts'), '22');
    await waitFor(() => events.length > 0 && events.every((e) => e.exists), 'modify');
    rmSync(join(root, 'a.ts'));
    await waitFor(() => events.at(-1)?.exists === false, 'delete');
    expect(events.every((e) => e.rel === 'a.ts')).toBe(true);
  });

  it('reports an atomic save as one event that exists', async () => {
    const { root, events } = await watched(200);
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length > 0, 'first');
    events.length = 0;
    writeFileSync(join(root, 'a.ts.tmp'), '2');
    renameSync(join(root, 'a.ts.tmp'), join(root, 'a.ts'));
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'save event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts')).toEqual([expect.objectContaining({ exists: true })]);
    expect(events.filter((e) => e.rel === 'a.ts.tmp').every((e) => !e.exists)).toBe(true);
  });

  it('reports a delete followed by a re-create inside the window as one event that exists', async () => {
    const { root, events } = await watched(300);
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length > 0, 'create');
    events.length = 0;
    rmSync(join(root, 'a.ts'));
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, 'a.ts'), '2');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts')).toEqual([expect.objectContaining({ exists: true })]);
  });

  it('merges a create and later writes inside the settle window into one event', async () => {
    const { root, events } = await watched(400);
    writeFileSync(join(root, 'a.ts'), '1');
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(root, 'a.ts'), '22');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts')).toEqual([expect.objectContaining({ exists: true })]);
  });

  it('reports a file created in a new directory but no directory event', async () => {
    const { root, events } = await watched();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'f'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'a/b/f'), 'file event');
    await sentinel(root, events, 'z.ts');
    expect(uniqueRels(events)).toEqual(['a/b/f', 'z.ts']);
  });

  it('delivers a file written in the same tick as its new directory, 30 times', async () => {
    const { root, events } = await watched();
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(root, `d${i}`), { recursive: true });
      writeFileSync(join(root, `d${i}`, 'f.ts'), 'x');
    }
    await waitFor(() => new Set(rels(events)).size >= 30, 'all 30 files');
    await sentinel(root, events, 'z.ts');
    expect(uniqueRels(events).filter((r) => r !== 'z.ts')).toEqual(Array.from({ length: 30 }, (_, i) => `d${i}/f.ts`).sort());
  });

  it('delivers a nested a/b/c created and written at once', async () => {
    const { root, events } = await watched();
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', 'f.ts'), 'x');
    writeFileSync(join(root, 'a', 'g.ts'), 'x');
    await waitFor(() => rels(events).includes('a/b/c/f.ts') && rels(events).includes('a/g.ts'), 'nested events', 30_000);
    await sentinel(root, events, 'z.ts');
    expect(uniqueRels(events)).toEqual(['a/b/c/f.ts', 'a/g.ts', 'z.ts']);
  });

  for (const batch of [1, 2, 3]) {
    it(`delivers a write made the moment start() resolves, 10 times (batch ${batch} of 3)`, async () => {
      for (let i = 0; i < 10; i++) {
        const root = tempDir('watch-');
        const events: FsEvent[] = [];
        const watcher = new WatchdogWatcher({ root, settleMs: 20 });
        watcher.onEvent((e) => events.push(e));
        await watcher.start();
        writeFileSync(join(root, 'a.ts'), 'x');
        await waitFor(() => events.find((e) => e.rel === 'a.ts'), `event on iteration ${i}`, 30_000);
        await watcher.stop();
      }
    });
  }

  it('does not report files in ignored new directories', async () => {
    const { root, events } = await watched();
    mkdirSync(join(root, 'p', 'node_modules', 'q'), { recursive: true });
    writeFileSync(join(root, 'p', 'node_modules', 'q', 'i.js'), 'x');
    mkdirSync(join(root, '.git', 'objects', 'cd'), { recursive: true });
    writeFileSync(join(root, '.git', 'objects', 'cd', 'y'), 'x');
    await sentinel(root, events, 'z.ts');
    expect(rels(events)).toEqual(['z.ts']);
  });

  it('watches .git/HEAD and .git/refs but not .git/objects or .git/index', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, '.git', 'objects', 'ab', 'x'), '1');
    writeFileSync(join(root, '.git', 'index'), '1');
    writeFileSync(join(root, '.git', 'HEAD.lock'), '1');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref');
    for (const dir of ['refs/heads', 'hooks', 'info']) mkdirSync(join(root, '.git', dir), { recursive: true });
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'sha');
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!');
    writeFileSync(join(root, '.git', 'config'), '[core]');
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'x');
    await waitFor(() => new Set(rels(events)).size >= 5, 'git events');
    await sentinel(root, events, 'z.ts');
    expect([...new Set(rels(events))].sort()).toEqual([
      '.git/HEAD', '.git/config', '.git/hooks/pre-commit', '.git/info/exclude', '.git/refs/heads/main', 'z.ts',
    ]);
  });

  it('ignores node_modules, .venv, venv and __pycache__ at any depth', async () => {
    const { root, events } = await watched();
    for (const dir of ['node_modules/y', 'packages/x/node_modules/y', '.venv/lib', 'a/venv/lib', 'a/b/__pycache__']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'i.js'), '1');
    }
    await sentinel(root, events, 'z.ts');
    expect(rels(events)).toEqual(['z.ts']);
  });

  it('stamps at and wall from the first raw callback, before the settle window', async () => {
    const settleMs = 60;
    const { root, events, received } = await watched(settleMs);
    const wallBefore = Date.now();
    await sentinel(root, events, 'a.ts');
    const [event] = events;
    expect(received[0]! - event!.at).toBeGreaterThanOrEqual(settleMs - 5);
    expect(event!.wall).toBeGreaterThanOrEqual(wallBefore);
    expect(Date.now() - event!.wall).toBeGreaterThanOrEqual(settleMs - 5);
  });

  it('gives one event for the new name after a case-only rename, matching the disk', async () => {
    const { root, events } = await watched();
    const probe = join(root, 'probe.txt');
    writeFileSync(probe, '1');
    const insensitive = existsSync(join(root, 'PROBE.TXT'));
    await waitFor(() => events.find((e) => e.rel === 'probe.txt'), 'probe event');
    events.length = 0;
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'create');
    events.length = 0;
    renameSync(join(root, 'a.ts'), join(root, 'A.ts'));
    await waitFor(() => events.find((e) => e.rel === 'A.ts'), 'new name event');
    await sentinel(root, events, 'z.ts');
    const renamed = events.filter((e) => e.rel === 'A.ts');
    expect([renamed.length > 0, renamed.every((e) => e.exists)]).toEqual([true, true]);
    const old = events.filter((e) => e.rel === 'a.ts');
    if (insensitive) expect(old.every((e) => e.exists)).toBe(true);
    else expect(old.every((e) => !e.exists)).toBe(true);
  });

  it('stops delivering after stop()', async () => {
    const { root, events, watcher } = await watched();
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length > 0, 'first');
    await watcher.stop();
    writeFileSync(join(root, 'b.ts'), '1');
    const second = new WatchdogWatcher({ root, settleMs: 20 });
    const seen: FsEvent[] = [];
    second.onEvent((e) => seen.push(e));
    await second.start();
    onTestFinished(() => second.stop());
    writeFileSync(join(root, 'sentinel.ts'), '1');
    await waitFor(() => seen.find((e) => e.rel === 'sentinel.ts'), 'sentinel seen by second');
    await new Promise((r) => setTimeout(r, 60));
    expect(rels(events)).toEqual(['a.ts']);
  });

  it('start resolves at ready and a pending event is dropped by stop', async () => {
    const { root, events, watcher } = await watched(30_000);
    writeFileSync(join(root, 'a.ts'), '1');
    await new Promise((r) => setTimeout(r, 60));
    await watcher.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([]);
  });

  it('feeds a file the raw watcher missed through the new-directory scan', async () => {
    const root = tempDir('watch-');
    const events: FsEvent[] = [];
    const watcher = new WatchdogWatcher({ root, settleMs: 20, testHooks: { dropRawFileEvents: (rel) => rel.startsWith('gone/') } });
    watcher.onEvent((e) => events.push(e));
    await watcher.start();
    onTestFinished(() => watcher.stop());
    mkdirSync(join(root, 'gone', 'deep'), { recursive: true });
    writeFileSync(join(root, 'gone', 'deep', 'f.ts'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'gone/deep/f.ts'), 'scan-fed event');
  });

  it('reports a same-size rewrite that leaves the mtime unchanged', async () => {
    const { root, events } = await watched();
    const file = join(root, 'a.ts');
    const fixed = new Date(1_000_000_000_000);
    writeFileSync(file, 'aaaa');
    utimesSync(file, fixed, fixed);
    const first = await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'create');
    await sentinel(root, events, 'z.ts');
    events.length = 0;
    writeFileSync(file, 'bbbb');
    utimesSync(file, fixed, fixed);
    const second = await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'same-size rewrite with restored mtime');
    expect(second.at).toBeGreaterThan(first.at);
  });

  it('start() throws, closes the watcher and removes the probe dir when the handshake never completes', async () => {
    const root = tempDir('watch-');
    privateTmpdir();
    const before = probeDirs();
    const watcher = new WatchdogWatcher({ root, probeAttempts: 2, probeWaitMs: 20, testHooks: { discardProbeEvents: true } });
    await expect(watcher.start()).rejects.toThrow(/probe/);
    expect(probeDirs()).toEqual(before);
    await expect(watcher.start()).rejects.toThrow(/probe/);
  });

  it('refuses a second start()', async () => {
    const { watcher } = await watched();
    await expect(watcher.start()).rejects.toThrow(/already/);
  });

  it('works when the temp dir path itself contains node_modules', async () => {
    const root = tempDir('watch-');
    const base = tempDir('watch-');
    const odd = join(base, 'node_modules', 'venv');
    mkdirSync(odd, { recursive: true });
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = odd;
    onTestFinished(() => {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    });
    const events: FsEvent[] = [];
    const watcher = new WatchdogWatcher({ root, settleMs: 20 });
    watcher.onEvent((e) => events.push(e));
    await watcher.start();
    onTestFinished(() => watcher.stop());
    writeFileSync(join(root, 'a.ts'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'event');
  });

  it('stop() during start() makes start() reject and leaves no probe dir', async () => {
    const root = tempDir('watch-');
    privateTmpdir();
    const before = probeDirs();
    const watcher = new WatchdogWatcher({ root });
    const started = watcher.start();
    const outcome = expect(started).rejects.toThrow(/stopped/);
    await watcher.stop();
    await outcome;
    expect(probeDirs()).toEqual(before);
  });

  it('start() times out when the watcher never reports ready', async () => {
    const root = tempDir('watch-');
    privateTmpdir();
    const before = probeDirs();
    const watcher = new WatchdogWatcher({ root, readyMs: 100, testHooks: { swallowReady: true } });
    await expect(watcher.start()).rejects.toThrow(/ready/);
    expect(probeDirs()).toEqual(before);
  });

  it('logs a watch error instead of crashing and keeps reporting changes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const { root, events } = await watched();
    const fsWatcher = created.watchers.at(-1) as FSWatcher;
    const failure = Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
    expect(() => fsWatcher.emit('error', failure)).not.toThrow();
    expect(logged).toHaveBeenCalledWith('watchdog: watch error', failure);
    writeFileSync(join(root, 'after.ts'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'after.ts'), 'event after the watch error');
  });
});
