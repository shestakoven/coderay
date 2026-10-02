import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { Baselines } from '../../src/history/baselines';
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
import { sessionRecord, tempDir, waitFor } from '../helpers';
import { isolateGit, projectWithWorktree } from '../worktree-fixture';

isolateGit();

const WT = '.worktrees/wt1';
const A = `${WT}/backend/src/a.py`;
const SCRATCH = `${WT}/scratch.txt`;
const PLAN = {
  goal: 'Edit in the worktree',
  steps: [{ key: 's1', title: 's1', rationale: '', targets: [{ path: 'backend/src/a.py', op: 'modify' }, { path: 'scratch.txt', op: 'modify' }] }],
};

async function fixture() {
  const { root } = await projectWithWorktree();
  const store = openStore(tempDir('rbwt-store-'));
  store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(tempDir('rbwt-shadow-'));
  const baselines = new Baselines(store);
  const clock = { now: 1000 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  const ideWrites = new IdeWrites();
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => [],
    review: (steps) => reviewPlan(steps, { root, policy: DEFAULT_POLICY, components: [], tempRoots: [] }),
  });
  const checkpoints = new Checkpoints(store, () => 's1');
  plans.onStep((e) => {
    if (e.phase === 'start') checkpoints.begin(e.planId, e.key);
    if (e.phase === 'done') checkpoints.seal(e.planId, e.key);
  });
  const changes = new ChangeService({ root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger, store, checkpoints, sessionId: () => 's1', plans });
  const reverts = new RevertService({
    root, shadow, baselines, ideWrites, changes, store, sessionId: () => 's1',
    steps: { checkpoints, plans, isIdle: () => true, watchdogPending: () => false, queueNote: () => undefined },
  });
  const approve = async (): Promise<string> => {
    const call = plans.propose(PLAN);
    const waiting = await waitFor(() => plans.plans().find((p: PlanView) => p.status === 'proposed'), 'the plan proposed');
    plans.answer(waiting.id, waiting.version, { kind: 'approve' });
    await call;
    return waiting.id;
  };
  const edit = async (key: string, edits: { rel: string; text: string }[]): Promise<void> => {
    clock.now += 60_000;
    plans.step({ key, phase: 'start' });
    for (const [i, { rel, text }] of edits.entries()) {
      const toolUseId = `tool-${i}`;
      const call: ToolCall = { toolUseId, parentToolUseId: null, tool: 'Write', toolClass: 'file-writer', targets: [rel], allTracked: false, cwdRel: null, background: false, allowedOnce: false };
      ledger.allowed(call);
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
      await changes.handle({ rel, exists: true, at: clock.now, wall: Date.now() });
      ledger.ended(toolUseId);
    }
    plans.step({ key, phase: 'done' });
    clock.now += 60_000;
  };
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  return { root, approve, edit, read, reverts, changes };
}

describe('step rollback for files of a nested worktree', () => {
  it('rolls a tracked file back to its git version and refuses a file whose previous content is not known, leaving it on disk', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, SCRATCH), 'was here before\n');
    const planId = await f.approve();
    await f.edit('s1', [{ rel: SCRATCH, text: 'agent wrote this\n' }, { rel: A, text: 'a = 2\n' }]);
    const preview = await f.reverts.previewStepRollback(planId, 's1');
    expect(preview).toMatchObject({ allowed: true, autoFiles: [A], confirmFiles: [], notRolledBack: [], conflicts: [{ path: SCRATCH, reason: 'the previous content is not known' }] });
    const record = await f.reverts.rollbackStep(planId, 's1', []);
    expect(record.files.map((file) => [file.path, file.outcome, file.reason])).toEqual([
      [A, 'restored', null], [SCRATCH, 'conflict', 'the previous content is not known'],
    ]);
    expect([f.read(A), existsSync(join(f.root, SCRATCH)), f.read(SCRATCH)]).toEqual(['a = 1\n', true, 'agent wrote this\n']);
  });

  it('still deletes a file the agent created in the worktree after its first sight when the step is rolled back', async () => {
    const f = await fixture();
    const planId = await f.approve();
    await f.edit('s1', [{ rel: A, text: 'a = 2\n' }, { rel: SCRATCH, text: 'agent created this\n' }]);
    const record = await f.reverts.rollbackStep(planId, 's1', []);
    expect(record.files.map((file) => [file.path, file.outcome])).toEqual([[A, 'restored'], [SCRATCH, 'deleted']]);
    expect([f.read(A), existsSync(join(f.root, SCRATCH))]).toEqual(['a = 1\n', false]);
  });
});
