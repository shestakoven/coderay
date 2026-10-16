import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChangeView, ControlMode } from '@ide/protocol';
import type { ToolEndInfo } from '../../src/agent/tracker';
import { FailOpenDetector, NO_HOOK_TOOLS } from '../../src/gate/failopen';
import { Hold } from '../../src/gate/hold';
import { HookGate } from '../../src/gate/hook-gate';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { ShadowRepo } from '../../src/history/shadow';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore, type ToolDecisionRecord } from '../../src/store/store';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import { Watchdog, type WatchdogSession } from '../../src/watchdog/watchdog';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const components: ComponentRef[] = [{ id: 'app', name: 'App', files: ['src/app.ts'], globs: [] }];
const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Bash', toolClass: 'shell', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});
const end = (o: Partial<ToolEndInfo>): ToolEndInfo => ({
  toolUseId: 'mcp1', tool: 'mcp__x__write', parentToolUseId: null, status: 'ok', toolUseAt: performance.now() - 50, endedAt: performance.now(), ...o,
});

class StubSession implements WatchdogSession {
  hasOpenTurn(): boolean { return true; }
  runningSubagents(): number { return 0; }
  runningSubagentNames(): string[] { return []; }
  runningShell(): boolean { return false; }
  processAlive(): boolean { return true; }
  interrupt(): boolean { return true; }
  send(): void {}
  sendAbsorbed(): void {}
  queueNote(): void {}
  lastMessage(): string | null { return null; }
  onTurnClosed(): () => boolean { return () => true; }
}

async function fixture(o: { mode?: ControlMode; detector?: Partial<ConstructorParameters<typeof FailOpenDetector>[0]> } = {}) {
  const root = tempDir('fo-root-');
  sh(root, 'init', '-q');
  await writeTree(root, { 'a.ts': 'a', 'src/app.ts': 'app' });
  sh(root, 'add', '-A');
  const store = openStore(tempDir('fo-store-'));
  store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(tempDir('fo-shadow-'));
  const baselines = new Baselines(store);
  await scanTree(root, DEFAULT_POLICY, shadow, baselines);
  const policy = { ...DEFAULT_POLICY, mode: o.mode ?? 'B' };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home: tempDir('fo-home-'), tempRoots: [] }),
  });
  const ledger = new ActivityLedger();
  const changes = new ChangeService({
    root, policy, shadow, baselines, ideWrites: new IdeWrites(), ledger, store, checkpoints: new Checkpoints(store, () => 's1'),
    sessionId: () => 's1', plans,
  });
  const hold = new Hold();
  const gate = new HookGate({
    root, store, sessionId: () => 's1', policy: () => policy, plans, components: () => components,
    context: () => ({ parentToolUseId: null, lastMessage: null }), home: tempDir('fo-home-'), tempRoots: [], hold,
  });
  let n = 0;
  const watchdog = new Watchdog({
    store, sessionId: () => 's1', session: new StubSession(), hold, shadow, root, plans, changes,
    reverts: { revertChanges: () => { throw new Error('not here'); } }, gate, policy: () => policy,
    toolInfo: () => undefined, settleMs: 50, newId: () => `ev${++n}`,
  });
  onTestFinished(async () => { await watchdog.quiesce(); await changes.idle(); });
  const decisions: ToolDecisionRecord[] = [];
  gate.onDecision((r) => decisions.push(r));
  const detector = new FailOpenDetector({ gate, ledger, changes, watchdog, record: (r) => decisions.push(r), ...o.detector });
  const feed = async (rel: string, at = performance.now()): Promise<ChangeView> => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'agent');
    await changes.handle({ rel, exists: true, at, wall: Date.now() });
    return changes.changes().findLast((c) => c.path === rel)!;
  };
  return { root, store, plans, ledger, changes, hold, gate, watchdog, detector, decisions, feed };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const approve = async (f: Fixture): Promise<void> => {
  await f.plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
  f.plans.step({ key: 'edit', phase: 'start' });
};
const hookCall = (f: Fixture, tool: string, input: object, id: string, signal = new AbortController().signal) =>
  f.gate.evaluate({ tool_name: tool, tool_input: input, tool_use_id: id, cwd: f.root }, signal);

