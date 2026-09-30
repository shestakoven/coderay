import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ControlMode, PlanTarget } from '@ide/protocol';
import { GateError, HookGate, type GateContext } from '../../src/gate/hook-gate';
import { Hold } from '../../src/gate/hold';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import { hookRoute } from '../../src/gate/hook-route';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer } from '../../src/server/server';
import { openStore, type ToolDecisionRecord } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

vi.mock('../../src/gate/paths', async (original) => {
  const actual = await original<typeof import('../../src/gate/paths')>();
  return {
    ...actual,
    classifyPaths: async (...args: Parameters<typeof actual.classifyPaths>) => {
      if (args[0].some((path) => path.includes('slow-judge'))) await new Promise((resolve) => setTimeout(resolve, 120));
      return actual.classifyPaths(...args);
    },
  };
});

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

interface Options {
  mode?: ControlMode;
  holdMs?: number;
  context?: GateContext;
  throwPolicy?: boolean;
  hold?: Hold;
  onPolicy?: () => void;
}

async function setup(options: Options = {}) {
  const root = tempDir('ide-hook-gate-');
  await writeTree(root, { 'src/app.ts': 'a', 'src/other.ts': 'b', 'src/lib/util.ts': 'c', '.gitignore': 'dist/\n.env\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = tempDir('ide-fake-home-');
  const store = openStore(tempDir('ide-store-'));
  onTestFinished(() => store.close());
  store.saveSession(sessionRecord('s1', root));
  const policy = { ...DEFAULT_POLICY, mode: options.mode ?? 'B' };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home, tempRoots: [] }),
  });
  const gate = new HookGate({
    root, store, sessionId: () => 's1',
    policy: () => {
      options.onPolicy?.();
      if (options.throwPolicy) throw new Error('boom: policy() failed');
      return policy;
    },
    plans, components: () => components,
    context: () => options.context ?? { parentToolUseId: null, lastMessage: 'Fixing the greeting.' },
    home, tempRoots: [], holdMs: options.holdMs, hold: options.hold,
  });
  const decisions: ToolDecisionRecord[] = [];
  gate.onDecision((decision) => decisions.push(decision));
  const call = (tool: string, input: object, signal = new AbortController().signal, id = 'toolu_1', cwd = root) =>
    gate.evaluate({ tool_name: tool, tool_input: input, tool_use_id: id, cwd }, signal);
  const approve = async (targets: PlanTarget[] = [{ path: 'src/app.ts', op: 'modify' }]) => {
    await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets }] });
    plans.step({ key: 'edit', phase: 'start' });
  };
  const pending = () => waitFor(() => gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt shown');
  return { root, home, store, plans, gate, decisions, call, approve, pending };
}

