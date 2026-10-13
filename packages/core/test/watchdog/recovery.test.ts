import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Hold } from '../../src/gate/hold';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import { Baselines, newScanCache, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { RevertService } from '../../src/history/revert';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore, type Store } from '../../src/store/store';
import { ActivityLedger } from '../../src/watchdog/activity';
import { largest, recoverBaselines, recoverTranscript, UNCLEAN_STOP_KEY } from '../../src/watchdog/recovery';
import { Watchdog, type WatchdogSession } from '../../src/watchdog/watchdog';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';
import { git, projectWithWorktree } from '../worktree-fixture';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

class StubSession implements WatchdogSession {
  calls: string[] = [];
  alive = false;
  hasOpenTurn(): boolean { return false; }
  runningSubagents(): number { return 0; }
  runningSubagentNames(): string[] { return []; }
  runningShell(): boolean { return false; }
  processAlive(): boolean { return this.alive; }
  interrupt(): boolean { this.calls.push('interrupt'); return true; }
  send(text: string): void { this.calls.push(`send:${text}`); }
  sendAbsorbed(text: string): void { this.calls.push(`absorbed:${text}`); }
  queueNote(text: string): void { this.calls.push(`note:${text}`); }
  lastMessage(): string | null { return null; }
  onTurnClosed(): () => boolean { return () => true; }
}

async function world(root: string, storeDir: string, shadowDir: string) {
  const store: Store = openStore(storeDir);
  if (!store.latestSession()) store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(shadowDir);
  const baselines = new Baselines(store);
  const ideWrites = new IdeWrites();
  const changes = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger: new ActivityLedger(), store,
    checkpoints: new Checkpoints(store, () => 's1'), sessionId: () => 's1', plans: { gate: () => ({ state: 'none' }) },
  });
  const reverts = new RevertService({ root, shadow, baselines, ideWrites, changes, store, sessionId: () => 's1' });
  const session = new StubSession();
  const hold = new Hold();
  let n = 0;
  const watchdog = new Watchdog({
    store, sessionId: () => 's1', session, hold, shadow, root,
    plans: { gate: () => ({ state: 'none' }), canExpand: () => false, expand: () => { throw new Error('not here'); } } as never,
    changes, reverts,
    gate: { withdrawPending: () => undefined }, policy: () => DEFAULT_POLICY,
    toolInfo: () => undefined, settleMs: 30, newId: () => `ev-${store.watchdogEvents('s1').length}-${++n}`,
  });
  onTestFinished(async () => { await watchdog.quiesce(); await changes.idle(); });
  return { store, shadow, baselines, changes, session, hold, watchdog };
}

async function repo() {
  const root = tempDir('rc-root-');
  sh(root, 'init', '-q');
  await writeTree(root, { 'a.ts': 'a', 'b.ts': 'b' });
  sh(root, 'add', '-A');
  return { root, storeDir: tempDir('rc-store-'), shadowDir: tempDir('rc-shadow-') };
}

async function driftFixture(o: { crashed: boolean; seed?: boolean }) {
  const r = await repo();
  const w = await world(r.root, r.storeDir, r.shadowDir);
  if (o.seed !== false) await scanTree(r.root, DEFAULT_POLICY, w.shadow, w.baselines);
  const notices: string[] = [];
  const run = (crashed = o.crashed) => recoverBaselines({
    root: r.root, shadow: w.shadow, baselines: w.baselines, policy: DEFAULT_POLICY, changes: w.changes, watchdog: w.watchdog, crashed,
    notice: (text) => notices.push(text),
  });
  return { ...r, ...w, notices, run };
}

const editOnDisk = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); }
};

