import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangeView, ControlMode, FrozenScope, WatchdogEventView } from '@ide/protocol';
import { Hold } from '../../src/gate/hold';
import type { PlanGate } from '../../src/gate/scope-guard';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import { Watchdog, type WatchdogSession } from '../../src/watchdog/watchdog';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Bash', toolClass: 'shell', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});

class StubSession implements WatchdogSession {
  calls: string[] = [];
  turnOpen = true;
  subagents = 0;
  shell = false;
  last: string | null = 'I changed the files.';
  throwing = new Set<string>();
  private guard(name: string): void { if (this.throwing.has(name)) throw new Error(`${name} exploded`); }
  hasOpenTurn(): boolean { return this.turnOpen; }
  runningSubagents(): number { return this.subagents; }
  runningSubagentNames(): string[] { return Array.from({ length: this.subagents }, (_, i) => `subagent ${i}`); }
  runningShell(): boolean { return this.shell; }
  processAlive(): boolean { return true; }
  interrupt(): boolean { this.guard('interrupt'); this.calls.push('interrupt'); return true; }
  send(text: string): void { this.calls.push(`send:${text}`); }
  sendAbsorbed(text: string): void { this.calls.push(`absorbed:${text}`); }
  queueNote(text: string): void { this.calls.push(`note:${text}`); }
  lastMessage(): string | null { this.guard('lastMessage'); return this.last; }
  onTurnClosed(): () => boolean { return () => true; }
}

interface Setup { turnOpen?: boolean; subagents?: number; settleMs?: number; mode?: ControlMode; shadow?: (real: ShadowRepo) => ShadowRepo; storeFails?: boolean }

async function fixture(o: Setup = {}) {
  const root = tempDir('wd-root-');
  sh(root, 'init', '-q');
  await writeTree(root, { 'a.ts': 'a', 'b.ts': 'b', 'src/c.ts': 'c' });
  sh(root, 'add', '-A');
  const store = openStore(tempDir('wd-store-'));
  store.saveSession(sessionRecord('s1', root));
  const realShadow = await ShadowRepo.open(tempDir('wd-shadow-'));
  const shadow = o.shadow ? o.shadow(realShadow) : realShadow;
  const baselines = new Baselines(store);
  await scanTree(root, DEFAULT_POLICY, shadow, baselines);
  const ledger = new ActivityLedger();
  const gate: { value: PlanGate; throws?: boolean } = { value: { state: 'none' } };
  const changes = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites: new IdeWrites(), ledger, store, checkpoints: new Checkpoints(store, () => 's1'),
    sessionId: () => 's1', plans: { gate: () => gate.value },
  });
  const session = new StubSession();
  session.turnOpen = o.turnOpen ?? true;
  session.subagents = o.subagents ?? 0;
  const hold = new Hold();
  const withdrawn: string[] = [];
  const policy = { ...DEFAULT_POLICY, mode: o.mode ?? 'B' };
  const canExpand = { value: true };
  const saveFails = { value: o.storeFails ?? false };
  const realSave = store.saveWatchdogEvent.bind(store);
  store.saveWatchdogEvent = (sessionId, event) => {
    if (saveFails.value) throw new Error('disk full');
    realSave(sessionId, event);
  };
  let n = 0;
  const info = { throws: false };
  const watchdog = new Watchdog({
    store, sessionId: () => 's1', session, hold, shadow, root,
    plans: { gate: () => { if (gate.throws) throw new Error('gate exploded'); return gate.value; }, canExpand: () => canExpand.value, expand: () => { throw new Error('not here'); } } as never,
    changes, reverts: { revertChanges: () => { throw new Error('not here'); } },
    gate: { withdrawPending: (reason) => { withdrawn.push(reason); } }, policy: () => policy,
    toolInfo: (id) => (info.throws ? (() => { throw new Error('toolInfo exploded'); })() : id === 't1' ? { tool: 'Bash', summary: 'npm run gen', stepKey: null } : undefined),
    settleMs: o.settleMs ?? 50, newId: () => `ev${++n}`,
  });
  const emitted: WatchdogEventView[] = [];
  watchdog.onChange((e) => emitted.push(e));
  const produce = async (rels: string[], content = 'changed'): Promise<ChangeView[]> => {
    for (const rel of rels) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); }
    const now = Date.now();
    await Promise.all(rels.map((rel) => changes.handle({ rel, exists: true, at: now, wall: now })));
    return rels.map((rel) => changes.changes().findLast((c) => c.path === rel)!);
  };
  return { root, store, shadow, ledger, gate, changes, session, hold, withdrawn, watchdog, emitted, canExpand, saveFails, info, produce, toolCall: () => ledger.allowed(call({})) };
}

