import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ControlMode, PlanTarget } from '@ide/protocol';
import { HookGate } from '../../src/gate/hook-gate';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore, type ToolDecisionRecord } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor } from '../helpers';
import { git, isolateGit, projectWithWorktree } from '../worktree-fixture';

isolateGit();

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

const WT = '.worktrees/wt1';

async function setup(mode: ControlMode = 'B') {
  const { root } = await projectWithWorktree({ 'src/app.ts': 'a', 'src/other.ts': 'b', 'src/lib/util.ts': 'c' });
  const home = tempDir('ide-fake-home-');
  const store = openStore(tempDir('ide-store-'));
  onTestFinished(() => store.close());
  store.saveSession(sessionRecord('s1', root));
  const policy = { ...DEFAULT_POLICY, mode };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home, tempRoots: [] }),
  });
  const gate = new HookGate({
    root, store, sessionId: () => 's1', policy: () => policy, plans, components: () => components,
    context: () => ({ parentToolUseId: null, lastMessage: 'Fixing the greeting.' }), home, tempRoots: [],
  });
  const decisions: ToolDecisionRecord[] = [];
  gate.onDecision((decision) => decisions.push(decision));
  const bash = (command: string, id = 'toolu_b', cwd = root) => gate.evaluate({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, cwd }, new AbortController().signal);
  const write = (rel: string, id = 'toolu_1') => gate.evaluate({ tool_name: 'Write', tool_input: { file_path: join(root, rel), content: 'x' }, tool_use_id: id, cwd: root }, new AbortController().signal);
  const approve = async (targets: PlanTarget[] = [{ path: 'src/app.ts', op: 'modify' }]) => {
    await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets }] });
    plans.step({ key: 'edit', phase: 'start' });
  };
  const approveReviewed = async (targets: PlanTarget[]) => {
    const proposed = plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets }] });
    const waiting = await waitFor(() => plans.plans().find((plan) => plan.status === 'proposed'), 'the plan proposed');
    plans.answer(waiting.id, waiting.version, { kind: 'approve' });
    await proposed;
    plans.step({ key: 'edit', phase: 'start' });
  };
  const pending = () => waitFor(() => gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt shown');
  return { root, plans, gate, decisions, write, bash, approve, approveReviewed, pending };
}