describe('Watchdog.restore', () => {
  async function stored() {
    const r = await repo();
    const first = await world(r.root, r.storeDir, r.shadowDir);
    await scanTree(r.root, DEFAULT_POLICY, first.shadow, first.baselines);
    editOnDisk(r.root, { 'a.ts': 'changed' });
    const drift = (await scanTree(r.root, DEFAULT_POLICY, first.shadow, first.baselines)).drift;
    const made = await first.changes.recordDrift(drift, 'unknown');
    first.watchdog.raiseUnknown(made);
    await waitFor(() => first.watchdog.events()[0]?.phase === 'pending', 'pending event');
    const base = first.store.watchdogEvents('s1')[0]!;
    first.store.saveWatchdogEvent('s1', { ...base, id: 'collecting-1', phase: 'collecting', interrupted: true, paused: true, unknownOrigin: false });
    const firstChangeId = made[0]!.id;
    first.store.close();
    const second = await world(r.root, r.storeDir, r.shadowDir);
    second.watchdog.restore();
    return { ...r, second, firstChangeId };
  }

  it('brings a pending or collecting event back as pending, without a hold', async () => {
    const f = await stored();
    const events = f.second.watchdog.events();
    expect(events.map((e) => [e.unknownOrigin, e.phase, e.paused, e.interrupted])).toEqual([[true, 'pending', false, false], [false, 'pending', false, true]]);
    expect(f.second.hold.isHeld()).toBe(false);
    expect(f.second.watchdog.isPending()).toBe(true);
    expect(f.second.store.watchdogEvents('s1').map((e) => [e.phase, e.paused])).toEqual([['pending', false], ['pending', false]]);
  });

  it('keeps the changes of a restored event through the store', async () => {
    const f = await stored();
    const [unknown] = f.second.watchdog.events();
    expect(unknown!.changes).toMatchObject([{ id: f.firstChangeId, path: 'a.ts', origin: 'unknown', enforcement: 'enforced', eventId: unknown!.id, afterHash: expect.any(String), beforeHash: expect.any(String) }]);
  });

  it('reverts a restored unknown event from the baseline blob', async () => {
    const f = await stored();
    const [unknown] = f.second.watchdog.events();
    await f.second.watchdog.answer(unknown!.id, { kind: 'all', answer: 'revert' });
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe('a');
    expect(f.second.watchdog.events()[0]).toMatchObject({ phase: 'resolved', resolution: 'reverted' });
  });

  it('keeps the file on keep', async () => {
    const f = await stored();
    const [unknown] = f.second.watchdog.events();
    await f.second.watchdog.answer(unknown!.id, { kind: 'all', answer: 'keep' });
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe('changed');
    expect(f.second.watchdog.events()[0]).toMatchObject({ phase: 'resolved', resolution: 'kept' });
    expect(f.second.changes.changes()[0]).toMatchObject({ resolution: 'kept' });
  });

  it('reports a conflict and overwrites nothing when the file changed again while the core was down', async () => {
    const f = await stored();
    editOnDisk(f.root, { 'a.ts': 'edited while the core was down' });
    const [unknown] = f.second.watchdog.events();
    await f.second.watchdog.answer(unknown!.id, { kind: 'all', answer: 'revert' });
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe('edited while the core was down');
    expect(f.second.watchdog.events()[0]!.reason).toMatch(/Not restored: a\.ts/);
  });

  it('answers a restored event by queueing the note, because the process is gone', async () => {
    const f = await stored();
    const event = f.second.watchdog.events().find((e) => e.unknownOrigin)!;
    await f.second.watchdog.answer(event.id, { kind: 'all', answer: 'mine' });
    expect(f.second.session.calls).toHaveLength(1);
    expect(f.second.session.calls[0]).toMatch(/^note:/);
    expect(f.second.watchdog.events().find((e) => e.id === event.id)).toMatchObject({ phase: 'resolved' });
  });

  it('keeps resolved events as they were and does not load an event twice', async () => {
    const f = await stored();
    f.second.watchdog.restore();
    expect(f.second.watchdog.events()).toHaveLength(2);
  });
});

describe('Watchdog.raiseUnknown', () => {
  it('opens one pending event with unknownOrigin, no interrupt, no hold, and offers keep, revert and mine only', async () => {
    const f = await driftFixture({ crashed: true });
    editOnDisk(f.root, { 'a.ts': 'changed' });
    await f.run();
    const [event] = f.watchdog.events();
    expect(event).toMatchObject({ unknownOrigin: true, phase: 'pending', interrupted: false, canExpand: false, kind: 'watchdog' });
    expect(f.hold.isHeld()).toBe(false);
    expect(f.session.calls).toEqual([]);
    expect(f.store.watchdogEvents('s1')).toMatchObject([{ id: event!.id, phase: 'pending', unknownOrigin: true }]);
    await expect(f.watchdog.answer(event!.id, { kind: 'all', answer: 'expand-plan' })).rejects.toThrow();
  });
});