describe('HookGate', () => {
  it('denies a Write before any plan and tells the agent to call propose_plan', async () => {
    const { root, call, decisions } = await setup();
    const answer = await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' });
    expect(answer?.permissionDecision).toBe('deny');
    expect(answer?.permissionDecisionReason).toMatch(/^IDE: no approved plan covers src\/app\.ts\. Call mcp__idecore__propose_plan/);
    expect(decisions.map((decision) => [decision.decision, decision.targets])).toEqual([['deny', ['src/app.ts']]]);
  });

  it("lets reads, subagents, configured MCP tools and the IDE's own tools through without a plan", async () => {
    const { call } = await setup();
    const answers = await Promise.all(['Read', 'Agent', 'mcp__docs__search', 'mcp__idecore__propose_plan'].map((tool) => call(tool, {})));
    expect(answers.map((answer) => answer?.permissionDecision)).toEqual(['allow', 'allow', 'allow', 'allow']);
  });

  it('runs a shell command that writes no project file without a plan, and blocks one that does', async () => {
    const { call } = await setup();
    expect((await call('Bash', { command: 'npm test && ls -la' }))?.permissionDecision).toBe('allow');
    expect((await call('Bash', { command: 'echo x > src/new.ts' }))?.permissionDecision).toBe('deny');
  });

  it("lets writes to gitignored files and to Claude Code's plan files through without a plan", async () => {
    const { root, home, call } = await setup();
    expect((await call('Write', { file_path: join(root, 'dist/app.js') }))?.permissionDecision).toBe('allow');
    expect((await call('Write', { file_path: join(home, '.claude/plans/plan.md') }))?.permissionDecision).toBe('allow');
  });

  it('answers allow for AskUserQuestion and ExitPlanMode, which claude still puts to the IDE as its own prompts', async () => {
    const { call, gate } = await setup();
    const answers = await Promise.all(['AskUserQuestion', 'ExitPlanMode'].map((tool, index) => call(tool, {}, undefined, `toolu_${index}`)));
    expect([answers.map((answer) => answer?.permissionDecision), gate.pending()]).toEqual([['allow', 'allow'], []]);
  });

  it('blocks a guarded file even when it is gitignored', async () => {
    const { root, call } = await setup();
    expect((await call('Write', { file_path: join(root, '.env') }))?.permissionDecision).toBe('deny');
  });

  it('allows an in-scope write and records the plan and the step on the decision', async () => {
    const { root, call, approve, decisions } = await setup();
    await approve();
    expect((await call('Edit', { file_path: join(root, 'src/app.ts'), old_string: 'a', new_string: 'b' }))?.permissionDecision).toBe('allow');
    expect(decisions.at(-1)).toMatchObject({ decision: 'allow', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'] });
  });

  it('asks before rm of a modify target and expands the plan with a delete', async () => {
    const { root, call, approve, pending, gate, plans } = await setup();
    await approve();
    const answer = call('Bash', { command: 'rm src/app.ts' });
    const prompt = await pending();
    expect(prompt.targets).toMatchObject([{ path: 'src/app.ts', inScope: false, deleting: true }]);
    gate.answer(prompt.id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(plans.gate()).toMatchObject({ scope: { deletes: { paths: ['src/app.ts'] } } });
    expect((await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' }))?.permissionDecision).toBe('allow');
  });

  it("asks the user about an out-of-scope write in mode B, with the agent's reason, and lets it through once", async () => {
    const { root, call, approve, pending, gate, decisions, store } = await setup();
    await approve();
    const answer = call('Edit', { file_path: join(root, 'src/other.ts'), old_string: 'b', new_string: 'c' });
    const prompt = await pending();
    expect(prompt).toMatchObject({
      tool: 'Edit', reason: 'Fixing the greeting.', canExpand: true, mode: 'B',
      preview: { kind: 'edit', oldString: 'b', newString: 'c', truncated: false },
      targets: [{ path: 'src/other.ts', kind: 'enforced', inScope: false, componentId: 'app' }],
    });
    gate.answer(prompt.id, 'allow-once');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect([decisions.at(-1)?.decision, store.gateEvents('s1').map((event) => event.resolution)]).toEqual(['ask-approved', ['allowed-once']]);
  });

  it('denies the out-of-scope write when the user says no', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    gate.answer((await pending()).id, 'deny');
    expect((await answer)?.permissionDecisionReason).toBe("IDE: the user denied this call (src/other.ts). Stop and wait for the user's next message.");
  });

  it('expands the plan from the prompt and then allows the call under the new version', async () => {
    const { root, call, approve, pending, gate, plans } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    gate.answer((await pending()).id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(plans.gate()).toMatchObject({ version: 2, scope: { paths: ['src/app.ts', 'src/other.ts'] } });
  });

  it('drops the Expand plan offer of a pending prompt when the plan changes', async () => {
    const { root, call, approve, pending, gate, plans } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    expect((await pending()).canExpand).toBe(true);
    let notified = 0;
    gate.onChange(() => notified++);
    void plans.propose({ goal: 'Again', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: ['src/app.ts', 'src/other.ts', 'src/lib/util.ts', 'src/lib/more.ts'].map((path) => ({ path, op: 'modify' as const })) }] });
    await waitFor(() => (gate.pending()[0]?.canExpand === false ? true : undefined), 'offer dropped');
    expect(notified).toBeGreaterThan(0);
    await expect(async () => gate.answer(gate.pending()[0]!.id, 'expand-plan')).rejects.toThrow(GateError);
    gate.answer(gate.pending()[0]!.id, 'deny');
    expect((await answer)?.permissionDecision).toBe('deny');
  });

  describe('when the expansion leaves a file out of scope', () => {
    const twoFiles = { command: 'touch src/other.ts src/lib/util.ts' };

    async function limitedExpansion(mode: ControlMode) {
      const base = await setup({ mode });
      await base.approve();
      let current = mode;
      const gate = new HookGate({
        root: base.root, store: base.store, sessionId: () => 's1', policy: () => ({ ...DEFAULT_POLICY, mode: current }),
        plans: { gate: () => base.plans.gate(), canExpand: () => base.plans.canExpand(), expand: (targets) => base.plans.expand(targets.slice(0, 1)), onChange: (listener) => base.plans.onChange(listener) },
        components: () => components, context: () => ({ parentToolUseId: null, lastMessage: 'Touching both.' }), home: base.home, tempRoots: [],
      });
      const decisions: ToolDecisionRecord[] = [];
      gate.onDecision((decision) => decisions.push(decision));
      const call = () => gate.evaluate({ tool_name: 'Bash', tool_input: twoFiles, tool_use_id: 'toolu_1', cwd: base.root }, new AbortController().signal);
      const shown = () => waitFor(() => gate.pending().at(0), 'prompt shown');
      return { ...base, gate, decisions, call, shown, switchMode: (next: ControlMode) => { current = next; } };
    }

    it('asks again about the remaining file instead of denying as "waiting for the user"', async () => {
      const { gate, call, shown, plans, decisions } = await limitedExpansion('B');
      const answer = call();
      const first = await shown();
      expect(first.targets.map((target) => target.path)).toEqual(['src/other.ts', 'src/lib/util.ts']);
      gate.answer(first.id, 'expand-plan');
      const second = await waitFor(() => gate.pending().find((prompt) => prompt.id !== first.id), 'second prompt');
      expect([second.targets.filter((target) => !target.inScope).map((target) => target.path), second.canExpand, plans.gate()]).toMatchObject([['src/lib/util.ts'], true, { version: 2 }]);
      expect(decisions).toEqual([]);
      gate.answer(second.id, 'allow-once');
      expect([(await answer)?.permissionDecision, decisions.map((decision) => decision.decision)]).toEqual(['allow', ['ask-approved']]);
    });

    it('denies with the remaining file named when the mode turned to A while the prompt waited', async () => {
      const { gate, call, shown, switchMode, decisions } = await limitedExpansion('B');
      const answer = call();
      switchMode('A');
      gate.answer((await shown()).id, 'expand-plan');
      const result = await answer;
      expect([result?.permissionDecision, result?.permissionDecisionReason]).toEqual(['deny', expect.stringMatching(/^IDE: src\/lib\/util\.ts is outside the approved plan/)]);
      expect([decisions.map((decision) => decision.decision), gate.pending()]).toEqual([['deny'], []]);
    });

    it('allows and flags the remaining file when the mode turned to C while the prompt waited', async () => {
      const { gate, call, shown, switchMode, decisions, store } = await limitedExpansion('B');
      const answer = call();
      switchMode('C');
      gate.answer((await shown()).id, 'expand-plan');
      const result = await answer;
      expect([result?.permissionDecision, result?.permissionDecisionReason, decisions.map((decision) => decision.decision)]).toEqual([
        'allow', expect.stringContaining('src/lib/util.ts outside the approved plan'), ['flag'],
      ]);
      expect(store.gateEvents('s1').map((event) => event.resolution)).toEqual(['plan-expanded', 'flagged']);
    });
  });

  it('lists only pending prompts from pending(), while prompts() keeps the answered ones', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const first = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    gate.answer((await pending()).id, 'deny');
    await first;
    const second = call('Edit', { file_path: join(root, 'src/lib/util.ts'), old_string: 'c', new_string: 'd' }, undefined, 'toolu_2');
    const open = await waitFor(() => gate.pending().at(0), 'second prompt');
    expect([gate.pending().map((prompt) => prompt.id), gate.prompts().map((prompt) => prompt.status).sort()]).toEqual([[open.id], ['answered', 'pending']]);
    gate.answer(open.id, 'deny');
    await second;
    expect(gate.pending()).toEqual([]);
  });

  it('denies an out-of-scope write in mode A without asking, and records the denial', async () => {
    const { root, call, approve, gate, store } = await setup({ mode: 'A' });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecision).toBe('deny');
    expect([gate.prompts(), store.gateEvents('s1').map((event) => event.resolution)]).toEqual([[], ['denied']]);
  });

  it('says no component owns the directory when a new file lands where the map places no owner', async () => {
    const { root, call, approve } = await setup({ mode: 'A' });
    await approve();
    const unowned = await call('Write', { file_path: join(root, 'docs/notes.md') });
    const owned = await call('Write', { file_path: join(root, 'src/lib/new.ts') }, undefined, 'toolu_2');
    expect(unowned?.permissionDecisionReason).toContain('no component owns this directory; name the file in a step, or expand the plan');
    expect([owned?.permissionDecision, owned?.permissionDecisionReason]).toEqual(['deny', expect.not.stringContaining('no component owns')]);
  });

  it('does not say no component owns the directory when two components tie for the new file', async () => {
    const { root, call, approve } = await setup({ mode: 'A' });
    components.push({ id: 'x1', name: 'X1', files: [], globs: ['tie/**'] }, { id: 'x2', name: 'X2', files: [], globs: ['tie/**'] });
    try {
      await approve();
      const tied = await call('Write', { file_path: join(root, 'tie/new.ts') });
      expect([tied?.permissionDecision, tied?.permissionDecisionReason]).toEqual(['deny', expect.not.stringContaining('no component owns')]);
    } finally {
      components.splice(-2);
    }
  });

  it('allows and flags an out-of-scope write in mode C', async () => {
    const { root, call, approve, store, decisions } = await setup({ mode: 'C' });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecision).toBe('allow');
    expect([decisions.at(-1)?.decision, store.gateEvents('s1').map((event) => event.resolution)]).toEqual(['flag', ['flagged']]);
  });

  it('drops the prompt when the hook connection closes, and refuses a late answer', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const closed = new AbortController();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') }, closed.signal);
    const prompt = await pending();
    closed.abort();
    expect(await answer).toBeNull();
    expect(gate.prompts().map((view) => view.status)).toEqual(['dropped']);
    expect(() => gate.answer(prompt.id, 'allow-once')).toThrow(GateError);
  });

  it('drops the prompt and denies when its tool call ends in the stream', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    await pending();
    gate.dropForTool('toolu_1');
    expect((await answer)?.permissionDecisionReason).toBe('IDE: the call ended before the user answered.');
  });

  it('drops every waiting prompt and denies its call when the agent process ends', async () => {
    const { root, call, approve, gate, decisions } = await setup();
    await approve();
    const answers = Promise.all([
      call('Write', { file_path: join(root, 'src/other.ts') }, undefined, 'toolu_1'),
      call('Write', { file_path: join(root, 'src/lib/util.ts') }, undefined, 'toolu_2'),
    ]);
    await waitFor(() => gate.prompts().filter((prompt) => prompt.status === 'pending').length === 2, 'two prompts shown');
    gate.dropAll();
    expect((await answers).map((answer) => answer?.permissionDecisionReason)).toEqual([
      'IDE: the call ended before the user answered.', 'IDE: the call ended before the user answered.',
    ]);
    expect([gate.prompts().map((prompt) => prompt.status), decisions.map((decision) => decision.decision)]).toEqual([['dropped', 'dropped'], ['deny', 'deny']]);
  });

  describe('while the watchdog holds', () => {
    const quiet = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(() => (state.done = true));
      return state;
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

    it('answers a held call only after the release, and judges it then', async () => {
      const hold = new Hold();
      const { root, call, decisions } = await setup({ hold });
      hold.hold('event');
      const answer = call('Write', { file_path: join(root, 'src/app.ts') });
      const state = quiet(answer);
      await pause();
      expect([state.done, decisions.length]).toEqual([false, 0]);
      hold.release();
      expect((await answer)?.permissionDecision).toBe('deny');
      expect(decisions.map((decision) => decision.decision)).toEqual(['deny']);
    });

    it('lets the IDE own tools through while held', async () => {
      const hold = new Hold();
      const { call } = await setup({ hold });
      hold.hold('event');
      expect((await call('mcp__idecore__propose_plan', {}))?.permissionDecision).toBe('allow');
    });

    it('also holds a call that was already being judged when the hold started', async () => {
      const hold = new Hold();
      const { root, call, decisions } = await setup({ hold });
      const answer = call('Write', { file_path: join(root, 'src/app.ts') });
      hold.hold('event');
      const state = quiet(answer);
      await pause();
      expect([state.done, decisions.length]).toEqual([false, 0]);
      hold.release();
      await answer;
      expect(decisions).toHaveLength(1);
    });

    it('judges the waiting calls in arrival order after each release, although the first judges slowest', async () => {
      const hold = new Hold();
      const { root, call, decisions } = await setup({ hold });
      const round = async (ids: string[]) => {
        hold.hold('event');
        const answers = Promise.all([
          call('Write', { file_path: join(root, 'src/slow-judge.ts') }, undefined, ids[0]),
          call('Bash', { command: 'ls' }, undefined, ids[1]),
          call('Write', { file_path: join(root, 'src/app.ts') }, undefined, ids[2]),
        ]);
        await pause();
        hold.release();
        await answers;
      };
      await round(['a1', 'a2', 'a3']);
      await round(['b1', 'b2', 'b3']);
      expect(decisions.map((decision) => decision.toolUseId)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
    });

    it('re-judges a call when a hold started and ended while it was being judged', async () => {
      const hold = new Hold();
      let judgings = 0;
      const { root, call, decisions } = await setup({ hold, onPolicy: () => judgings++ });
      await call('Write', { file_path: join(root, 'src/slow-judge.ts') }, undefined, 'plain');
      const once = judgings;
      judgings = 0;
      const answer = call('Write', { file_path: join(root, 'src/slow-judge.ts') }, undefined, 'raced');
      await pause();
      hold.hold('event');
      hold.release();
      await answer;
      expect([decisions.map((decision) => decision.toolUseId), judgings]).toEqual([['plain', 'raced'], once * 2]);
    });

    it('answers nothing for a call whose connection closed while it was being judged', async () => {
      const { root, call, decisions } = await setup({ hold: new Hold() });
      const closed = new AbortController();
      const answer = call('Write', { file_path: join(root, 'src/slow-judge.ts') }, closed.signal);
      closed.abort();
      expect(await answer).toBeNull();
      expect(decisions).toEqual([]);
    });

    it('denies with "did not respond" when the call is still held at the deadline', async () => {
      const hold = new Hold();
      const { root, call, decisions } = await setup({ hold, holdMs: 30 });
      hold.hold('event');
      const answer = await call('Write', { file_path: join(root, 'src/app.ts') });
      expect(answer?.permissionDecisionReason).toBe("IDE: the user did not respond in time. Stop and wait for the user's next message.");
      expect([answer?.permissionDecision, decisions]).toEqual(['deny', []]);
    });

    it('returns null for a connection that closes while held, leaving nothing behind', async () => {
      const hold = new Hold();
      const { root, call, gate, decisions } = await setup({ hold });
      hold.hold('event');
      const closed = new AbortController();
      const answer = call('Write', { file_path: join(root, 'src/app.ts') }, closed.signal);
      closed.abort();
      expect(await answer).toBeNull();
      hold.release();
      await pause();
      expect([gate.prompts(), decisions]).toEqual([[], []]);
    });

    it('withdraws an open prompt as dropped, keeps its call open, and asks afresh after the release', async () => {
      const hold = new Hold();
      const { root, call, approve, pending, gate, decisions, store } = await setup({ hold });
      await approve();
      const answer = call('Write', { file_path: join(root, 'src/other.ts') });
      const state = quiet(answer);
      const first = await pending();
      hold.hold('event');
      gate.withdrawPending('a watchdog event started');
      await waitFor(() => gate.prompts().some((view) => view.status === 'dropped'), 'prompt dropped');
      expect(gate.prompts().map((view) => [view.id, view.status])).toEqual([[first.id, 'dropped']]);
      expect(() => gate.answer(first.id, 'allow-once')).toThrow(GateError);
      expect(store.gateEvents('s1').map((event) => [event.id, event.resolution])).toEqual([[first.id, 'dropped']]);
      await pause();
      expect([state.done, decisions]).toEqual([false, []]);
      hold.release();
      const second = await waitFor(() => gate.pending()[0], 'fresh prompt');
      expect(second.id).not.toBe(first.id);
      gate.answer(second.id, 'allow-once');
      expect((await answer)?.permissionDecision).toBe('allow');
      expect(decisions.map((decision) => decision.decision)).toEqual(['ask-approved']);
    });

    it('gives a call one budget in all: a prompt, its withdrawal, the hold and the fresh prompt share holdMs', async () => {
      const hold = new Hold();
      const { root, call, approve, pending, gate } = await setup({ hold, holdMs: 600 });
      await approve();
      const started = Date.now();
      const answer = call('Write', { file_path: join(root, 'src/other.ts') });
      await pending();
      await sleep(250);
      hold.hold('event');
      gate.withdrawPending('x');
      await sleep(150);
      hold.release();
      const reply = await answer;
      expect(reply?.permissionDecisionReason).toBe("IDE: the user did not respond in time. Stop and wait for the user's next message.");
      expect(Date.now() - started).toBeLessThan(800);
    });

    it('denies when the budget ran out while the call waited for the release', async () => {
      const hold = new Hold();
      const { root, call, approve, pending, gate, decisions } = await setup({ hold, holdMs: 1000 });
      await approve();
      const answer = call('Write', { file_path: join(root, 'src/other.ts') });
      await pending();
      hold.hold('event');
      gate.withdrawPending('x');
      expect((await answer)?.permissionDecisionReason).toMatch(/did not respond/);
      expect(decisions.map((decision) => decision.decision)).toEqual([]);
    });

    it('returns null for a withdrawn call whose connection closes before the release, leaving nothing behind', async () => {
      const hold = new Hold();
      const { root, call, approve, pending, gate, decisions } = await setup({ hold });
      await approve();
      const closed = new AbortController();
      const answer = call('Write', { file_path: join(root, 'src/other.ts') }, closed.signal);
      await pending();
      hold.hold('event');
      gate.withdrawPending('x');
      await waitFor(() => hold.waiting() === 1, 'call waits for the release');
      closed.abort();
      expect(await answer).toBeNull();
      hold.release();
      await pause();
      expect([gate.prompts().map((view) => view.status), hold.waiting(), decisions]).toEqual([['dropped'], 0, []]);
    });

    it('does nothing when withdrawing with no prompt open', async () => {
      const hold = new Hold();
      const { gate } = await setup({ hold });
      hold.hold('event');
      gate.withdrawPending('x');
      expect(gate.prompts()).toEqual([]);
    });
  });

  it('denies with "did not respond" at the hold limit', async () => {
    const { root, call, approve } = await setup({ holdMs: 50 });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecisionReason)
      .toBe("IDE: the user did not respond in time. Stop and wait for the user's next message.");
  });

  it('refuses a second answer to the same prompt', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    const prompt = await pending();
    gate.answer(prompt.id, 'allow-once');
    await answer;
    expect(() => gate.answer(prompt.id, 'deny')).toThrow(GateError);
  });

  it('does not offer to expand the plan for a target outside the project', async () => {
    const { call, approve, pending, gate } = await setup();
    await approve();
    void call('Write', { file_path: join(tempDir('ide-elsewhere-'), 'x.txt') });
    const prompt = await pending();
    expect([prompt.canExpand, prompt.targets.map((target) => target.kind)]).toEqual([false, ['outside']]);
    expect(() => gate.answer(prompt.id, 'expand-plan')).toThrow(GateError);
  });

  it('asks about a tool the IDE does not know, with no targets', async () => {
    const { call, pending } = await setup();
    void call('BrandNewTool', { anything: 1 });
    expect(await pending()).toMatchObject({ tool: 'BrandNewTool', targets: [], canExpand: false, preview: { kind: 'input' } });
  });

  it('judges a 5 MB Write and caps its preview', async () => {
    const { root, call, approve, pending } = await setup();
    await approve();
    void call('Write', { file_path: join(root, 'src/other.ts'), content: 'x'.repeat(5_000_000) });
    const prompt = await pending();
    expect(prompt.preview).toMatchObject({ kind: 'write', truncated: true });
    expect(prompt.preview.kind === 'write' ? prompt.preview.content.length : 0).toBe(20_000);
  });

  it('judges each file that mv moves into a directory', async () => {
    const { call, plans, pending } = await setup();
    const proposed = plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path: 'src/app.ts', op: 'delete' }] }] });
    const plan = await waitFor(() => plans.plans().find((candidate) => candidate.status === 'proposed'), 'plan proposed');
    plans.answer(plan.id, plan.version, { kind: 'approve' });
    await proposed;
    plans.step({ key: 'edit', phase: 'start' });
    void call('Bash', { command: 'mv src/app.ts src/lib' });
    expect((await pending()).targets.map((target) => [target.path, target.inScope])).toEqual([['src/app.ts', true], ['src/lib/app.ts', false]]);
  });

  it('keeps waiting for an answer, and answers normally, even when a change listener throws', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    gate.onChange(() => {
      throw new Error('a UI listener blew up');
    });
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    const prompt = await pending();
    gate.answer(prompt.id, 'allow-once');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(gate.prompts().map((view) => view.status)).toEqual(['answered']);
  });

  it('does not let a throwing decision listener turn an allow into a deny', async () => {
    const { root, call, approve, gate } = await setup();
    await approve();
    gate.onDecision(() => {
      throw new Error('a UI listener blew up');
    });
    const answer = await call('Edit', { file_path: join(root, 'src/app.ts'), old_string: 'a', new_string: 'b' });
    expect(answer?.permissionDecision).toBe('allow');
  });

  it("resolves a relative shell write target against the hook's cwd, not the project root", async () => {
    const { root, call, approve } = await setup();
    await approve();
    const answer = await call('Bash', { command: 'echo x > app.ts' }, new AbortController().signal, 'toolu_1', join(root, 'src'));
    expect(answer?.permissionDecision).toBe('allow');
  });

  it("resolves a relative Write file_path against the hook's cwd, not the project root", async () => {
    const { root, call, approve } = await setup();
    await approve();
    const answer = await call('Write', { file_path: 'app.ts', content: 'x' }, new AbortController().signal, 'toolu_1', join(root, 'src'));
    expect(answer?.permissionDecision).toBe('allow');
  });

  it('does not let a target land in scope just because resolving it against the project root would put it there', async () => {
    const { root, call, approve, pending } = await setup();
    await approve();
    void call('Bash', { command: 'echo x > src/app.ts' }, new AbortController().signal, 'toolu_1', join(root, 'nested'));
    const prompt = await pending();
    expect(prompt.targets.map((target) => [target.path, target.inScope])).toEqual([['nested/src/app.ts', false]]);
  });

  it('never offers to expand the plan for an unresolved shell target', async () => {
    const { call, approve, pending, gate } = await setup();
    await approve();
    void call('Bash', { command: 'echo x > $UNSET/x' });
    const prompt = await pending();
    expect(prompt.canExpand).toBe(false);
    expect(() => gate.answer(prompt.id, 'expand-plan')).toThrow(GateError);
  });

  it('never offers to expand the plan for a git command that rewrites the whole work tree', async () => {
    const { call, approve, pending, gate } = await setup();
    await approve();
    void call('Bash', { command: 'git checkout .' });
    const prompt = await pending();
    expect(prompt.canExpand).toBe(false);
    expect(() => gate.answer(prompt.id, 'expand-plan')).toThrow(GateError);
  });

  it('records no gate event for a denial caused by a missing plan or an inactive step (R10)', async () => {
    const { root, call, plans, store } = await setup();
    await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' });
    await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
    await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' });
    expect(store.gateEvents('s1')).toEqual([]);
  });
});