describe('HookGate for a file of a nested worktree', () => {
  it('allows a write that the plan covers by the path inside the worktree and records the plan and the step', async () => {
    const { write, approve, decisions } = await setup();
    await approve();
    expect((await write(`${WT}/src/app.ts`))?.permissionDecision).toBe('allow');
    expect(decisions.at(-1)).toMatchObject({ decision: 'allow', planVersion: 1, stepKey: 'edit' });
  });

  it('denies a write to a file of the worktree that the plan does not cover, and a write before any plan', async () => {
    const { write, approve } = await setup('A');
    expect((await write(`${WT}/src/other.ts`))?.permissionDecision).toBe('deny');
    await approve();
    expect((await write(`${WT}/src/other.ts`, 'toolu_2'))?.permissionDecision).toBe('deny');
  });

  it('asks about an out-of-scope file of the worktree and names the component that owns it by its path inside the worktree', async () => {
    const { write, approve, pending, gate } = await setup();
    await approve();
    const answer = write(`${WT}/src/other.ts`);
    const prompt = await pending();
    expect(prompt.targets).toMatchObject([{ path: `${WT}/src/other.ts`, kind: 'enforced', inScope: false, componentId: 'app' }]);
    gate.answer(prompt.id, 'deny');
    expect((await answer)?.permissionDecision).toBe('deny');
  });

  it('expands the plan with the path inside the worktree, and then allows the same write under the new version', async () => {
    const { write, approve, pending, gate, plans } = await setup();
    await approve();
    const answer = write(`${WT}/src/other.ts`);
    gate.answer((await pending()).id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(plans.gate()).toMatchObject({ version: 2, scope: { paths: ['src/app.ts', 'src/other.ts'] } });
    expect((await write(`${WT}/src/other.ts`, 'toolu_2'))?.permissionDecision).toBe('allow');
  });

  it('says no component owns the directory of a new file by the path inside the worktree', async () => {
    const { write, approve } = await setup('A');
    await approve();
    const unowned = await write(`${WT}/docs/notes.md`);
    const owned = await write(`${WT}/src/lib/new.ts`, 'toolu_2');
    expect(unowned?.permissionDecisionReason).toContain('no component owns this directory');
    expect([owned?.permissionDecision, owned?.permissionDecisionReason]).toEqual(['deny', expect.not.stringContaining('no component owns')]);
  });

  it('lets a write to a file the worktree ignores through without a plan', async () => {
    const { write } = await setup();
    expect((await write(`${WT}/dist/x.js`))?.permissionDecision).toBe('allow');
  });
});

describe('HookGate for a worktree inside a directory the plan covers', () => {
  const LIB = [{ componentId: 'lib', op: 'modify' }] as PlanTarget[];

  it('denies a file of the worktree that the plan covers only by its real path, and allows one its inner path covers', async () => {
    const { root, write, approveReviewed: approve } = await setup('A');
    git(root, 'worktree', 'add', '-q', 'src/lib/wt');
    await approve(LIB);
    expect((await write('src/lib/wt/package.json'))?.permissionDecision).toBe('deny');
    expect((await write('src/lib/wt/src/lib/y.ts', 'toolu_2'))?.permissionDecision).toBe('allow');
    expect((await write('src/lib/z.ts', 'toolu_3'))?.permissionDecision).toBe('allow');
  });

  it('asks about it, naming the real path, and expands the plan with the inner path', async () => {
    const { root, write, approveReviewed: approve, pending, gate, plans } = await setup();
    git(root, 'worktree', 'add', '-q', 'src/lib/wt');
    await approve(LIB);
    const answer = write('src/lib/wt/package.json');
    const prompt = await pending();
    expect(prompt.targets).toMatchObject([{ path: 'src/lib/wt/package.json', inScope: false }]);
    gate.answer(prompt.id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    const scope = (plans.gate() as { scope: { paths: string[] } }).scope;
    expect([scope.paths.includes('package.json'), scope.paths.some((path) => path.startsWith('src/lib/wt'))]).toEqual([true, false]);
    expect((await write('src/lib/wt/package.json', 'toolu_2'))?.permissionDecision).toBe('allow');
  });

  it('judges a file of a clone by its real path, which a plan over the component does not cover, and a worktree next to it by its inner one', async () => {
    const { root, write, approveReviewed: approve } = await setup('A');
    git(root, 'clone', '-q', root, 'deps/foo');
    git(root, 'worktree', 'add', '-q', 'deps/wt');
    await approve(LIB);
    expect((await write('deps/foo/src/lib/x.ts'))?.permissionDecision).toBe('deny');
    expect((await write('deps/wt/src/lib/x.ts', 'toolu_2'))?.permissionDecision).toBe('allow');
  });

  it('lets a file of a clone the project ignores through, as any ignored file', async () => {
    const { root, write, approveReviewed: approve } = await setup('A');
    git(root, 'clone', '-q', root, '.worktrees/clone1');
    await approve(LIB);
    expect((await write('.worktrees/clone1/src/other.ts'))?.permissionDecision).toBe('allow');
  });

  it('expands the deletes of the plan with the glob of the directory by its path inside the worktree', async () => {
    const { bash, approveReviewed: approve, pending, gate, plans } = await setup();
    await approve([{ path: 'src/app.ts', op: 'modify' }, { path: 'src/other.ts', op: 'delete' }]);
    const answer = bash(`rm -r ${WT}/src/lib`);
    const prompt = await pending();
    expect(prompt.targets).toMatchObject([{ path: `${WT}/src/lib`, inScope: false, deleting: true }]);
    gate.answer(prompt.id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(plans.gate()).toMatchObject({ scope: { deletes: { globs: ['src/lib/**'] } } });
  });
});

describe('HookGate for a git command that rewrites the work tree', () => {
  it.each([
    ['in the worktree', 'git restore .', WT],
    ['named by -C relative to the project', `git -C ${WT} restore .`, '.'],
    ['named by an absolute -C', 'git -C ABS restore .', 'src'],
  ])('lets one that runs %s through a plan that does not cover the whole project', async (_where, command, cwd) => {
    const { root, bash, approve } = await setup('A');
    await approve();
    const result = await bash(command.replace('ABS', join(root, WT)), 'toolu_b', join(root, cwd));
    expect(result?.permissionDecision).toBe('allow');
  });

  it.each([
    ['in the project root', 'git restore .', '.'],
    ['in a directory of the project that is not a worktree', 'git restore .', 'src'],
    ['next to one in the worktree', `git -C ${WT} restore . && git clean -f`, '.'],
    ['in the worktree, then in the project', `git restore . && git -C ../.. clean -f`, WT],
    ['against a repository that the command does not name by a directory', 'git --work-tree ../.. restore .', WT],
  ])('asks for the whole project for one that runs %s', async (_where, command, cwd) => {
    const { root, bash, approve } = await setup('A');
    await approve();
    const result = await bash(command, 'toolu_b', join(root, cwd));
    expect([result?.permissionDecision, result?.permissionDecisionReason]).toEqual(['deny', expect.stringContaining('every tracked file')]);
  });
});
