import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeView, ControlMode, FileAnswer, WatchdogAnswer, WatchdogEventView } from '@ide/protocol';
import { Hold } from '../../src/gate/hold';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { RevertService } from '../../src/history/revert';
import { ShadowRepo } from '../../src/history/shadow';
import { reviewPlan } from '../../src/plans/freeze';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import { Watchdog, WatchdogError, type WatchdogSession } from '../../src/watchdog/watchdog';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const toolCall = (): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Bash', toolClass: 'shell', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false,
});

class StubSession implements WatchdogSession {
  order: string[] = [];
  turnOpen: boolean;
  alive = true;
  names: string[];
  throwing = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(o: { turnOpen: boolean; subagents: number }) { this.turnOpen = o.turnOpen; this.names = Array.from({ length: o.subagents }, (_, i) => `subagent ${i}`); }
  private guard(name: string): void { if (this.throwing.has(name)) throw new Error(`${name} exploded`); }
  hasOpenTurn(): boolean { return this.turnOpen; }
  runningSubagents(): number { return this.names.length; }
  runningSubagentNames(): string[] { return [...this.names]; }
  runningShell(): boolean { return false; }
  processAlive(): boolean { return this.alive; }
  interrupt(): boolean { this.order.push('interrupt'); return true; }
  send(text: string): void { this.guard('send'); this.order.push(`send:${text}`); }
  sendAbsorbed(text: string): void { this.guard('sendAbsorbed'); this.order.push(`absorbed:${text}`); }
  queueNote(text: string): void { this.guard('queueNote'); this.order.push(`note:${text}`); }
  lastMessage(): string | null { return 'I changed the files.'; }
  onTurnClosed(listener: () => void): () => boolean { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  closeTurn(): void { this.turnOpen = false; for (const listener of [...this.listeners]) listener(); }
  of(prefix: string): string[] { return this.order.filter((entry) => entry.startsWith(prefix)); }
}

interface Setup { turnOpen?: boolean; subagents?: number; mode?: ControlMode; plan?: boolean; deliverWaitMs?: number }

async function fixture(o: Setup = {}) {
  const root = tempDir('ans-root-');
  sh(root, 'init', '-q');
  await writeTree(root, { 'a.ts': 'a', 'b.ts': 'b', 'src/c.ts': 'c', 'src/app.ts': 'app' });
  sh(root, 'add', '-A');
  const store = openStore(tempDir('ans-store-'));
  store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(tempDir('ans-shadow-'));
  const baselines = new Baselines(store);
  await scanTree(root, DEFAULT_POLICY, shadow, baselines);
  const ideWrites = new IdeWrites();
  const ledger = new ActivityLedger();
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => [],
    review: (steps) => reviewPlan(steps, { root, policy: DEFAULT_POLICY, components: [], tempRoots: [] }),
  });
  if (o.plan) {
    await plans.propose({ goal: 'Fix app', steps: [{ key: 'edit', title: 'Edit app', rationale: 'bug', targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
    plans.step({ key: 'edit', phase: 'start' });
  }
  const changes = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger, store, checkpoints: new Checkpoints(store, () => 's1'),
    sessionId: () => 's1', plans,
  });
  const reverts = new RevertService({ root, shadow, baselines, ideWrites, changes, store, sessionId: () => 's1' });
  const session = new StubSession({ turnOpen: o.turnOpen ?? false, subagents: o.subagents ?? 0 });
  const hold = new Hold();
  const release = hold.release.bind(hold);
  hold.release = () => { session.order.push('release'); release(); };
  const policy = { ...DEFAULT_POLICY, mode: o.mode ?? 'B' };
  let n = 0;
  const watchdog = new Watchdog({
    store, sessionId: () => 's1', session, hold, shadow, root, plans, changes, reverts,
    gate: { withdrawPending: () => undefined }, policy: () => policy,
    toolInfo: () => undefined, settleMs: 30, newId: () => `ev${++n}`, deliverWaitMs: o.deliverWaitMs,
  });
  const emitted: WatchdogEventView[] = [];
  watchdog.onChange((e) => emitted.push(e));
  const produce = async (rels: string[], content = 'agent version'): Promise<ChangeView[]> => {
    ledger.allowed(toolCall());
    for (const rel of rels) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); }
    const now = Date.now();
    await Promise.all(rels.map((rel) => changes.handle({ rel, exists: true, at: now, wall: now })));
    return rels.map((rel) => changes.changes().findLast((c) => c.path === rel)!);
  };
  const remove = async (rel: string): Promise<ChangeView> => {
    ledger.allowed(toolCall());
    rmSync(join(root, rel));
    const now = Date.now();
    await changes.handle({ rel, exists: false, at: now, wall: now });
    return changes.changes().findLast((c) => c.path === rel)!;
  };
  const raise = async (cs: ChangeView[]): Promise<WatchdogEventView> => {
    for (const c of cs) watchdog.consider(c);
    return waitFor(() => watchdog.events().find((e) => e.phase === 'pending'), 'a pending event');
  };
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  return { root, store, hold, session, watchdog, changes, plans, emitted, produce, remove, raise, read };
}