describe('hookRoute', () => {
  async function served(options: Options = {}) {
    const { gate, root, approve } = await setup(options);
    const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [hookRoute({ secret: 's3cret', gate })] });
    onTestFinished(() => server.close());
    const post = (secret: string | null, body: object) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const headers = secret === null ? {} : { authorization: `Bearer ${secret}` };
      const req = request({ host: '127.0.0.1', port: server.port, path: '/hook', method: 'POST', headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    const postRaw = (secret: string, body: object) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/hook', method: 'POST', headers: { authorization: `Bearer ${secret}` } });
      req.on('error', () => {});
      req.end(JSON.stringify(body));
      return req;
    };
    return { post, postRaw, root, gate, approve };
  }

  it('refuses a hook call without the agent secret', async () => {
    const { post } = await served();
    expect((await post('wrong', {})).status).toBe(401);
  });

  it('refuses a hook call with no Authorization header at all', async () => {
    const { post } = await served();
    expect((await post(null, {})).status).toBe(401);
  });

  it('answers a hook call with the decision as JSON', async () => {
    const { post, root } = await served();
    const response = await post('s3cret', { tool_name: 'Write', tool_use_id: 't', tool_input: { file_path: join(root, 'src/app.ts') }, cwd: root });
    expect([response.status, JSON.parse(response.body).permissionDecision]).toEqual([200, 'deny']);
  });

  it('carries a 5 MB Write hook input through real HTTP and gets a decision back', async () => {
    const { post, root } = await served();
    const response = await post('s3cret', {
      tool_name: 'Write', tool_use_id: 't2', cwd: root,
      tool_input: { file_path: join(root, 'src/app.ts'), content: 'x'.repeat(5_000_000) },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).permissionDecision).toBe('deny');
  });

  it('drops the prompt when the client socket is destroyed mid-hold, and refuses a late answer', async () => {
    const { postRaw, root, gate, approve } = await served();
    await approve();
    const req = postRaw('s3cret', { tool_name: 'Write', tool_use_id: 'toolu_http', tool_input: { file_path: join(root, 'src/other.ts') }, cwd: root });
    const prompt = await waitFor(() => gate.prompts().find((view) => view.status === 'pending'), 'prompt shown');
    req.destroy();
    await waitFor(() => gate.prompts().some((view) => view.id === prompt.id && view.status === 'dropped'), 'prompt dropped');
    expect(() => gate.answer(prompt.id, 'allow-once')).toThrow(GateError);
  });

  it('answers "gate failed" over HTTP when the gate throws while judging the call', async () => {
    const { post, root } = await served({ throwPolicy: true });
    const response = await post('s3cret', { tool_name: 'Write', tool_use_id: 't3', tool_input: { file_path: join(root, 'src/app.ts') }, cwd: root });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'IDE: the gate failed, so the call is blocked.' });
  });
});