const approved = (scope: Partial<FrozenScope> = {}): PlanGate => ({ state: 'approved', planId: 'p1', version: 1, scope: { paths: [], globs: [], ...scope }, activeStep: 's1' });
const pendingEvent = (f: Awaited<ReturnType<typeof fixture>>): Promise<WatchdogEventView> =>
  waitFor(() => f.watchdog.events().find((e) => e.phase === 'pending'), 'a pending event');

describe('Watchdog raising', () => {
  it('holds new hook calls and interrupts for an out-of-plan agent-tool change', async () => {
    const f = await fixture({ turnOpen: true, subagents: 0 });
    f.toolCall();
    const [c] = await f.produce(['src/x.ts']);
    f.watchdog.consider(c!);
    expect(f.hold.isHeld()).toBe(true);
    expect(f.session.calls).toEqual(['interrupt']);
    expect(f.withdrawn).toHaveLength(1);
    expect(f.watchdog.events()[0]).toMatchObject({ phase: 'collecting', interrupted: true, paused: false, mode: 'B', kind: 'watchdog' });
    expect(f.watchdog.isPending()).toBe(true);
  });

  it('pauses without interrupting while an async subagent runs', async () => {
    const f = await fixture({ turnOpen: true, subagents: 2 });
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    expect(f.session.calls).toEqual([]);
    expect(f.hold.isHeld()).toBe(true);
    expect(f.watchdog.events()[0]).toMatchObject({ paused: true, interrupted: false, runningSubagents: 2 });
  });

  it('never interrupts when no turn is open', async () => {
    const f = await fixture({ turnOpen: false, subagents: 0 });
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    expect(f.session.calls).toEqual([]);
    expect(f.hold.isHeld()).toBe(true);
    expect(f.watchdog.events()[0]).toMatchObject({ interrupted: false, paused: false });
  });

  it('stores the decision on the change', async () => {
    const f = await fixture();
    f.toolCall();
    const [c] = await f.produce(['src/x.ts']);
    f.watchdog.consider(c!);
    expect(f.changes.changes().find((x) => x.id === c!.id)).toMatchObject({ outOfPlan: true, eventId: 'ev1' });
    expect(f.store.changes('s1').find((x) => x.id === c!.id)).toMatchObject({ outOfPlan: true, eventId: 'ev1' });
  });

  it('does not raise for an agent change, an in-scope change or a human change', async () => {
    const f = await fixture();
    f.gate.value = approved({ paths: ['src/in.ts'], globs: [] });
    f.ledger.allowed(call({ toolUseId: 'w', tool: 'Write', toolClass: 'file-writer', targets: ['a.ts'] }));
    const agent = (await f.produce(['a.ts']))[0]!;
    expect(agent.origin).toBe('agent');
    f.ledger.clear();
    const human = (await f.produce(['b.ts']))[0]!;
    expect(human.origin).toBe('human');
    f.toolCall();
    const inScope = (await f.produce(['src/in.ts']))[0]!;
    expect(inScope.origin).toBe('agent-tool');
    for (const c of [agent, human, inScope]) f.watchdog.consider(c);
    await sleepMs(120);
    expect(f.watchdog.events()).toEqual([]);
    expect(f.hold.isHeld()).toBe(false);
    expect(f.session.calls).toEqual([]);
  });

  it('raises a deleted file whose plan only modifies it', async () => {
    const f = await fixture();
    f.gate.value = approved({ paths: ['a.ts'], deletes: { paths: [], globs: [] } });
    f.toolCall();
    rmSync(join(f.root, 'a.ts'));
    const now = Date.now();
    await f.changes.handle({ rel: 'a.ts', exists: false, at: now, wall: now });
    const del = f.changes.changes().findLast((c) => c.path === 'a.ts')!;
    expect(del).toMatchObject({ afterHash: null, origin: 'agent-tool' });
    f.watchdog.consider(del);
    expect(f.watchdog.events()).toHaveLength(1);
  });

  it('does not raise a deleted file the plan deletes', async () => {
    const f = await fixture();
    f.gate.value = approved({ paths: [], deletes: { paths: ['a.ts'], globs: [] } });
    f.toolCall();
    rmSync(join(f.root, 'a.ts'));
    const now = Date.now();
    await f.changes.handle({ rel: 'a.ts', exists: false, at: now, wall: now });
    f.watchdog.consider(f.changes.changes().findLast((c) => c.path === 'a.ts')!);
    expect(f.watchdog.events()).toEqual([]);
  });

  it('raises when no plan is approved, the plan is done, or it was rejected', async () => {
    for (const gate of [{ state: 'none' }, { state: 'done', planId: 'p1' }, { state: 'rejected', planId: 'p1' }] as PlanGate[]) {
      const f = await fixture();
      f.gate.value = gate;
      f.toolCall();
      f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
      expect(f.watchdog.events(), gate.state).toHaveLength(1);
      expect(f.hold.isHeld()).toBe(true);
    }
  });

  it('raises an unreadable change the plan does not cover, and not one it covers', async () => {
    if (process.getuid?.() === 0) return;
    const f = await fixture();
    f.gate.value = approved({ paths: ['b.ts'] });
    f.toolCall();
    chmodSync(join(f.root, 'a.ts'), 0o000);
    chmodSync(join(f.root, 'b.ts'), 0o000);
    const now = Date.now();
    await Promise.all(['a.ts', 'b.ts'].map((rel) => f.changes.handle({ rel, exists: true, at: now, wall: now })));
    const [a, b] = ['a.ts', 'b.ts'].map((rel) => f.changes.changes().find((c) => c.path === rel)!);
    expect([a!.unreadable, b!.unreadable]).toEqual([true, true]);
    f.watchdog.consider(b!);
    expect(f.watchdog.events()).toEqual([]);
    f.watchdog.consider(a!);
    expect(f.watchdog.events()).toHaveLength(1);
    chmodSync(join(f.root, 'a.ts'), 0o644);
    chmodSync(join(f.root, 'b.ts'), 0o644);
  });

  it('flags in mode C without holding or interrupting', async () => {
    const f = await fixture({ mode: 'C' });
    f.toolCall();
    const [c] = await f.produce(['src/x.ts']);
    f.watchdog.consider(c!);
    expect(f.hold.isHeld()).toBe(false);
    expect(f.session.calls).toEqual([]);
    const [event] = f.watchdog.events();
    expect(event).toMatchObject({ mode: 'C', phase: 'resolved', resolution: 'flagged', interrupted: false });
    expect(event!.changes.map((x) => x.path)).toEqual(['src/x.ts']);
    expect(f.watchdog.isPending()).toBe(false);
    expect(f.changes.changes().find((x) => x.id === c!.id)).toMatchObject({ outOfPlan: true, resolution: 'flagged', eventId: event!.id });
    expect(f.store.watchdogEvents('s1')).toHaveLength(1);
  });

  it('records a change of .git/HEAD by the agent as a flagged event in every mode, without holding', async () => {
    for (const mode of ['A', 'B', 'C'] as ControlMode[]) {
      const f = await fixture({ mode });
      f.gate.value = approved({ globs: ['**'] });
      f.toolCall();
      sh(f.root, 'checkout', '-q', '-b', 'topic');
      const now = Date.now();
      await f.changes.handle({ rel: '.git/HEAD', exists: true, at: now, wall: now });
      const head = f.changes.changes().find((c) => c.path === '.git/HEAD')!;
      f.watchdog.consider(head);
      expect(f.hold.isHeld(), mode).toBe(false);
      expect(f.session.calls, mode).toEqual([]);
      expect(f.watchdog.events(), mode).toHaveLength(1);
      expect(f.watchdog.events()[0], mode).toMatchObject({ phase: 'resolved', resolution: 'flagged' });
    }
  });
});