type F = Awaited<ReturnType<typeof fixture>>;
const answer = (f: F, id: string, a: WatchdogAnswer): Promise<void> => f.watchdog.answer(id, a);
const all = (a: FileAnswer | 'expand-plan'): WatchdogAnswer => ({ kind: 'all', answer: a });
const event = (f: F, id: string): WatchdogEventView => f.watchdog.events().find((e) => e.id === id)!;

describe('Watchdog.answer', () => {
  it('keeps everything without reverting and sends the resume note after the interrupted turn closes', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts', 'b.ts']));
    expect(e.interrupted).toBe(true);
    const done = answer(f, e.id, all('keep'));
    await sleepMs(40);
    expect(f.session.of('send:')).toEqual([]);
    f.session.closeTurn();
    await done;
    expect(f.read('a.ts')).toBe('agent version');
    expect(f.session.of('send:')).toHaveLength(1);
    expect(f.session.of('send:')[0]).toContain('Kept as you wrote them: a.ts, b.ts.');
    expect(f.session.of('send:')[0]).toContain('may be partial');
    expect(event(f, e.id)).toMatchObject({ phase: 'resolved', resolution: 'kept' });
    expect(event(f, e.id).resolvedAt).not.toBeNull();
    expect(f.changes.changes().filter((c) => c.path === 'a.ts' || c.path === 'b.ts').map((c) => c.resolution)).toEqual(['kept', 'kept']);
    expect(f.hold.isHeld()).toBe(false);
    expect(f.store.watchdogEvents('s1').find((x) => x.id === e.id)).toMatchObject({ phase: 'resolved', resolution: 'kept' });
    expect(f.emitted.at(-1)).toMatchObject({ id: e.id, phase: 'resolved' });
  });

  it('reverts the files to their content before the agent and reports it in the note', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts', 'b.ts']));
    await answer(f, e.id, all('revert'));
    expect(f.read('a.ts')).toBe('a');
    expect(f.read('b.ts')).toBe('b');
    expect(event(f, e.id).resolution).toBe('reverted');
    expect(f.session.of('note:')[0]).toContain('Restored to their earlier content: a.ts, b.ts.');
    expect(f.changes.changes().filter((c) => c.origin === 'agent-tool').map((c) => c.resolution)).toEqual(['reverted', 'reverted']);
  });

  it('leaves a file the user edited after the agent in place, and says so in the event and the note', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts', 'b.ts']));
    writeFileSync(join(f.root, 'a.ts'), 'the user typed this');
    await answer(f, e.id, all('revert'));
    expect(f.read('a.ts')).toBe('the user typed this');
    expect(f.read('b.ts')).toBe('b');
    expect(event(f, e.id).reason).toContain('a.ts');
    expect(event(f, e.id).resolution).toBe('mixed');
    expect(f.session.of('note:')[0]).toMatch(/Not restored: a\.ts \(/);
    expect(f.session.of('note:')[0]).toContain('Restored to their earlier content: b.ts.');
  });

  it('records kept, not reverted, when a revert restored nothing because every file conflicted', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts']));
    writeFileSync(join(f.root, 'a.ts'), 'the user typed this');
    await answer(f, e.id, all('revert'));
    expect(event(f, e.id).resolution).toBe('kept');
    expect(f.read('a.ts')).toBe('the user typed this');
    expect(f.changes.changes().find((c) => c.path === 'a.ts')?.resolution).toBe('kept');
    expect(f.session.of('note:')[0]).toContain('Not restored: a.ts');
  });

  it('answers per file, defaults the unlisted to keep and records a mixed event', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts', 'b.ts', 'src/c.ts']));
    await answer(f, e.id, { kind: 'files', files: { 'a.ts': 'revert' } });
    expect([f.read('a.ts'), f.read('b.ts'), f.read('src/c.ts')]).toEqual(['a', 'agent version', 'agent version']);
    expect(event(f, e.id).resolution).toBe('mixed');
    const byPath = Object.fromEntries(f.changes.changes().filter((c) => c.origin === 'agent-tool').map((c) => [c.path, c.resolution]));
    expect(byPath).toEqual({ 'a.ts': 'reverted', 'b.ts': 'kept', 'src/c.ts': 'kept' });
  });

  it('records the plain resolution when every file got the same answer', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts', 'b.ts']));
    await answer(f, e.id, { kind: 'files', files: { 'a.ts': 'revert', 'b.ts': 'revert' } });
    expect(event(f, e.id).resolution).toBe('reverted');
  });

  it('relabels my edit as human and does not touch the file', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('mine'));
    expect(f.read('a.ts')).toBe('agent version');
    expect(f.changes.changes().find((c) => c.path === 'a.ts')).toMatchObject({ origin: 'human', resolution: 'relabeled-human' });
    expect(event(f, e.id).resolution).toBe('relabeled-human');
    expect(f.session.of('note:')[0]).toContain('Edited by the user, not by you: a.ts.');
  });

  it('expands the plan with a delete op for a deleted file, and releases the hold so held calls are judged again', async () => {
    const f = await fixture({ plan: true });
    const deleted = await f.remove('a.ts');
    const created = (await f.produce(['src/new.ts']))[0]!;
    const e = await f.raise([deleted, created]);
    expect(e.canExpand).toBe(true);
    expect(f.hold.isHeld()).toBe(true);
    await answer(f, e.id, all('expand-plan'));
    const gate = f.plans.gate();
    expect(gate).toMatchObject({ state: 'approved', version: 2 });
    const steps = f.plans.plans().at(-1)!.steps;
    expect(steps[0]!.targets).toEqual(expect.arrayContaining([
      { path: 'src/app.ts', op: 'modify' }, { path: 'a.ts', op: 'delete' }, { path: 'src/new.ts', op: 'create' },
    ]));
    expect(existsSync(join(f.root, 'a.ts'))).toBe(false);
    expect(event(f, e.id).resolution).toBe('plan-expanded');
    expect(f.changes.changes().filter((c) => c.origin === 'agent-tool').map((c) => c.resolution)).toEqual(['plan-expanded', 'plan-expanded']);
    expect(f.session.of('note:')[0]).toContain('Added to the approved plan: a.ts, src/new.ts.');
    expect(f.hold.isHeld()).toBe(false);
  });

  it('expands a modified existing file with op modify', async () => {
    const f = await fixture({ plan: true });
    const e = await f.raise(await f.produce(['b.ts']));
    await answer(f, e.id, all('expand-plan'));
    expect(f.plans.plans().at(-1)!.steps[0]!.targets).toContainEqual({ path: 'b.ts', op: 'modify' });
  });
});