describe('HookGate onAllowed', () => {
  async function watched(options: Options = {}) {
    const h = await setup(options);
    const calls: ToolCall[] = [];
    h.gate.onAllowed((call) => calls.push(call));
    return { ...h, calls };
  }
  const base = { parentToolUseId: null, allTracked: false, cwdRel: null, background: false, allowedOnce: false };

  it('reports an allowed write with its project-relative target and no allow-once', async () => {
    const { root, call, approve, calls } = await watched();
    await approve();
    await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' });
    expect(calls).toEqual([{ ...base, toolUseId: 'toolu_1', tool: 'Write', toolClass: 'file-writer', targets: ['src/app.ts'] }]);
  });

  it('reports an unchecked call: a read, and a shell command that writes no project files', async () => {
    const { root, call, calls } = await watched();
    await call('Read', { file_path: join(root, 'src/app.ts') }, undefined, 'r1');
    await call('Bash', { command: 'ls -la' }, undefined, 'b1');
    expect(calls).toEqual([
      { ...base, toolUseId: 'r1', tool: 'Read', toolClass: 'read', targets: [] },
      { ...base, toolUseId: 'b1', tool: 'Bash', toolClass: 'shell', targets: [] },
    ]);
  });

  it('reports a call the user allowed once with allowedOnce', async () => {
    const { root, call, approve, pending, gate, calls } = await watched();
    await approve();
    const answer = call('Edit', { file_path: join(root, 'src/other.ts'), old_string: 'b', new_string: 'c' });
    const prompt = await pending();
    expect(calls).toEqual([]);
    gate.answer(prompt.id, 'allow-once');
    await answer;
    expect(calls).toEqual([{ ...base, toolUseId: 'toolu_1', tool: 'Edit', toolClass: 'file-writer', targets: ['src/other.ts'], allowedOnce: true }]);
  });

  it('reports a flagged call with allowedOnce', async () => {
    const { root, call, approve, calls } = await watched({ mode: 'C' });
    await approve();
    await call('Write', { file_path: join(root, 'src/other.ts') });
    expect(calls).toMatchObject([{ targets: ['src/other.ts'], allowedOnce: true }]);
  });

  it('reports a call that the plan expansion let through without allowedOnce', async () => {
    const { root, call, approve, pending, gate, calls } = await watched();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    gate.answer((await pending()).id, 'expand-plan');
    await answer;
    expect(calls.map((c) => [c.targets, c.allowedOnce])).toEqual([[['src/other.ts'], false]]);
  });

  it('does not report a call denied for lack of a plan, or one whose prompt timed out', async () => {
    const { root, call, approve, calls } = await watched({ holdMs: 20 });
    expect((await call('Write', { file_path: join(root, 'src/app.ts') }))?.permissionDecision).toBe('deny');
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }, undefined, 'slow'))?.permissionDecision).toBe('deny');
    expect(calls).toEqual([]);
  });

  it('does not report a call the user denied', async () => {
    const { root, call, approve, pending, gate, calls } = await watched();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    gate.answer((await pending()).id, 'deny');
    await answer;
    expect(calls).toEqual([]);
  });

  it('takes the parent tool use id from the call context', async () => {
    const { root, call, approve, calls } = await watched({ context: { parentToolUseId: 'task_9', lastMessage: null } });
    await approve();
    await call('Write', { file_path: join(root, 'src/app.ts') });
    expect(calls[0]?.parentToolUseId).toBe('task_9');
  });

  it('marks a run_in_background shell and gives its directory relative to the project', async () => {
    const { root, call, approve, calls } = await watched();
    await approve();
    await call('Bash', { command: 'echo x > app.ts', run_in_background: true }, undefined, 'bg', join(root, 'src'));
    await call('Bash', { command: 'echo x > app.ts' }, undefined, 'fg', join(root, 'src'));
    expect(calls).toEqual([
      { ...base, toolUseId: 'bg', tool: 'Bash', toolClass: 'shell', targets: ['src/app.ts'], background: true, cwdRel: 'src' },
      { ...base, toolUseId: 'fg', tool: 'Bash', toolClass: 'shell', targets: ['src/app.ts'] },
    ]);
  });

  it('marks Monitor as background, with the project root as its directory', async () => {
    const { call, calls } = await watched();
    await call('Monitor', { command: 'tail -f log.txt' }, undefined, 'mon');
    expect(calls).toEqual([{ ...base, toolUseId: 'mon', tool: 'Monitor', toolClass: 'shell', targets: [], background: true, cwdRel: '' }]);
  });

  it('marks an Agent or Task call as background, without targets or directory', async () => {
    const { call, calls } = await watched();
    await call('Agent', { description: 'x', prompt: 'y' }, undefined, 'ag');
    await call('Task', { description: 'x', prompt: 'y' }, undefined, 'tk');
    expect(calls).toEqual([
      { ...base, toolUseId: 'ag', tool: 'Agent', toolClass: 'subagent', targets: [], background: true },
      { ...base, toolUseId: 'tk', tool: 'Task', toolClass: 'subagent', targets: [], background: true },
    ]);
  });

  it('feeds a ledger so an async subagent counts as running until its task ends, and a root Monitor covers no path', async () => {
    const { root, call, gate } = await watched();
    const ledger = new ActivityLedger();
    gate.onAllowed((c) => ledger.allowed(c));
    await call('Agent', { description: 'x', prompt: 'y' }, undefined, 'ag');
    await call('Monitor', { command: 'tail -f log.txt' }, undefined, 'mon', root);
    ledger.ended('ag');
    expect([ledger.runningSubagents(), ledger.runningShell(), ledger.attribute('src/app.ts', performance.now()).origin]).toEqual([1, true, 'human']);
    ledger.taskEnded('ag');
    expect(ledger.runningSubagents()).toBe(0);
  });

  it('gives no directory for a background shell that runs outside the project', async () => {
    const { call, calls } = await watched();
    await call('Bash', { command: 'ls', run_in_background: true }, undefined, 'out', tempDir('ide-elsewhere-'));
    expect(calls[0]).toMatchObject({ background: true, cwdRel: null });
  });

  it('reports allTracked from the shell heuristic', async () => {
    const { call, approve, calls } = await watched({ mode: 'C' });
    await approve();
    await call('Bash', { command: 'git checkout .' });
    expect(calls).toMatchObject([{ tool: 'Bash', allTracked: true }]);
  });

  it('stops telling a listener that unsubscribed and survives one that throws', async () => {
    const { root, gate, call, approve } = await watched();
    await approve();
    const seen: string[] = [];
    const off = gate.onAllowed((c) => seen.push(c.toolUseId));
    gate.onAllowed(() => {
      throw new Error('listener boom');
    });
    expect((await call('Write', { file_path: join(root, 'src/app.ts') }, undefined, 'one'))?.permissionDecision).toBe('allow');
    off();
    await call('Write', { file_path: join(root, 'src/app.ts') }, undefined, 'two');
    expect(seen).toEqual(['one']);
  });
});

