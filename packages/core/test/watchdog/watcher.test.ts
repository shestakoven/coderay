import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, describe, expect, it } from 'vitest';
import { WatchdogWatcher, type FsEvent } from '../../src/watchdog/watcher';
import { tempDir, waitFor } from '../helpers';

async function watched(settleMs = 20): Promise<{ root: string; events: FsEvent[]; received: number[]; watcher: WatchdogWatcher }> {
  const root = tempDir('watch-');
  for (const dir of ['refs/heads', 'hooks', 'info']) mkdirSync(join(root, '.git', dir), { recursive: true });
  mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
  const events: FsEvent[] = [];
  const received: number[] = [];
  const watcher = new WatchdogWatcher({ root, settleMs });
  watcher.onEvent((e) => { events.push(e); received.push(performance.now()); });
  await watcher.start();
  onTestFinished(() => watcher.stop());
  return { root, events, received, watcher };
}

const sentinel = async (root: string, events: FsEvent[], name: string): Promise<void> => {
  writeFileSync(join(root, name), 's');
  await waitFor(() => events.find((e) => e.rel === name), `sentinel ${name}`);
};

const rels = (events: FsEvent[]): string[] => events.map((e) => e.rel);

describe('WatchdogWatcher', () => {
  it('reports a created file once with exists true', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, 'a.ts'), 'x');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'create event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts')).toEqual([expect.objectContaining({ exists: true })]);
  });

  it('reports a modification and a deletion with the right exists', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length === 1, 'create');
    writeFileSync(join(root, 'a.ts'), '22');
    await waitFor(() => events.length === 2, 'modify');
    expect(events[1]).toMatchObject({ rel: 'a.ts', exists: true });
    rmSync(join(root, 'a.ts'));
    await waitFor(() => events.length === 3, 'delete');
    expect(events[2]).toMatchObject({ rel: 'a.ts', exists: false });
  });

  it('reports an atomic save as one event that exists', async () => {
    const { root, events } = await watched();
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
    const { root, events } = await watched(150);
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length === 1, 'create');
    events.length = 0;
    rmSync(join(root, 'a.ts'));
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(root, 'a.ts'), '2');
    await waitFor(() => events.find((e) => e.rel === 'a.ts'), 'event');
    await sentinel(root, events, 'z.ts');
    expect(events.filter((e) => e.rel === 'a.ts')).toEqual([expect.objectContaining({ exists: true })]);
  });

  it('merges a create and later writes inside the settle window into one event', async () => {
    const { root, events } = await watched(150);
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
    expect(rels(events).sort()).toEqual(['a/b/f', 'z.ts']);
  });

  it('watches .git/HEAD and .git/refs but not .git/objects or .git/index', async () => {
    const { root, events } = await watched();
    writeFileSync(join(root, '.git', 'objects', 'ab', 'x'), '1');
    writeFileSync(join(root, '.git', 'index'), '1');
    writeFileSync(join(root, '.git', 'HEAD.lock'), '1');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref');
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
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length === 1, 'event');
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
    expect(events.filter((e) => e.rel === 'A.ts')).toEqual([expect.objectContaining({ exists: true })]);
    const old = events.filter((e) => e.rel === 'a.ts');
    if (insensitive) expect(old.every((e) => e.exists)).toBe(true);
    else expect(old.every((e) => !e.exists)).toBe(true);
  });

  it('stops delivering after stop()', async () => {
    const { root, events, watcher } = await watched();
    writeFileSync(join(root, 'a.ts'), '1');
    await waitFor(() => events.length === 1, 'first');
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
    const { root, events, watcher } = await watched(200);
    writeFileSync(join(root, 'a.ts'), '1');
    await new Promise((r) => setTimeout(r, 60));
    await watcher.stop();
    await new Promise((r) => setTimeout(r, 250));
    expect(events).toEqual([]);
  });
});