describe('Watchdog.answer refusals', () => {
  const gitEvent = (f: F): WatchdogEventView => {
    const change: ChangeView = {
      id: 'g1', path: '.git/HEAD', beforeHash: 'x', afterHash: 'y', beforeMode: 0o644, at: 1, origin: 'agent', enforcement: 'recorded', outOfPlan: false,
      toolUseIds: [], planId: null, planVersion: null, stepKey: null, eventId: null, resolution: null, added: null, removed: null, stored: true, unreadable: false,
    };
    f.watchdog.raiseUnknown([change]);
    const e = f.watchdog.events().at(-1)!;
    return e;
  };

  it('refuses a revert or mine answer for .git/HEAD and accepts keep', async () => {
    const f = await fixture();
    const e = gitEvent(f);
    await expect(answer(f, e.id, all('revert'))).rejects.toThrow(WatchdogError);
    await expect(answer(f, e.id, all('mine'))).rejects.toThrow(WatchdogError);
    await expect(answer(f, e.id, { kind: 'files', files: { '.git/HEAD': 'revert' } })).rejects.toThrow(WatchdogError);
    expect(event(f, e.id).phase).toBe('pending');
    await answer(f, e.id, { kind: 'files', files: { '.git/HEAD': 'keep' } });
    expect(event(f, e.id)).toMatchObject({ phase: 'resolved', resolution: 'kept' });
  });

  it('refuses expand-plan when the plan cannot expand, and leaves everything as it was', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts']));
    expect(e.canExpand).toBe(false);
    await expect(answer(f, e.id, all('expand-plan'))).rejects.toThrow(WatchdogError);
    expect(event(f, e.id).phase).toBe('pending');
    expect(f.hold.isHeld()).toBe(true);
    expect(f.session.of('note:')).toEqual([]);
  });

  it('refuses expand-plan as a per-file answer', async () => {
    const f = await fixture({ plan: true });
    const e = await f.raise(await f.produce(['a.ts']));
    await expect(answer(f, e.id, { kind: 'files', files: { 'a.ts': 'expand-plan' as FileAnswer } })).rejects.toThrow(WatchdogError);
    expect(event(f, e.id).phase).toBe('pending');
  });

  it('refuses a path that is not in the event, before changing anything', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts', 'b.ts']));
    await expect(answer(f, e.id, { kind: 'files', files: { 'a.ts': 'revert', 'nope.ts': 'revert' } })).rejects.toThrow(WatchdogError);
    expect(f.read('a.ts')).toBe('agent version');
    expect(event(f, e.id).phase).toBe('pending');
  });

  it('refuses an event that is unknown, still collecting or already resolved', async () => {
    const f = await fixture();
    await expect(answer(f, 'missing', all('keep'))).rejects.toThrow(WatchdogError);
    const [c] = await f.produce(['a.ts']);
    f.watchdog.consider(c!);
    const collecting = f.watchdog.events()[0]!;
    expect(collecting.phase).toBe('collecting');
    await expect(answer(f, collecting.id, all('keep'))).rejects.toThrow(WatchdogError);
    await waitFor(() => f.watchdog.events()[0]!.phase === 'pending', 'pending');
    await answer(f, collecting.id, all('keep'));
    await expect(answer(f, collecting.id, all('keep'))).rejects.toThrow(WatchdogError);
  });

  it('lets only one of two concurrent answers through', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    const first = answer(f, e.id, all('revert'));
    const second = answer(f, e.id, all('keep'));
    f.session.closeTurn();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(WatchdogError);
    expect(f.read('a.ts')).toBe('a');
    expect(event(f, e.id).resolution).toBe('reverted');
  });
});