describe('recoverBaselines', () => {
  it('raises one unknown event for enforced drift after an unclean stop', async () => {
    const f = await driftFixture({ crashed: true });
    editOnDisk(f.root, { 'a.ts': 'changed', '.omc/x': 'y' });
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.watchdog.events()[0]).toMatchObject({ unknownOrigin: true, canExpand: false, phase: 'pending' });
    expect(f.watchdog.events()[0]!.changes.map((c) => c.path)).toEqual(['a.ts']);
    expect(f.changes.changes().map((c) => [c.path, c.origin])).toEqual([['a.ts', 'unknown']]);
    expect(f.hold.isHeld()).toBe(false);
  });

  it('records drift silently as human after a clean stop', async () => {
    const f = await driftFixture({ crashed: false });
    editOnDisk(f.root, { 'a.ts': 'changed', 'new.ts': 'n' });
    rmSync(join(f.root, 'b.ts'));
    await f.run();
    expect(f.watchdog.events()).toEqual([]);
    expect(f.changes.changes().map((c) => [c.path, c.origin]).sort()).toEqual([['a.ts', 'human'], ['b.ts', 'human'], ['new.ts', 'human']]);
  });

  it('raises nothing on the first scan, which only seeds the baselines', async () => {
    const f = await driftFixture({ crashed: true, seed: false });
    await f.run();
    expect(f.watchdog.events()).toEqual([]);
    expect(f.changes.changes()).toEqual([]);
    expect(f.baselines.paths()).toContain('a.ts');
  });

  it('raises nothing for drift only in recorded files, and does not see it again on the next start', async () => {
    const f = await driftFixture({ crashed: true });
    editOnDisk(f.root, { '.omc/x': 'y' });
    await f.run();
    expect(f.watchdog.events()).toEqual([]);
    expect(f.changes.changes()).toEqual([]);
    expect((await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift).toEqual([]);
  });

  it('does not see the same drift twice', async () => {
    const f = await driftFixture({ crashed: true });
    editOnDisk(f.root, { 'a.ts': 'changed' });
    await f.run();
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.changes.changes()).toHaveLength(1);
  });

  it('shows a notice and does not throw when the scan fails', async () => {
    const f = await driftFixture({ crashed: true, seed: false });
    rmSync(join(f.root, '.git'), { recursive: true });
    mkdirSync(join(f.root, '.git'));
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatch(/could not check/i);
    expect(f.watchdog.events()).toEqual([]);
  });
});

