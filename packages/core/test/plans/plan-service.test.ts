import { execFileSync } from 'node:child_process';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PlanView, Policy } from '@ide/protocol';
import { covers } from '../../src/gate/scope';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanError, PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore, type Store } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

const small = { goal: 'Fix app', steps: [{ key: 'edit', title: 'Edit app', rationale: 'bug', targets: [{ path: 'src/app.ts', op: 'modify' }] }] };
const big = {
  goal: 'Refactor',
  steps: [
    { key: 'a', title: 'App', rationale: '', targets: [{ componentId: 'app', op: 'modify' }] },
    { key: 'b', title: 'Lib', rationale: '', targets: [{ componentId: 'lib', op: 'modify' }] },
  ],
};

interface Setup {
  service: PlanService;
  store: Store;
  root: string;
  setSession(id: string | null): void;
  setComponents(next: ComponentRef[]): void;
  restart(): PlanService;
}

async function setup(options: { policy?: Partial<Policy>; deadlineMs?: number } = {}): Promise<Setup> {
  const root = tempDir('ide-plans-');
  await writeTree(root, { 'src/app.ts': '', 'src/other.ts': '', 'src/lib/util.ts': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const storeDir = tempDir('ide-store-');
  let store = openStore(storeDir);
  onTestFinished(() => store.close());
  for (const id of ['s1', 's2']) {
    store.saveSession(sessionRecord(id, root));
  }
  let sessionId: string | null = 's1';
  let current = components;
  let ids = 0;
  const create = () => new PlanService({
    root, store,
    sessionId: () => sessionId,
    components: () => current,
    review: (steps) => reviewPlan(steps, { root, policy: { ...DEFAULT_POLICY, ...options.policy }, components: current, tempRoots: [] }),
    newId: () => `plan-${(ids += 1)}`,
    deadlineMs: options.deadlineMs,
  });
  const service = create();
  return {
    service, store, root,
    setSession: (id) => { sessionId = id; },
    setComponents: (next) => { current = next; },
    restart: () => {
      store.close();
      store = openStore(storeDir);
      return create();
    },
  };
}

const latest = (service: PlanService): PlanView | undefined => service.plans().at(-1);
const waiting = (service: PlanService) => waitFor(() => service.plans().find((plan) => plan.status === 'proposed'), 'plan proposed');

describe('PlanService', () => {
  it('approves a small plan at once, marked as approved automatically', async () => {
    const { service } = await setup();
    expect(await service.propose(small)).toEqual({ ok: true, value: { status: 'approved' } });
    expect(latest(service)).toMatchObject({ id: 'plan-1', version: 1, status: 'approved', approvedBy: 'auto', review: { auto: true } });
  });

  it('holds a bigger plan until the user approves it, then enforces its frozen scope', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    const plan = await waiting(service);
    expect(service.gate()).toEqual({ state: 'none' });
    service.answer(plan.id, plan.version, { kind: 'approve' });
    expect(await call).toEqual({ ok: true, value: { status: 'approved' } });
    expect(service.gate()).toEqual({
      state: 'approved', planId: 'plan-1', version: 1, activeStep: null,
      scope: { paths: ['src/app.ts', 'src/lib/util.ts', 'src/other.ts'], globs: ['src/lib/**'], deletes: { paths: [], globs: [] } },
    });
  });

  it('freezes the scope again from the current map when the user approves', async () => {
    const { service, setComponents } = await setup();
    const call = service.propose(big);
    await waiting(service);
    setComponents([{ ...components[0]!, files: [...components[0]!.files, 'src/added.ts'] }, components[1]!]);
    service.answer('plan-1', 1, { kind: 'approve' });
    await call;
    expect(service.gate()).toMatchObject({ scope: { paths: ['src/added.ts', 'src/app.ts', 'src/lib/util.ts', 'src/other.ts'] } });
  });

  it('answers changes_requested with the feedback, and the next proposal is version 2 of the same plan', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    const plan = await waiting(service);
    service.answer(plan.id, 1, { kind: 'changes', feedback: ' Leave Lib alone ' });
    expect(await call).toEqual({ ok: true, value: { status: 'changes_requested', feedback: 'Leave Lib alone' } });
    void service.propose(big);
    await waitFor(() => latest(service)?.version === 2, 'version 2');
    expect(latest(service)).toMatchObject({ id: 'plan-1', version: 2, status: 'proposed' });
  });

  it('refuses a request for changes without feedback', async () => {
    const { service } = await setup();
    void service.propose(big);
    const plan = await waiting(service);
    expect(() => service.answer(plan.id, 1, { kind: 'changes', feedback: ' ' })).toThrow(PlanError);
  });

  it('rejects a plan whose latest version is changes-requested, closing the plan', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    const plan = await waiting(service);
    service.answer(plan.id, 1, { kind: 'changes', feedback: 'not now' });
    expect(await call).toEqual({ ok: true, value: { status: 'changes_requested', feedback: 'not now' } });
    service.answer('plan-1', 1, { kind: 'reject', feedback: '' });
    expect([latest(service)?.status, service.gate()]).toEqual(['rejected', { state: 'rejected', planId: 'plan-1' }]);
  });

  it('supersedes an older waiting proposal when a second one arrives', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    await waiting(service);
    void service.propose(big);
    await waitFor(() => latest(service)?.version === 2, 'version 2');
    expect(await call).toEqual({ ok: true, value: { status: 'rejected', feedback: 'Superseded by version 2.' } });
    expect(service.plans().find((plan) => plan.version === 1)?.status).toBe('superseded');
    expect(() => service.answer('plan-1', 1, { kind: 'approve' })).toThrow(PlanError);
  });

  it('closes a rejected plan: writes are denied as rejected and the next proposal starts a new plan', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    const plan = await waiting(service);
    service.answer(plan.id, 1, { kind: 'reject', feedback: '' });
    expect(await call).toEqual({ ok: true, value: { status: 'rejected' } });
    expect(service.gate()).toEqual({ state: 'rejected', planId: 'plan-1' });
    service.userMessage();
    await service.propose(small);
    expect(latest(service)).toMatchObject({ id: 'plan-2', version: 1 });
  });

  it('revokes an automatically approved plan on Reject without any call waiting', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.answer('plan-1', 1, { kind: 'reject', feedback: 'not now' });
    expect([latest(service)?.status, latest(service)?.feedback, service.gate()]).toEqual(['rejected', 'not now', { state: 'rejected', planId: 'plan-1' }]);
  });

  describe('after a Reject', () => {
    const paused = 'You rejected the previous plan; this plan waits for you.';
    const smallOn = (path: string) => ({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path, op: 'modify' }] }] });
    const rejectLatest = (service: PlanService) => {
      const plan = latest(service)!;
      service.answer(plan.id, plan.version, { kind: 'reject', feedback: '' });
    };

    it('makes the next small plan wait until the user sends a message', async () => {
      const { service } = await setup();
      await service.propose(smallOn('src/app.ts'));
      rejectLatest(service);
      const second = service.propose(smallOn('src/other.ts'));
      const plan = await waiting(service);
      expect([plan.review.auto, plan.review.notes[0]]).toEqual([false, paused]);
      service.answer(plan.id, plan.version, { kind: 'approve' });
      await second;
      service.userMessage();
      const third = await service.propose(smallOn('src/app.ts'));
      expect([third, latest(service)?.approvedBy]).toEqual([{ ok: true, value: { status: 'approved' } }, 'auto']);
    });

    it('keeps every small plan waiting until the user sends a message, not just the first', async () => {
      const { service } = await setup();
      await service.propose(smallOn('src/app.ts'));
      rejectLatest(service);
      const second = service.propose(smallOn('src/other.ts'));
      const plan = await waiting(service);
      service.answer(plan.id, plan.version, { kind: 'changes', feedback: 'again' });
      await second;
      void service.propose(smallOn('src/other.ts'));
      await waitFor(() => latest(service)?.version === 2, 'version 2');
      expect([latest(service)?.status, latest(service)?.review.notes[0]]).toEqual(['proposed', paused]);
    });

    it('clears the pause when the agent session changes', async () => {
      const { service, setSession } = await setup();
      await service.propose(smallOn('src/app.ts'));
      rejectLatest(service);
      setSession('s2');
      expect(await service.propose(smallOn('src/app.ts'))).toEqual({ ok: true, value: { status: 'approved' } });
    });

    it('does not repeat the note on a bigger plan, which waits anyway', async () => {
      const { service } = await setup();
      await service.propose(smallOn('src/app.ts'));
      rejectLatest(service);
      void service.propose(big);
      const plan = await waiting(service);
      expect(plan.review.notes).not.toContain(paused);
    });
  });

  describe('step events', () => {
    it('emits start and done with the plan version and reports the step states', async () => {
      const { service } = await setup();
      const events: unknown[] = [];
      service.onStep((e) => events.push(e));
      await service.propose(small);
      expect(service.stepStates()).toEqual({ 'plan-1': {} });
      service.step({ key: 'edit', phase: 'start' });
      service.step({ key: 'edit', phase: 'start' });
      expect(service.stepStates()).toEqual({ 'plan-1': { edit: 'active' } });
      service.step({ key: 'edit', phase: 'done' });
      expect(events).toEqual([
        { planId: 'plan-1', version: 1, key: 'edit', phase: 'start' },
        { planId: 'plan-1', version: 1, key: 'edit', phase: 'done' },
      ]);
      expect(service.stepStates()).toEqual({ 'plan-1': { edit: 'done' } });
    });

    it('emits nothing for a refused step and survives a throwing listener', async () => {
      const { service, store } = await setup();
      const events: unknown[] = [];
      service.onStep(() => { throw new Error('listener'); });
      service.onStep((e) => events.push(e));
      const saved = vi.spyOn(store, 'saveStepState');
      await service.propose(small);
      expect(service.step({ key: 'edit', phase: 'done' }).ok).toBe(false);
      expect(service.step({ key: 'nope', phase: 'start' }).ok).toBe(false);
      expect(events).toEqual([]);
      const seen: number[] = [];
      service.onStep(() => seen.push(saved.mock.calls.length));
      expect(service.step({ key: 'edit', phase: 'start' })).toEqual({ ok: true });
      expect(events).toHaveLength(1);
      expect(seen).toEqual([1]);
    });
  });

  describe('starting a step while another is active', () => {
    const three = { ...big, steps: [...big.steps, { key: 'c', title: 'Other', rationale: '', targets: [{ path: 'src/other.ts', op: 'modify' }] }] };
    const approved = async (plan: { goal: string; steps: unknown[] }) => {
      const { service } = await setup();
      const events: unknown[] = [];
      service.onStep((e) => events.push(e));
      const call = service.propose(plan);
      await waiting(service);
      service.answer('plan-1', 1, { kind: 'approve' });
      await call;
      return { service, events };
    };

    it('finishes the active step and starts the next, emitting done then start', async () => {
      const { service, events } = await approved(big);
      service.step({ key: 'a', phase: 'start' });
      events.length = 0;
      expect(service.step({ key: 'b', phase: 'start' })).toEqual({ ok: true });
      expect(service.stepStates()).toEqual({ 'plan-1': { a: 'done', b: 'active' } });
      expect(events).toEqual([
        { planId: 'plan-1', version: 1, key: 'a', phase: 'done' },
        { planId: 'plan-1', version: 1, key: 'b', phase: 'start' },
      ]);
    });

    it('keeps the plan open while a later step is pending and needs an explicit done for the last step', async () => {
      const { service } = await approved(three);
      service.step({ key: 'a', phase: 'start' });
      service.step({ key: 'b', phase: 'start' });
      expect([latest(service)?.status, service.gate().state]).toEqual(['approved', 'approved']);
      service.step({ key: 'c', phase: 'start' });
      expect([latest(service)?.status, service.gate().state, service.stepStates()]).toEqual(['approved', 'approved', { 'plan-1': { a: 'done', b: 'done', c: 'active' } }]);
      service.step({ key: 'c', phase: 'done' });
      expect([latest(service)?.status, service.gate()]).toEqual(['done', { state: 'done', planId: 'plan-1' }]);
    });

    it('does nothing when the already active step is started again', async () => {
      const { service, events } = await approved(big);
      service.step({ key: 'a', phase: 'start' });
      events.length = 0;
      expect(service.step({ key: 'a', phase: 'start' })).toEqual({ ok: true });
      expect(events).toEqual([]);
      expect(service.stepStates()).toEqual({ 'plan-1': { a: 'active' } });
    });

    it('still refuses to start a step that is already done', async () => {
      const { service, events } = await approved(three);
      service.step({ key: 'a', phase: 'start' });
      service.step({ key: 'b', phase: 'start' });
      events.length = 0;
      expect(service.step({ key: 'a', phase: 'start' })).toEqual({ ok: false, error: 'IDE: step "a" is already done.' });
      expect(events).toEqual([]);
      expect(service.stepStates()).toEqual({ 'plan-1': { a: 'done', b: 'active' } });
    });

    it('hands over twice across three steps with every event in order', async () => {
      const { service, events } = await approved(three);
      for (const key of ['a', 'b', 'c']) service.step({ key, phase: 'start' });
      expect(service.stepStates()).toEqual({ 'plan-1': { a: 'done', b: 'done', c: 'active' } });
      expect(events).toEqual([
        { planId: 'plan-1', version: 1, key: 'a', phase: 'start' },
        { planId: 'plan-1', version: 1, key: 'a', phase: 'done' },
        { planId: 'plan-1', version: 1, key: 'b', phase: 'start' },
        { planId: 'plan-1', version: 1, key: 'b', phase: 'done' },
        { planId: 'plan-1', version: 1, key: 'c', phase: 'start' },
      ]);
    });
  });

  describe('resetStep', () => {
    it('puts a started step back to pending, bumps the stored cycle and emits reset', async () => {
      const { service, store } = await setup();
      await service.propose(small);
      const events: unknown[] = [];
      service.onStep((e) => events.push(e));
      const changes: number[] = [];
      service.onChange(() => changes.push(1));
      service.step({ key: 'edit', phase: 'start' });
      service.step({ key: 'edit', phase: 'done' });
      expect(store.stepCycle('plan-1', 'edit')).toBe(0);
      const before = changes.length;
      service.resetStep('plan-1', 'edit');
      expect(service.stepStates()).toEqual({ 'plan-1': { edit: 'pending' } });
      expect(store.stepCycle('plan-1', 'edit')).toBe(1);
      expect(events.at(-1)).toEqual({ planId: 'plan-1', version: 1, key: 'edit', phase: 'reset' });
      expect(changes.length).toBeGreaterThan(before);
      expect(service.gate()).toMatchObject({ state: 'approved', planId: 'plan-1', activeStep: null });
      expect(latest(service)).toMatchObject({ status: 'approved' });
    });

    it('survives a restart: state pending, cycle kept, plan approved again', async () => {
      const { service, restart } = await setup();
      await service.propose(small);
      service.step({ key: 'edit', phase: 'start' });
      service.step({ key: 'edit', phase: 'done' });
      service.resetStep('plan-1', 'edit');
      const again = restart();
      expect(again.stepStates()).toEqual({ 'plan-1': { edit: 'pending' } });
      expect(again.gate()).toMatchObject({ state: 'approved', activeStep: null });
    });

    it('rejects an unknown step, an unknown plan and a pending step', async () => {
      const { service } = await setup();
      const call = service.propose(big);
      await waiting(service);
      service.answer('plan-1', 1, { kind: 'approve' });
      await call;
      expect(() => service.resetStep('plan-1', 'nope')).toThrow(PlanError);
      expect(() => service.resetStep('plan-9', 'a')).toThrow(PlanError);
      expect(() => service.resetStep('plan-1', 'a')).toThrow(PlanError);
    });
  });

  describe('when the last step is done', () => {
    const more = { ...small, steps: [...small.steps, { key: 'more', title: 'More', rationale: '', targets: [{ componentId: 'lib', op: 'modify' }] }] };
    const done = 'The plan was completed before this revision was answered.';

    it('withdraws a waiting revision and answers its call as rejected', async () => {
      const { service } = await setup();
      await service.propose(small);
      service.step({ key: 'edit', phase: 'start' });
      const call = service.propose(more);
      await waiting(service);
      service.step({ key: 'edit', phase: 'done' });
      expect(await call).toEqual({ ok: true, value: { status: 'rejected', feedback: done } });
      expect(service.plans().map((plan) => [plan.version, plan.status, plan.feedback])).toEqual([[1, 'done', null], [2, 'withdrawn', done]]);
      expect(() => service.answer('plan-1', 2, { kind: 'approve' })).toThrow(PlanError);
    });

    it('withdraws a revision the user asked changes for', async () => {
      const { service } = await setup();
      await service.propose(small);
      service.step({ key: 'edit', phase: 'start' });
      const call = service.propose(more);
      await waiting(service);
      service.answer('plan-1', 2, { kind: 'changes', feedback: 'fewer steps' });
      await call;
      service.step({ key: 'edit', phase: 'done' });
      expect(service.plans().map((plan) => [plan.version, plan.status, plan.feedback])).toEqual([[1, 'done', null], [2, 'withdrawn', done]]);
    });
  });

  it('keeps the approved version enforced while a new version waits, and supersedes it on approval', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    const call = service.propose({ ...small, steps: [...small.steps, { key: 'more', title: 'More', rationale: '', targets: [{ componentId: 'lib', op: 'modify' }] }] });
    await waiting(service);
    expect(service.gate()).toMatchObject({ state: 'approved', version: 1, activeStep: 'edit' });
    service.answer('plan-1', 2, { kind: 'approve' });
    await call;
    expect(service.plans().map((plan) => [plan.version, plan.status])).toEqual([[1, 'superseded'], [2, 'approved']]);
    expect(service.gate()).toMatchObject({ state: 'approved', version: 2, activeStep: 'edit' });
  });

  it('rejecting a waiting revision also revokes the approved version before it', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    const call = service.propose({ ...small, steps: [...small.steps, { key: 'more', title: 'More', rationale: '', targets: [{ componentId: 'lib', op: 'modify' }] }] });
    await waiting(service);
    service.answer('plan-1', 2, { kind: 'reject', feedback: '' });
    await call;
    expect([service.plans().map((plan) => plan.status), service.gate()]).toEqual([['rejected', 'rejected'], { state: 'rejected', planId: 'plan-1' }]);
  });

  it('refuses a new version that drops the active step', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    expect(await service.propose(big)).toEqual({ ok: false, error: 'IDE: the new version must keep step "edit", which is active.' });
  });

  it('withdraws a waiting plan when its call is cancelled', async () => {
    const { service } = await setup();
    const abort = new AbortController();
    const call = service.propose(big, abort.signal);
    await waiting(service);
    abort.abort();
    expect([await call, latest(service)?.status]).toEqual([
      { ok: true, value: { status: 'rejected', feedback: 'Cancelled.' } },
      'withdrawn',
    ]);
  });

  it('refuses to approve a version that was cancelled', async () => {
    const { service } = await setup();
    const abort = new AbortController();
    const call = service.propose(big, abort.signal);
    await waiting(service);
    abort.abort();
    await call;
    expect(() => service.answer('plan-1', 1, { kind: 'approve' })).toThrow(PlanError);
    expect(service.gate().state).not.toBe('approved');
  });

  it('answers rejected and withdraws the plan when the user does not answer in time', async () => {
    const { service } = await setup({ deadlineMs: 50 });
    expect(await service.propose(big)).toEqual({
      ok: true, value: { status: 'rejected', feedback: "The user did not answer within 59 minutes. Stop and wait for the user's next message." },
    });
    expect(latest(service)?.status).toBe('withdrawn');
  });

  it('refuses to approve a version that already withdrew after the deadline', async () => {
    const { service } = await setup({ deadlineMs: 50 });
    await service.propose(big);
    expect(() => service.answer('plan-1', 1, { kind: 'approve' })).toThrow(PlanError);
    expect(service.gate().state).not.toBe('approved');
  });

  it('withdraws waiting proposals when the agent process ends', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    await waiting(service);
    service.withdrawPending("The agent's process ended.");
    expect([await call, latest(service)?.status]).toEqual([
      { ok: true, value: { status: 'rejected', feedback: "The agent's process ended." } },
      'withdrawn',
    ]);
  });

  it('runs steps one at a time and marks the plan done after the last one', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    await waiting(service);
    service.answer('plan-1', 1, { kind: 'approve' });
    await call;
    expect(service.step({ key: 'zzz', phase: 'start' })).toEqual({ ok: false, error: 'IDE: plan plan-1 has no step "zzz". Its steps: a, b.' });
    expect(service.step({ key: 'b', phase: 'done' })).toEqual({ ok: false, error: 'IDE: step "b" is not active; start it first.' });
    expect(service.step({ key: 'a', phase: 'start' })).toEqual({ ok: true });
    expect(service.step({ key: 'b', phase: 'start' })).toEqual({ ok: true });
    expect(service.step({ key: 'a', phase: 'start' })).toEqual({ ok: false, error: 'IDE: step "a" is already done.' });
    service.step({ key: 'b', phase: 'start' });
    service.step({ key: 'b', phase: 'done' });
    expect([latest(service)?.status, service.gate()]).toEqual(['done', { state: 'done', planId: 'plan-1' }]);
  });

  it('refuses steps before any plan is approved', async () => {
    const { service } = await setup();
    expect(service.step({ key: 'edit', phase: 'start' })).toEqual({ ok: false, error: 'IDE: no plan is approved. Call mcp__idecore__propose_plan first and wait for its result.' });
  });

  it('expands the active step with out-of-scope files as a new version approved by the user', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    expect(service.canExpand()).toBe(true);
    const expanded = service.expand([{ rel: 'src/other.ts', exists: true, dir: false }, { rel: 'src/lib/new.ts', exists: false, dir: false }]);
    expect(expanded).toMatchObject({
      version: 2, status: 'approved', approvedBy: 'user-expand',
      steps: [{ key: 'edit', targets: [{ path: 'src/app.ts', op: 'modify' }, { path: 'src/other.ts', op: 'modify' }, { path: 'src/lib/new.ts', op: 'create' }] }],
    });
    expect(service.gate()).toMatchObject({ version: 2, scope: { paths: ['src/app.ts', 'src/lib/new.ts', 'src/other.ts'], globs: [] } });
  });

  it('expands a deleted path with op delete and grows the deletes of the scope', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    const expanded = service.expand([{ rel: 'src/app.ts', exists: true, dir: false, deleted: true }, { rel: 'src/other.ts', exists: true, dir: false, deleted: true }]);
    expect(expanded.steps[0]!.targets).toEqual([{ path: 'src/app.ts', op: 'modify' }, { path: 'src/app.ts', op: 'delete' }, { path: 'src/other.ts', op: 'delete' }]);
    expect(expanded.scope.deletes).toEqual({ paths: ['src/app.ts', 'src/other.ts'], globs: [] });
    expect(covers(expanded.scope, { rel: 'src/app.ts', dir: false, mkdir: false, deleting: true })).toBe(true);
  });

  it('expands into a directory, escaping glob metacharacters, and covers a new mkdir target', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    const expanded = service.expand([
      { rel: 'src/[id]', exists: true, dir: true },
      { rel: 'src/newdir', exists: false, dir: true },
    ]);
    expect(expanded.scope.globs).toEqual(['src/[[]id[]]/**', 'src/newdir/**']);
    expect(covers(expanded.scope, { rel: 'src/i/x.ts', dir: false, mkdir: false })).toBe(false);
    expect(covers(expanded.scope, { rel: 'src/newdir', dir: false, mkdir: true })).toBe(true);
  });

  it('does not offer to expand while an agent-proposed version waits', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.step({ key: 'edit', phase: 'start' });
    void service.propose({ ...small, steps: [...small.steps, { key: 'b', title: 'B', rationale: '', targets: [{ componentId: 'lib', op: 'modify' }] }] });
    await waiting(service);
    expect(service.canExpand()).toBe(false);
    expect(() => service.expand([{ rel: 'src/other.ts', exists: true, dir: false }])).toThrow(PlanError);
  });

  it('withdraws a proposal left waiting by a previous core and keeps an approved plan enforced', async () => {
    const setupResult = await setup();
    await setupResult.service.propose(small);
    void setupResult.service.propose(big);
    await waiting(setupResult.service);
    const next = setupResult.restart();
    expect(next.plans().map((plan) => [plan.version, plan.status])).toEqual([[1, 'approved'], [2, 'withdrawn']]);
    expect(next.gate()).toMatchObject({ state: 'approved', version: 1 });
  });

  it('starts a step of an approved plan after a core restart', async () => {
    const { service, restart } = await setup();
    await service.propose(small);
    const next = restart();
    expect(next.step({ key: 'edit', phase: 'start' })).toEqual({ ok: true });
  });

  it('starts a new session with no plan', async () => {
    const { service, setSession } = await setup();
    await service.propose(small);
    setSession('s2');
    expect([service.plans(), service.gate()]).toEqual([[], { state: 'none' }]);
  });

  describe('when a plan listener throws', () => {
    const throwing = (service: PlanService, when: (plans: PlanView[]) => boolean = () => true) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errors.mockRestore());
      service.onChange((plans) => {
        if (when(plans)) throw new Error('listener failed');
      });
      return errors;
    };

    it('still answers the waiting call on approve, and logs', async () => {
      const { service } = await setup();
      const call = service.propose(big);
      const plan = await waiting(service);
      const errors = throwing(service);
      service.answer(plan.id, plan.version, { kind: 'approve' });
      expect(await call).toEqual({ ok: true, value: { status: 'approved' } });
      expect(errors).toHaveBeenCalledWith('plans: a plan listener threw', expect.any(Error));
    });

    it('still answers the waiting call on a request for changes', async () => {
      const { service } = await setup();
      const call = service.propose(big);
      const plan = await waiting(service);
      throwing(service);
      service.answer(plan.id, plan.version, { kind: 'changes', feedback: 'smaller' });
      expect(await call).toEqual({ ok: true, value: { status: 'changes_requested', feedback: 'smaller' } });
    });

    it('still answers the waiting call on Reject', async () => {
      const { service } = await setup();
      const call = service.propose(big);
      const plan = await waiting(service);
      throwing(service);
      service.answer(plan.id, plan.version, { kind: 'reject', feedback: '' });
      expect(await call).toEqual({ ok: true, value: { status: 'rejected' } });
    });

    it('still answers the waiting call when the deadline passes', async () => {
      const { service } = await setup({ deadlineMs: 50 });
      throwing(service, (plans) => plans.some((plan) => plan.status === 'withdrawn'));
      expect(await service.propose(big)).toEqual({
        ok: true, value: { status: 'rejected', feedback: "The user did not answer within 59 minutes. Stop and wait for the user's next message." },
      });
    });

    it('still returns the expanded version', async () => {
      const { service } = await setup();
      await service.propose(small);
      service.step({ key: 'edit', phase: 'start' });
      throwing(service);
      expect(service.expand([{ rel: 'src/other.ts', exists: true, dir: false }])).toMatchObject({ version: 2, status: 'approved' });
    });
  });

  it('returns the validation error for an unknown component', async () => {
    const { service } = await setup();
    expect(await service.propose({ goal: 'g', steps: [{ key: 'k', title: 't', targets: [{ componentId: 'nope', op: 'modify' }] }] }))
      .toEqual({ ok: false, error: 'IDE: step "k" names an unknown component "nope". Valid component ids: app (App), lib (Lib).' });
  });
});
