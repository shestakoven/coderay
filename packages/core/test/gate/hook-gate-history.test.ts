import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ControlMode } from '@ide/protocol';
import { HookGate } from '../../src/gate/hook-gate';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';
import { git, isolateGit } from '../worktree-fixture';

isolateGit();

const components: ComponentRef[] = [{ id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] }];

async function setup(mode: ControlMode) {
  const root = tempDir('hist-root-');
  git(root, 'init', '-q');
  await writeTree(root, { 'src/app.ts': 'a', 'src/other.ts': 'b', 'README.md': 'readme' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const store = openStore(tempDir('hist-store-'));
  onTestFinished(() => store.close());
  store.saveSession(sessionRecord('s1', root));
  const policy = { ...DEFAULT_POLICY, mode };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home: tempDir('hist-home-'), tempRoots: [] }),
  });
  const gate = new HookGate({
    root, store, sessionId: () => 's1', policy: () => policy, plans, components: () => components,
    context: () => ({ parentToolUseId: null, lastMessage: 'Moving history.' }), home: tempDir('hist-home-'), tempRoots: [],
  });
  const bash = (command: string, cwd = root, id = `toolu_${command.length}_${cwd.length}`) =>
    gate.evaluate({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, cwd }, new AbortController().signal);
  await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
  plans.step({ key: 'edit', phase: 'start' });
  const pending = () => waitFor(() => gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt shown');
  return { root, gate, bash, pending };
}

describe('HookGate for a command that moves history, under a plan without **', () => {
  it('asks only about a dirty tracked file outside the plan, named from the repository top even when run from a subdirectory', async () => {
    const { root, bash, pending, gate } = await setup('B');
    const src = join(root, 'src');
    expect((await bash('git rebase main', src))?.permissionDecision).toBe('allow');
    writeFileSync(join(root, 'src/app.ts'), 'dirty');
    expect((await bash('git rebase main', src))?.permissionDecision).toBe('allow');
    writeFileSync(join(root, 'README.md'), 'dirty');
    const answer = bash('git rebase main', src);
    const prompt = await pending();
    expect(prompt.targets.filter((target) => !target.inScope).map((target) => [target.path, target.uncommitted])).toEqual([['README.md', true]]);
    gate.answer(prompt.id, 'deny');
    expect((await answer)?.permissionDecision).toBe('deny');
  });

  it('falls back to every tracked file when no repository is named by a directory, or git cannot report a status there', async () => {
    const { bash } = await setup('A');
    for (const command of ['git --git-dir=.git rebase main', 'git -C missing-dir rebase main']) {
      const result = await bash(command);
      expect([command, result?.permissionDecision, result?.permissionDecisionReason]).toEqual([command, 'deny', expect.stringContaining('every tracked file')]);
    }
  });
});