describe('Watchdog collecting and settling', () => {
  it('joins changes 200 ms apart into one event and opens the dialog after the settle', async () => {
    const f = await fixture({ turnOpen: false, settleMs: 100 });
    f.toolCall();
    const [a, b] = await f.produce(['src/a.ts', 'src/b.ts']);
    f.watchdog.consider(a!);
    await sleepMs(60);
    f.watchdog.consider(b!);
    expect(f.watchdog.events()).toHaveLength(1);
    const event = await pendingEvent(f);
    expect(event.changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(event.snapshotSha).toMatch(/^[0-9a-f]{40}$/);
    expect(f.watchdog.events()).toHaveLength(1);
  });

  it('does not open the dialog before the settle window has passed without a new change', async () => {
    const f = await fixture({ settleMs: 150 });
    f.toolCall();
    const [a, b] = await f.produce(['src/a.ts', 'src/b.ts']);
    f.watchdog.consider(a!);
    await sleepMs(100);
    f.watchdog.consider(b!);
    await sleepMs(100);
    expect(f.watchdog.events()[0]!.phase).toBe('collecting');
    await pendingEvent(f);
  });

  it('fills the pending event: persisted, emitted, tool calls, reason, expand, default action', async () => {
    const f = await fixture({ mode: 'A' });
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    const event = await pendingEvent(f);
    expect(event).toMatchObject({
      phase: 'pending', resolution: 'pending', defaultAction: 'revert', canExpand: true, reason: 'I changed the files.', backgroundShell: false, unknownOrigin: false,
      toolCalls: [{ toolUseId: 't1', tool: 'Bash', summary: 'npm run gen', stepKey: null }], resolvedAt: null,
    });
    expect(f.store.watchdogEvents('s1')).toEqual([event]);
    expect(f.emitted.at(-1)).toEqual(event);
    expect(f.hold.isHeld()).toBe(true);
  });

  it('has no default action in mode B and cannot expand when the plan cannot', async () => {
    const f = await fixture({ mode: 'B' });
    f.canExpand.value = false;
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    expect(await pendingEvent(f)).toMatchObject({ defaultAction: null, canExpand: false });
  });

  it('cannot expand an event with a path outside the project', async () => {
    const f = await fixture();
    f.toolCall();
    const [c] = await f.produce(['src/x.ts']);
    f.watchdog.consider({ ...c!, id: 'outside-1', path: '../outside.ts' });
    expect((await pendingEvent(f)).canExpand).toBe(false);
  });

  it('reports a running background shell', async () => {
    const f = await fixture();
    f.session.shell = true;
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    expect((await pendingEvent(f)).backgroundShell).toBe(true);
  });

  it('opens the dialog even when the snapshot fails', async () => {
    const f = await fixture({
      shadow: (real) => new Proxy(real, {
        get(target, key) {
          if (key === 'snapshot') return async () => { throw new Error('git exploded'); };
          const v = Reflect.get(target, key, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    const event = await pendingEvent(f);
    expect(event.snapshotSha).toBeNull();
    expect(event.reason).toContain('git exploded');
    expect(event.reason).toContain('snapshot');
    expect(f.hold.isHeld()).toBe(true);
  });

  it('keeps the hold and reports when persisting the event fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = await fixture({ storeFails: true });
      f.toolCall();
      f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
      expect(f.hold.isHeld()).toBe(true);
      const event = await pendingEvent(f);
      expect(f.hold.isHeld()).toBe(true);
      expect(f.emitted.at(-1)).toEqual(event);
      expect(error).toHaveBeenCalled();
      expect(f.store.watchdogEvents('s1')).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('makes one event and one snapshot from a 300-change batch', async () => {
    const snapshots: string[] = [];
    const f = await fixture({
      settleMs: 100,
      shadow: (real) => new Proxy(real, {
        get(target, key) {
          if (key === 'snapshot') return (id: string, files: unknown[]) => { snapshots.push(`${id}:${files.length}`); return target.snapshot(id, files as never); };
          const v = Reflect.get(target, key, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });
    f.toolCall();
    const made = await f.produce(Array.from({ length: 300 }, (_, i) => `gen/f${i}.ts`));
    for (const c of made) f.watchdog.consider(c);
    const event = await pendingEvent(f);
    expect(f.watchdog.events()).toHaveLength(1);
    expect(event.changes).toHaveLength(300);
    expect(snapshots).toEqual(['ev1:300']);
    expect(f.session.calls).toEqual(['interrupt']);
    expect(f.withdrawn).toHaveLength(1);
  });

  it('joins a change that arrives while the event is pending and updates the emitted view', async () => {
    const f = await fixture();
    f.toolCall();
    const [a, b] = await f.produce(['src/a.ts', 'src/b.ts']);
    f.watchdog.consider(a!);
    await pendingEvent(f);
    f.watchdog.consider(b!);
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.watchdog.events()[0]!.changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(f.watchdog.events()[0]!.phase).toBe('pending');
    expect(f.emitted.at(-1)!.changes).toHaveLength(2);
    expect(f.store.watchdogEvents('s1')[0]!.changes).toHaveLength(2);
    expect(f.session.calls).toEqual(['interrupt']);
  });

  it('ignores a change that is already in the event', async () => {
    const f = await fixture();
    f.toolCall();
    const [a] = await f.produce(['src/a.ts']);
    f.watchdog.consider(a!);
    f.watchdog.consider(a!);
    const event = await pendingEvent(f);
    expect(event.changes).toHaveLength(1);
  });

  it('notifies onChange listeners and lets them unsubscribe', async () => {
    const f = await fixture();
    const extra: string[] = [];
    const off = f.watchdog.onChange((e) => extra.push(e.phase));
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/a.ts']))[0]!);
    await pendingEvent(f);
    off();
    expect(extra).toEqual(['collecting', 'pending']);
  });

  it('puts a flagged mode C burst into one event', async () => {
    const f = await fixture({ mode: 'C' });
    f.toolCall();
    for (const c of await f.produce(['src/a.ts', 'src/b.ts', 'src/c2.ts'])) f.watchdog.consider(c);
    expect(f.watchdog.events()).toHaveLength(1);
    expect(f.watchdog.events()[0]!.changes).toHaveLength(3);
    expect(f.store.watchdogEvents('s1')[0]!.changes).toHaveLength(3);
  });
});

describe('Watchdog failing soft and closed', () => {
  it('still opens the dialog when filling the view throws', async () => {
    const f = await fixture();
    f.info.throws = true;
    f.session.throwing.add('lastMessage');
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
    const event = await pendingEvent(f);
    expect(event.reason).toContain('toolInfo exploded');
    expect(event.reason).toContain('lastMessage exploded');
    expect(f.hold.isHeld()).toBe(true);
    expect(f.store.watchdogEvents('s1')).toEqual([event]);
  });

  it('still opens the dialog when the interrupt throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = await fixture();
      f.session.throwing.add('interrupt');
      f.toolCall();
      f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
      const event = await pendingEvent(f);
      expect(event).toMatchObject({ interrupted: false, phase: 'pending' });
      expect(event.reason).toContain('interrupt exploded');
      expect(f.hold.isHeld()).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it('still opens the dialog, with the change in it, when storing the decision throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = await fixture();
      f.changes.markOutOfPlan = () => { throw new Error('mark exploded'); };
      f.toolCall();
      f.watchdog.consider((await f.produce(['src/x.ts']))[0]!);
      const event = await pendingEvent(f);
      expect(event.changes.map((c) => c.path)).toEqual(['src/x.ts']);
      expect(event.reason).toContain('mark exploded');
      expect(f.hold.isHeld()).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it('holds and asks when the plan cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = await fixture();
      f.toolCall();
      const [c] = await f.produce(['src/x.ts']);
      f.gate.throws = true;
      f.watchdog.consider(c!);
      expect(f.hold.isHeld()).toBe(true);
      expect((await pendingEvent(f)).reason).toContain('gate exploded');
    } finally {
      error.mockRestore();
    }
  });

  it('runs overlapping settles one after the other and keeps the last snapshot', async () => {
    const log: string[] = [];
    const shas: string[] = [];
    let first = true;
    const f = await fixture({
      settleMs: 30,
      shadow: (real) => new Proxy(real, {
        get(target, key) {
          if (key === 'snapshot') {
            return async (id: string, files: unknown[]) => {
              const n = files.length;
              log.push(`start${n}`);
              if (first) { first = false; await sleepMs(200); }
              const sha = await target.snapshot(id, files as never);
              shas.push(sha);
              log.push(`end${n}`);
              return sha;
            };
          }
          const v = Reflect.get(target, key, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });
    f.toolCall();
    const [a, b] = await f.produce(['src/a.ts', 'src/b.ts']);
    f.watchdog.consider(a!);
    await waitFor(() => log.includes('start1'), 'the first snapshot');
    f.watchdog.consider(b!);
    await waitFor(() => log.length === 4, 'both snapshots');
    await sleepMs(20);
    expect(log).toEqual(['start1', 'end1', 'start2', 'end2']);
    const [event] = f.watchdog.events();
    expect(event!.snapshotSha).toBe(shas[1]);
    expect(event!.changes).toHaveLength(2);
  });

  it('does not flip a closed event back when a settle timer or snapshot finishes after it', async () => {
    let release: () => void = () => undefined;
    const gateOpen = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({
      settleMs: 30,
      shadow: (real) => new Proxy(real, {
        get(target, key) {
          if (key === 'snapshot') return async (id: string, files: unknown[]) => { await gateOpen; return target.snapshot(id, files as never); };
          const v = Reflect.get(target, key, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });
    f.toolCall();
    const [a, b] = await f.produce(['src/a.ts', 'src/b.ts']);
    f.watchdog.consider(a!);
    await sleepMs(60);
    f.watchdog.close('ev1', 'kept');
    release();
    await sleepMs(80);
    expect(f.watchdog.events()[0]).toMatchObject({ phase: 'resolved', resolution: 'kept' });
    expect(f.watchdog.isPending()).toBe(false);
    f.watchdog.consider(b!);
    expect(f.watchdog.events()).toHaveLength(2);
    expect(f.watchdog.events()[1]!.id).toBe('ev2');
  });

  it('cancels the settle timer of a closed event', async () => {
    const f = await fixture({ settleMs: 40 });
    f.toolCall();
    f.watchdog.consider((await f.produce(['src/a.ts']))[0]!);
    f.watchdog.close('ev1', 'dropped');
    await sleepMs(120);
    expect(f.watchdog.events()[0]).toMatchObject({ phase: 'resolved', snapshotSha: null });
    expect(f.store.watchdogEvents('s1')[0]).toMatchObject({ phase: 'resolved' });
  });

  it('judges a new unreadable file by the write scope, not as a deletion', async () => {
    if (process.getuid?.() === 0) return;
    const f = await fixture();
    f.gate.value = approved({ paths: ['src/n.ts'], deletes: { paths: [], globs: [] } });
    f.toolCall();
    writeFileSync(join(f.root, 'src/n.ts'), 'x');
    writeFileSync(join(f.root, 'src/m.ts'), 'x');
    chmodSync(join(f.root, 'src/n.ts'), 0o000);
    chmodSync(join(f.root, 'src/m.ts'), 0o000);
    const now = Date.now();
    await Promise.all(['src/n.ts', 'src/m.ts'].map((rel) => f.changes.handle({ rel, exists: true, at: now, wall: now })));
    const [n, m] = ['src/n.ts', 'src/m.ts'].map((rel) => f.changes.changes().find((c) => c.path === rel)!);
    expect(n).toMatchObject({ unreadable: true, afterHash: null });
    f.watchdog.consider(n!);
    expect(f.watchdog.events()).toEqual([]);
    f.watchdog.consider(m!);
    expect(f.watchdog.events()).toHaveLength(1);
    chmodSync(join(f.root, 'src/n.ts'), 0o644);
    chmodSync(join(f.root, 'src/m.ts'), 0o644);
  });
});

describe('Watchdog.raiseFailOpen', () => {
  it('opens a fail-open event with a hold for an out-of-plan enforced change', async () => {
    const f = await fixture();
    f.toolCall();
    const changes = await f.produce(['src/x.ts']);
    f.watchdog.raiseFailOpen('t1', changes);
    expect(f.hold.isHeld()).toBe(true);
    expect(f.session.calls).toEqual(['interrupt']);
    expect(f.withdrawn).toHaveLength(1);
    expect(f.watchdog.events()[0]).toMatchObject({ kind: 'fail-open', phase: 'collecting', interrupted: true });
    const pending = await pendingEvent(f);
    expect(pending).toMatchObject({ kind: 'fail-open', changes: [{ path: 'src/x.ts', outOfPlan: true }] });
    expect(pending.reason).toContain('t1');
  });

  it('only flags a fail-open whose changes are all inside the plan, with no hold', async () => {
    const f = await fixture();
    f.gate.value = approved({ paths: ['src/in.ts'] });
    f.toolCall();
    f.watchdog.raiseFailOpen('t1', await f.produce(['src/in.ts']));
    expect(f.hold.isHeld()).toBe(false);
    expect(f.session.calls).toEqual([]);
    expect(f.watchdog.events()).toMatchObject([{ kind: 'fail-open', phase: 'resolved', resolution: 'flagged', changes: [{ path: 'src/in.ts' }] }]);
    expect(f.watchdog.isPending()).toBe(false);
  });

  it('flags a fail-open that changed nothing', async () => {
    const f = await fixture();
    f.watchdog.raiseFailOpen('t1', []);
    expect(f.watchdog.events()).toMatchObject([{ kind: 'fail-open', phase: 'resolved', resolution: 'flagged', changes: [] }]);
    expect(f.hold.isHeld()).toBe(false);
  });

  it('joins an event that is already open and only flags in mode C', async () => {
    const f = await fixture();
    f.toolCall();
    const [a, b] = await f.produce(['src/x.ts', 'src/y.ts']);
    f.watchdog.consider(a!);
    f.watchdog.raiseFailOpen('t1', [b!]);
    expect(f.watchdog.events()).toHaveLength(1);
    expect((await pendingEvent(f)).changes.map((c) => c.path).sort()).toEqual(['src/x.ts', 'src/y.ts']);
    const c = await fixture({ mode: 'C' });
    c.toolCall();
    c.watchdog.raiseFailOpen('t1', await c.produce(['src/x.ts']));
    expect(c.hold.isHeld()).toBe(false);
    expect(c.watchdog.events()).toMatchObject([{ kind: 'fail-open', phase: 'resolved', resolution: 'flagged' }]);
  });
});
