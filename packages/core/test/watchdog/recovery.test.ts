import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hold } from '../../src/gate/hold';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore, type Store } from '../../src/store/store';
import { ActivityLedger } from '../../src/watchdog/activity';
import { recoverBaselines } from '../../src/watchdog/recovery';
import { Watchdog, type WatchdogSession } from '../../src/watchdog/watchdog';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

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
  const changes = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites: new IdeWrites(), ledger: new ActivityLedger(), store,
    checkpoints: new Checkpoints(store, () => 's1'), sessionId: () => 's1', plans: { gate: () => ({ state: 'none' }) },
  });
  const session = new StubSession();
  const hold = new Hold();
  let n = 0;
  const watchdog = new Watchdog({
    store, sessionId: () => 's1', session, hold, shadow, root,
    plans: { gate: () => ({ state: 'none' }), canExpand: () => false, expand: () => { throw new Error('not here'); } } as never,
    changes, reverts: { revertChanges: () => { throw new Error('not here'); } },
    gate: { withdrawPending: () => undefined }, policy: () => DEFAULT_POLICY,
    toolInfo: () => undefined, settleMs: 30, newId: () => `ev-${store.watchdogEvents('s1').length}-${++n}`,
  });
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
    first.store.close();
    const second = await world(r.root, r.storeDir, r.shadowDir);
    second.watchdog.restore();
    return { ...r, second };
  }

  it('brings a pending or collecting event back as pending, without a hold', async () => {
    const f = await stored();
    const events = f.second.watchdog.events();
    expect(events.map((e) => [e.id === 'collecting-1', e.phase, e.paused])).toEqual(expect.arrayContaining([[true, 'pending', false]]));
    expect(events.filter((e) => e.phase === 'pending')).toHaveLength(2);
    expect(events.find((e) => e.id === 'collecting-1')).toMatchObject({ interrupted: true });
    expect(f.second.hold.isHeld()).toBe(false);
    expect(f.second.watchdog.isPending()).toBe(true);
    expect(f.second.store.watchdogEvents('s1').every((e) => e.phase === 'pending')).toBe(true);
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