describe('Watchdog.answer delivery', () => {
  it('releases the hold only after the note is sent', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    const done = answer(f, e.id, all('revert'));
    await sleepMs(40);
    expect(f.session.of('release')).toEqual([]);
    f.session.closeTurn();
    await done;
    const order = f.session.order;
    expect(order.map((entry) => entry.split(':')[0])).toEqual(['interrupt', 'send', 'release']);
    expect(f.hold.isHeld()).toBe(false);
  });

  it('queues the note when the process is gone, without waiting for a turn', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.alive = false;
    await answer(f, e.id, all('revert'));
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['interrupt', 'note', 'release']);
  });

  it('queues the note when the interrupted turn never closes', async () => {
    const f = await fixture({ turnOpen: true, deliverWaitMs: 60 });
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('keep'));
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['interrupt', 'note', 'release']);
  });

  it('sends the note at once when the interrupted turn had already closed', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.turnOpen = false;
    await answer(f, e.id, all('keep'));
    expect(f.session.of('send:')).toHaveLength(1);
  });

  it('absorbs the note while paused when something changed', async () => {
    const f = await fixture({ turnOpen: true, subagents: 2 });
    const e = await f.raise(await f.produce(['a.ts']));
    expect(e.paused).toBe(true);
    await answer(f, e.id, all('revert'));
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['absorbed', 'release']);
  });

  it('sends nothing when it only paused and everything was kept', async () => {
    const f = await fixture({ turnOpen: true, subagents: 2 });
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('keep'));
    expect(f.session.order).toEqual(['release']);
    expect(event(f, e.id).resolution).toBe('kept');
  });

  it('queues the note for the next message when nothing is running and something changed', async () => {
    const f = await fixture({ turnOpen: false });
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('revert'));
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['note', 'release']);
  });

  it('sends nothing when nothing was running and everything was kept', async () => {
    const f = await fixture({ turnOpen: false });
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('keep'));
    expect(f.session.order).toEqual(['release']);
  });

  it('still releases the hold when the note cannot be delivered, and records the error in the event', async () => {
    const f = await fixture({ turnOpen: false });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.throwing.add('queueNote');
    await answer(f, e.id, all('revert'));
    expect(f.hold.isHeld()).toBe(false);
    expect(f.session.of('release')).toHaveLength(1);
    expect(event(f, e.id)).toMatchObject({ phase: 'resolved', resolution: 'reverted' });
    expect(event(f, e.id).reason).toContain('queueNote exploded');
    expect(f.store.watchdogEvents('s1').find((x) => x.id === e.id)?.reason).toContain('queueNote exploded');
    expect(f.read('a.ts')).toBe('a');
  });

  it('queues the note when sending it fails, still records the error and releases the hold', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.throwing.add('send');
    const done = answer(f, e.id, all('revert'));
    f.session.closeTurn();
    await done;
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['interrupt', 'note', 'release']);
    expect(event(f, e.id).reason).toContain('send exploded');
    expect(f.hold.isHeld()).toBe(false);
  });

  it('queues the note when absorbing it fails', async () => {
    const f = await fixture({ turnOpen: true, subagents: 1 });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.throwing.add('sendAbsorbed');
    await answer(f, e.id, all('revert'));
    expect(f.session.order.map((entry) => entry.split(':')[0])).toEqual(['note', 'release']);
    expect(event(f, e.id).reason).toContain('sendAbsorbed exploded');
    expect(f.hold.isHeld()).toBe(false);
  });

  it('keeps the hold and the event open when the revert itself throws', async () => {
    const f = await fixture();
    const e = await f.raise(await f.produce(['a.ts']));
    (f.watchdog as unknown as { o: { reverts: { revertChanges: () => Promise<never> } } }).o.reverts = { revertChanges: () => Promise.reject(new Error('disk gone')) };
    await expect(answer(f, e.id, all('revert'))).rejects.toThrow('disk gone');
    expect(event(f, e.id).phase).toBe('pending');
    expect(f.hold.isHeld()).toBe(true);
    await answer(f, e.id, all('keep'));
    expect(event(f, e.id).phase).toBe('resolved');
  });
});