describe('the unclean-stop marker and orphaned unknown changes', () => {
  it('clears the marker only when the scan completed', async () => {
    const f = await driftFixture({ crashed: true });
    f.store.setMeta(UNCLEAN_STOP_KEY, '1');
    await f.run();
    expect(f.store.meta(UNCLEAN_STOP_KEY)).toBe('');
  });

  it('leaves the marker set when the scan fails', async () => {
    const f = await driftFixture({ crashed: true, seed: false });
    f.store.setMeta(UNCLEAN_STOP_KEY, '1');
    rmSync(join(f.root, '.git'), { recursive: true });
    mkdirSync(join(f.root, '.git'));
    await f.run();
    expect(f.store.meta(UNCLEAN_STOP_KEY)).toBe('1');
  });

  it('returns quietly when the core is closing: no notice, no error, the marker stays and nothing is recorded', async () => {
    const f = await driftFixture({ crashed: true });
    f.store.setMeta(UNCLEAN_STOP_KEY, '1');
    editOnDisk(f.root, { 'a.ts': 'changed' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await recoverBaselines({
      root: f.root, shadow: f.shadow, baselines: f.baselines, policy: DEFAULT_POLICY, changes: f.changes, watchdog: f.watchdog, crashed: true,
      notice: (text) => f.notices.push(text), stopped: () => true,
    });
    expect([f.notices, error.mock.calls, f.store.meta(UNCLEAN_STOP_KEY), f.watchdog.events(), f.changes.changes()]).toEqual([[], [], '1', [], []]);
  });

  it('raises the event for unknown changes recorded before a crash between recording and raising, once', async () => {
    const f = await driftFixture({ crashed: false });
    editOnDisk(f.root, { 'a.ts': 'changed' });
    const drift = (await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift;
    await f.changes.recordDrift(drift, 'unknown');
    expect(f.watchdog.events()).toEqual([]);
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.watchdog.events()[0]).toMatchObject({ unknownOrigin: true, phase: 'pending' });
    expect(f.watchdog.events()[0]!.changes.map((c) => c.path)).toEqual(['a.ts']);
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
  });

  it('raises a single event for old orphans and new drift together', async () => {
    const f = await driftFixture({ crashed: true });
    editOnDisk(f.root, { 'a.ts': 'changed' });
    await f.changes.recordDrift((await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift, 'unknown');
    editOnDisk(f.root, { 'b.ts': 'changed too' });
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.watchdog.events()[0]!.changes.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('recoverBaselines with a nested worktree', () => {
  async function worktreeFixture() {
    const { root } = await projectWithWorktree();
    const w = await world(root, tempDir('rc-store-'), tempDir('rc-shadow-'));
    await scanTree(root, DEFAULT_POLICY, w.shadow, w.baselines);
    const notices: string[] = [];
    const run = (crashed = true) => recoverBaselines({
      root, shadow: w.shadow, baselines: w.baselines, policy: DEFAULT_POLICY, changes: w.changes, watchdog: w.watchdog, crashed, notice: (text) => notices.push(text),
    });
    return { root, ...w, notices, run };
  }

  it('raises nothing after an unclean stop for a worktree created while the core was down, and baselines it', async () => {
    const f = await worktreeFixture();
    git(f.root, 'worktree', 'add', '-q', '.worktrees/wt2');
    invalidateWorktrees(f.root);
    await f.run();
    expect([f.watchdog.events(), f.changes.changes(), f.notices]).toEqual([[], [], []]);
    expect(f.baselines.paths()).toEqual(expect.arrayContaining(['.worktrees/wt2/backend/src/a.py']));
    expect(f.baselines.meta(UNCLEAN_STOP_KEY)).toBe('');
  });

  it('raises nothing after an unclean stop for a worktree removed while the core was down, and forgets its files', async () => {
    const f = await worktreeFixture();
    expect(f.baselines.paths()).toContain('.worktrees/wt1/backend/src/a.py');
    git(f.root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    invalidateWorktrees(f.root);
    await f.run();
    expect([f.watchdog.events(), f.changes.changes()]).toEqual([[], []]);
    expect(f.baselines.paths().filter((path) => path.startsWith('.worktrees/'))).toEqual([]);
  });

  it('still raises an unknown event for a file of a known worktree that changed while the core was down', async () => {
    const f = await worktreeFixture();
    const before = f.baselines.get('.worktrees/wt1/backend/src/a.py')!.hash;
    editOnDisk(f.root, { '.worktrees/wt1/backend/src/a.py': 'a = 5\n', 'backend/src/a.py': 'a = 6\n' });
    await f.run();
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.changes.changes().map((c) => [c.path, c.origin]).sort()).toEqual([['.worktrees/wt1/backend/src/a.py', 'unknown'], ['backend/src/a.py', 'unknown']]);
    expect(f.changes.changes().find((c) => c.path.startsWith('.worktrees/'))!.beforeHash).toBe(before);
  });
});

const PLACES = [
  ['gitignored', '.worktrees/wt1'],
  ['not gitignored', 'trees/w1'],
  ['guarded', '.claude/worktrees/w1'],
] as const;

describe.each(PLACES)('recoverBaselines after a worktree in a %s place went away while the core was down', (_kind, dir) => {
  async function seenWorktree() {
    const { root } = await projectWithWorktree({}, dir);
    const w = await world(root, tempDir('rc-store-'), tempDir('rc-shadow-'));
    await scanTree(root, DEFAULT_POLICY, w.shadow, w.baselines);
    expect(w.baselines.paths()).toContain(`${dir}/backend/src/a.py`);
    const notices: string[] = [];
    const run = (crashed: boolean) => recoverBaselines({
      root, shadow: w.shadow, baselines: w.baselines, policy: DEFAULT_POLICY, changes: w.changes, watchdog: w.watchdog, crashed, notice: (text) => notices.push(text),
    });
    const under = (prefix: string = dir): string[] => w.baselines.paths().filter((path) => path.startsWith(`${prefix}/`));
    const quiet = (): unknown[] => [w.watchdog.events(), w.changes.changes(), notices, under()];
    return { root, ...w, run, quiet, under };
  }

  it.each([[true], [false]])('raises nothing and forgets its files when git removed it (crashed: %s)', async (crashed) => {
    const f = await seenWorktree();
    git(f.root, 'worktree', 'remove', '--force', dir);
    invalidateWorktrees(f.root);
    await f.run(crashed);
    expect(f.quiet()).toEqual([[], [], [], []]);
  });

  it('raises nothing and forgets its files when the directory vanished and git has not noticed', async () => {
    const f = await seenWorktree();
    rmSync(join(f.root, dir), { recursive: true });
    await f.run(true);
    expect(f.quiet()).toEqual([[], [], [], []]);
  });

  it('raises nothing when another repository took its place', async () => {
    const f = await seenWorktree();
    rmSync(join(f.root, dir), { recursive: true });
    sh(f.root, 'worktree', 'prune');
    sh(f.root, 'clone', '-q', f.root, dir);
    invalidateWorktrees(f.root);
    await f.run(true);
    expect(f.quiet()).toEqual([[], [], [], []]);
  });

  it('raises nothing for the moved worktree, which it takes as it is at its new place', async () => {
    const f = await seenWorktree();
    sh(f.root, 'worktree', 'move', dir, `${dir}-moved`);
    invalidateWorktrees(f.root);
    await f.run(true);
    expect([f.watchdog.events(), f.changes.changes(), f.under()]).toEqual([[], [], []]);
    expect(f.under(`${dir}-moved`)).toContain(`${dir}-moved/backend/src/a.py`);
  });
});

describe('recoverBaselines for a worktree created while the core was down, with files that are not settled', () => {
  const NEW = 'trees/w2';

  async function created() {
    const { root } = await projectWithWorktree();
    const w = await world(root, tempDir('rc-store-'), tempDir('rc-shadow-'));
    await scanTree(root, DEFAULT_POLICY, w.shadow, w.baselines);
    sh(root, 'worktree', 'add', '-q', NEW);
    writeFileSync(join(root, NEW, 'scratch.txt'), 'scratch\n');
    const later = new Date(Date.now() + 60_000);
    for (const file of ['scratch.txt', 'backend/src/a.py']) utimesSync(join(root, NEW, file), later, later);
    invalidateWorktrees(root);
    const marked = vi.spyOn(w.changes, 'markUnsighted');
    const run = () => recoverBaselines({
      root, shadow: w.shadow, baselines: w.baselines, policy: DEFAULT_POLICY, changes: w.changes, watchdog: w.watchdog, crashed: true, cache: newScanCache(),
    });
    return { root, ...w, marked, run };
  }

  it('hands those files to the change service as not seen, raising nothing and baselining none of them', async () => {
    const f = await created();
    await f.run();
    expect(f.marked).toHaveBeenCalledTimes(1);
    expect(f.marked.mock.calls[0]![0]).toEqual(expect.arrayContaining([`${NEW}/scratch.txt`, `${NEW}/backend/src/a.py`]));
    expect([f.watchdog.events(), f.changes.changes()]).toEqual([[], []]);
    expect(f.baselines.paths()).not.toContain(`${NEW}/scratch.txt`);
    expect(f.baselines.paths()).not.toContain(`${NEW}/backend/src/a.py`);
  });

  it('lets the later event of such an untracked file record it as one whose previous content is not known', async () => {
    const f = await created();
    await f.run();
    const at = performance.now();
    await f.changes.handle({ rel: `${NEW}/scratch.txt`, exists: true, at, wall: Date.now() });
    expect(f.changes.changes()).toMatchObject([{ path: `${NEW}/scratch.txt`, beforeHash: null, beforeMode: 0o644 }]);
  });
});

describe('recoverTranscript at scale', () => {
  const line = (i: number): string => JSON.stringify({
    type: 'assistant', uuid: `u${i}`, timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `message ${i} ${'x'.repeat(200)}` }] },
  });

  it('reads a 50 MB transcript line by line, fast, and returns the rows after since', async () => {
    const dir = tempDir('rc-tr-');
    const cwd = tempDir('rc-cwd-');
    const folder = join(dir, cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'sess.jsonl');
    const chunk = Array.from({ length: 1000 }, (_, i) => line(i)).join('\n') + '\n';
    writeFileSync(file, '');
    for (let n = 0; n < 200; n++) appendFileSync(file, chunk);
    const total = 200_000;
    appendFileSync(file, `${line(total + 1)}\n${line(total + 2)}\n`);
    const started = process.cpuUsage();
    const { items, unreadable } = await recoverTranscript({ engineSessionId: 'sess', cwd, since: Date.parse('2026-01-01T00:00:00Z') + total * 1000, dir });
    const cpu = process.cpuUsage(started);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(2000);
    expect(unreadable).toBe(false);
    expect(items.map((i) => (i.kind === 'message' ? i.id : ''))).toEqual([`recovered-u${total + 1}`, `recovered-u${total + 2}`]);
  }, 20_000);

  it('takes the largest of hundreds of thousands of values', () => {
    const values = Array.from({ length: 300_000 }, (_, i) => i);
    expect(largest(values)).toBe(299_999);
    expect(largest([])).toBe(0);
  });
});