describe('HookGate.hasCall', () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

  it('reports decided after a decision, pending while a prompt waits, none otherwise', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    expect(gate.hasCall('unknown')).toBe('none');
    await call('Read', {}, undefined, 'read1');
    expect(gate.hasCall('read1')).toBe('decided');
    const answer = call('Edit', { file_path: join(root, 'src/other.ts'), old_string: 'b', new_string: 'c' }, undefined, 'edit1');
    const prompt = await pending();
    expect(gate.hasCall('edit1')).toBe('pending');
    gate.answer(prompt.id, 'allow-once');
    await answer;
    expect(gate.hasCall('edit1')).toBe('decided');
  });

  it('reports none for a call whose hook closed without a decision', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const controller = new AbortController();
    const answer = call('Edit', { file_path: join(root, 'src/other.ts'), old_string: 'b', new_string: 'c' }, controller.signal, 'edit1');
    await pending();
    controller.abort();
    await answer;
    expect(gate.hasCall('edit1')).toBe('none');
  });

  it('reports a held call as pending and as decided after the release', async () => {
    const hold = new Hold();
    const { root, call, gate } = await setup({ hold });
    hold.hold('event');
    const answer = call('Write', { file_path: join(root, 'src/app.ts') }, undefined, 'held1');
    await pause();
    expect(gate.hasCall('held1')).toBe('pending');
    hold.release();
    await answer;
    expect(gate.hasCall('held1')).toBe('decided');
  });
});