describe('Watchdog.stopAgent', () => {
  it('interrupts once, records it and leaves the event pending', async () => {
    const f = await fixture({ turnOpen: true, subagents: 1 });
    const e = await f.raise(await f.produce(['a.ts']));
    expect(e.interrupted).toBe(false);
    f.watchdog.stopAgent(e.id);
    f.watchdog.stopAgent(e.id);
    expect(f.session.of('interrupt')).toHaveLength(1);
    expect(event(f, e.id)).toMatchObject({ interrupted: true, phase: 'pending', resolution: 'pending' });
    expect(f.store.watchdogEvents('s1').find((x) => x.id === e.id)?.interrupted).toBe(true);
    expect(f.hold.isHeld()).toBe(true);
  });

  it('does not interrupt again an event that the watchdog already interrupted', async () => {
    const f = await fixture({ turnOpen: true });
    const e = await f.raise(await f.produce(['a.ts']));
    f.watchdog.stopAgent(e.id);
    expect(f.session.of('interrupt')).toHaveLength(1);
  });

  it('names the stopped subagents in the note afterwards, and waits for the turn', async () => {
    const f = await fixture({ turnOpen: true, subagents: 2 });
    const e = await f.raise(await f.produce(['a.ts']));
    f.watchdog.stopAgent(e.id);
    const done = answer(f, e.id, all('keep'));
    f.session.closeTurn();
    await done;
    expect(f.session.of('send:')[0]).toContain('their unfinished work is lost');
    expect(f.session.of('send:')[0]).toContain('subagent 0, subagent 1');
  });

  it('names the subagents that were running when the agent was stopped, not those that had ended by then', async () => {
    const f = await fixture({ turnOpen: true, subagents: 2 });
    const e = await f.raise(await f.produce(['a.ts']));
    f.session.names = ['subagent 1'];
    f.watchdog.stopAgent(e.id);
    const done = answer(f, e.id, all('keep'));
    f.session.closeTurn();
    await done;
    const note = f.session.of('send:')[0]!;
    expect(note).toContain('Stopped with it: subagent 1;');
    expect(note).not.toContain('subagent 0');
  });

  it('refuses an unknown or resolved event', async () => {
    const f = await fixture();
    expect(() => f.watchdog.stopAgent('missing')).toThrow(WatchdogError);
    const e = await f.raise(await f.produce(['a.ts']));
    await answer(f, e.id, all('keep'));
    expect(() => f.watchdog.stopAgent(e.id)).toThrow(WatchdogError);
  });
});