describe('FailOpenDetector', () => {
  it('records hook-missing for an ok result whose hook call never came, and raises a fail-open event for its out-of-plan file', async () => {
    const f = await fixture();
    const at = performance.now();
    await f.feed('src/x.ts', at);
    expect(f.changes.changes()[0]!.origin).toBe('human');
    f.detector.toolEnded(end({ toolUseId: 'mcp1', toolUseAt: at - 10, endedAt: at + 10 }));
    await waitFor(() => f.watchdog.events()[0], 'event');
    expect(f.decisions).toEqual([expect.objectContaining({ toolUseId: 'mcp1', decision: 'hook-missing', planId: null, reason: 'the hook did not run for this call' })]);
    expect(f.watchdog.events()[0]).toMatchObject({ kind: 'fail-open' });
    expect(f.hold.isHeld()).toBe(true);
    expect(f.changes.changes()[0]).toMatchObject({ origin: 'agent-tool', toolUseIds: ['mcp1'], outOfPlan: true });
  });

  it('checks CodeRay own tools like any other', async () => {
    const f = await fixture();
    f.detector.toolEnded(end({ toolUseId: 'ide1', tool: 'mcp__idecore__propose_plan' }));
    expect(f.decisions).toMatchObject([{ toolUseId: 'ide1', decision: 'hook-missing' }]);
  });

  it('drops a pending prompt and keeps hook-pending as the final decision, although the gate settles the prompt afterwards', async () => {
    const f = await fixture();
    await approve(f);
    const answer = hookCall(f, 'Edit', { file_path: join(f.root, 'a.ts'), old_string: 'a', new_string: 'b' }, 'edit1');
    await waitFor(() => f.gate.pending()[0], 'prompt');
    f.detector.toolEnded(end({ toolUseId: 'edit1', tool: 'Edit' }));
    expect(f.gate.pending()).toEqual([]);
    expect((await answer)?.permissionDecision).toBe('deny');
    await sleepMs(30);
    expect(f.decisions.filter((d) => d.toolUseId === 'edit1').at(-1)).toMatchObject({ decision: 'hook-pending' });
    expect(f.decisions.filter((d) => d.toolUseId === 'edit1')).toHaveLength(1);
  });

  it.each(['error', 'rejected', 'unfinished'] as const)('ignores a %s result', async (status) => {
    const f = await fixture();
    await f.feed('src/x.ts');
    f.detector.toolEnded(end({ status }));
    await sleepMs(80);
    expect(f.decisions).toEqual([]);
    expect(f.watchdog.events()).toEqual([]);
  });

  it('ignores a result for a call the hook decided', async () => {
    const f = await fixture();
    await hookCall(f, 'Read', {}, 'r1');
    f.detector.toolEnded(end({ toolUseId: 'r1', tool: 'Read' }));
    expect(f.decisions.map((d) => [d.toolUseId, d.decision === 'hook-missing' || d.decision === 'hook-pending'])).toEqual([['r1', false]]);
  });

  it('records the decision and only flags, with no second pending event, a call that ended while a watchdog event was pending and changed nothing', async () => {
    const f = await fixture();
    const change = await f.feed('src/x.ts');
    f.watchdog.raiseFailOpen('other', [change]);
    const old = { toolUseAt: 1e9, endedAt: 1e9 + 1 };
    f.detector.toolEnded(end(old));
    f.detector.toolEnded(end(old));
    await waitFor(() => f.watchdog.events().length === 2, 'the flagged event');
    expect(f.decisions).toMatchObject([{ toolUseId: 'mcp1', decision: 'hook-missing' }]);
    expect(f.watchdog.events().map((event) => event.phase === 'resolved')).toEqual([false, true]);
  });

  it('exempts the tools it is told about, and the built-in set is empty', async () => {
    expect([...NO_HOOK_TOOLS]).toEqual([]);
    const f = await fixture({ detector: { exempt: new Set(['mcp__x__write']) } });
    f.detector.toolEnded(end({}));
    expect(f.decisions).toEqual([]);
    const g = await fixture();
    g.detector.toolEnded(end({}));
    expect(g.decisions).toHaveLength(1);
  });

  it('only flags a fail-open that changed no enforced file, without a hold', async () => {
    const f = await fixture();
    f.detector.toolEnded(end({}));
    await waitFor(() => f.watchdog.events()[0], 'event');
    expect(f.watchdog.events()[0]).toMatchObject({ kind: 'fail-open', phase: 'resolved', resolution: 'flagged', changes: [] });
    expect(f.hold.isHeld()).toBe(false);
  });

  it('re-attributes over the ledger window of the call, not its tool_use time', async () => {
    const f = await fixture();
    const change = await f.feed('src/x.ts', 1_000_000);
    expect(change.origin).toBe('human');
    vi.spyOn(f.ledger, 'windowOf').mockReturnValue({ from: 999_000, to: null });
    const spy = vi.spyOn(f.changes, 'reattribute');
    f.detector.toolEnded(end({ toolUseAt: 5, endedAt: 1_000_100 }));
    await waitFor(() => f.watchdog.events()[0], 'event');
    expect(spy).toHaveBeenCalledWith('mcp1', 999_000, 1_000_100);
    expect(f.changes.changes()[0]!.origin).toBe('agent-tool');
  });

  it('does not report the same call twice', async () => {
    const f = await fixture();
    f.detector.toolEnded(end({}));
    f.detector.toolEnded(end({}));
    await waitFor(() => f.watchdog.events().length > 0, 'the event');
    expect(f.decisions).toHaveLength(1);
    expect(f.watchdog.events()).toHaveLength(1);
  });

  it('fails closed when re-attribution fails: the window human changes are judged as the call own and hold the agent', async () => {
    const f = await fixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const at = performance.now();
    await f.feed('src/x.ts', at);
    vi.spyOn(f.store, 'saveChanges').mockImplementationOnce(() => { throw new Error('disk full'); });
    f.detector.toolEnded(end({ toolUseAt: at - 10, endedAt: at + 10 }));
    await waitFor(() => f.watchdog.events()[0], 'event');
    expect(f.changes.changes()[0]!.origin).toBe('human');
    expect(f.watchdog.events()[0]).toMatchObject({ kind: 'fail-open', changes: [{ path: 'src/x.ts' }] });
    expect(f.watchdog.events()[0]!.phase).not.toBe('resolved');
    expect(f.hold.isHeld()).toBe(true);
    const pending = await waitFor(() => f.watchdog.events().find((e) => e.phase === 'pending'), 'pending');
    expect(pending.reason).toContain('disk full');
    expect(f.decisions).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('records only the decision when re-attribution fails and nothing is linked', async () => {
    const f = await fixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(f.changes, 'reattribute').mockRejectedValue(new Error('disk full'));
    f.detector.toolEnded(end({}));
    await waitFor(() => f.watchdog.events()[0], 'event');
    expect(f.watchdog.events()[0]).toMatchObject({ phase: 'resolved', changes: [] });
    expect(f.decisions).toHaveLength(1);
    error.mockRestore();
  });
});
