import { execFileSync } from 'node:child_process';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { PlanView, Policy } from '@ide/protocol';
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
      scope: { paths: ['src/app.ts', 'src/lib/util.ts', 'src/other.ts'], globs: ['src/lib/**'] },
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

  it('closes a rejected plan: writes are denied as rejected and the next proposal starts a new plan', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    const plan = await waiting(service);
    service.answer(plan.id, 1, { kind: 'reject', feedback: '' });
    expect(await call).toEqual({ ok: true, value: { status: 'rejected' } });
    expect(service.gate()).toEqual({ state: 'rejected', planId: 'plan-1' });
    await service.propose(small);
    expect(latest(service)).toMatchObject({ id: 'plan-2', version: 1 });
  });

  it('revokes an automatically approved plan on Reject without any call waiting', async () => {
    const { service } = await setup();
    await service.propose(small);
    service.answer('plan-1', 1, { kind: 'reject', feedback: 'not now' });
    expect([latest(service)?.status, latest(service)?.feedback, service.gate()]).toEqual(['rejected', 'not now', { state: 'rejected', planId: 'plan-1' }]);
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
    await call;
    expect(latest(service)?.status).toBe('withdrawn');
  });

  it('answers rejected and withdraws the plan when the user does not answer in time', async () => {
    const { service } = await setup({ deadlineMs: 50 });
    expect(await service.propose(big)).toEqual({
      ok: true, value: { status: 'rejected', feedback: "The user did not answer within 59 minutes. Stop and wait for the user's next message." },
    });
    expect(latest(service)?.status).toBe('withdrawn');
  });

  it('withdraws waiting proposals when the agent process ends', async () => {
    const { service } = await setup();
    const call = service.propose(big);
    await waiting(service);
    service.withdrawPending("The agent's process ended.");
    expect([(await call).ok, latest(service)?.status]).toEqual([true, 'withdrawn']);
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
    expect(service.step({ key: 'b', phase: 'start' })).toEqual({ ok: false, error: 'IDE: step "a" is still active; mark it done first.' });
    expect(service.step({ key: 'a', phase: 'done' })).toEqual({ ok: true });
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

  it('starts a new session with no plan', async () => {
    const { service, setSession } = await setup();
    await service.propose(small);
    setSession('s2');
    expect([service.plans(), service.gate()]).toEqual([[], { state: 'none' }]);
  });

  it('returns the validation error for an unknown component', async () => {
    const { service } = await setup();
    expect(await service.propose({ goal: 'g', steps: [{ key: 'k', title: 't', targets: [{ componentId: 'nope', op: 'modify' }] }] }))
      .toEqual({ ok: false, error: 'IDE: step "k" names an unknown component "nope". Valid component ids: app (App), lib (Lib).' });
  });
});
