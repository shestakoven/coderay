import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rollbackMessage } from '../../src/watchdog/resume';
import type { PlanView } from '@ide/protocol';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { RevertError, RevertService } from '../../src/history/revert';
import { ShadowRepo } from '../../src/history/shadow';
import { reviewPlan } from '../../src/plans/freeze';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger } from '../../src/watchdog/activity';
import type { ToolCall } from '../../src/watchdog/activity';
import type { FsEvent } from '../../src/watchdog/watcher';
import { sessionRecord, tempDir } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const put = (root: string, rel: string, text: string, mode?: number): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mode !== undefined) chmodSync(join(root, rel), mode);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Write', toolClass: 'file-writer', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});

type Edit = { rel: string; text: string | null; by?: 'agent' | 'tool' };

const PLAN = {
  goal: 'Rollback',
  steps: ['s1', 's2', 's3'].map((key) => ({ key, title: key, rationale: '', targets: [{ path: `${key}.ts`, op: 'modify' }] })),
};

async function fixture() {
  const root = tempDir('rb-root-');
  sh(root, 'init', '-q');
  put(root, '.gitignore', 'dist/\n');
  for (const [rel, text] of Object.entries({ 'a.ts': 'a-original', 'b.ts': 'b-original', 'c.ts': 'c-original', 'run.sh': 'echo' })) put(root, rel, text, rel === 'run.sh' ? 0o755 : undefined);
  symlinkSync('a.ts', join(root, 'link.ts'));
  sh(root, 'add', '-A');
  const storeDir = tempDir('rb-store-');
  const store = openStore(storeDir);
  store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(tempDir('rb-shadow-'));
  const ideWrites = new IdeWrites();
  const clock = { now: 1000 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  const env = { idle: true, pending: false };
  const notes: string[] = [];
  let toolCount = 0;
  let planCount = 0;
  const boot = async (seed: boolean) => {
    const baselines = new Baselines(store);
    if (seed) await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const plans = new PlanService({
      root, store, sessionId: () => 's1', components: () => [], newId: () => `plan-${(planCount += 1)}`,
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
      steps: { checkpoints, plans, isIdle: () => env.idle, watchdogPending: () => env.pending, queueNote: (t) => notes.push(t) },
    });
    return { plans, checkpoints, changes, reverts };
  };
  const state = await boot(true);
  const feed = async (rel: string): Promise<void> => {
    const ev: FsEvent = { rel, exists: existsSync(join(root, rel)), at: clock.now, wall: Date.now() };
    await state.changes.handle(ev);
  };
  const approve = async (input: unknown = PLAN): Promise<void> => {
    const call = state.plans.propose(input);
    await new Promise((r) => setTimeout(r, 20));
    const waiting = state.plans.plans().find((p: PlanView) => p.status === 'proposed');
    if (waiting) state.plans.answer(waiting.id, waiting.version, { kind: 'approve' });
    await call;
  };
  const stepWork = async (key: string, edits: Edit[], finish = true): Promise<void> => {
    clock.now += 60_000;
    expect(state.plans.step({ key, phase: 'start' })).toEqual({ ok: true });
    for (const edit of edits) {
      toolCount += 1;
      const id = `tool-${toolCount}`;
      ledger.allowed(call(edit.by === 'tool' ? { toolUseId: id, tool: 'Bash', toolClass: 'shell' } : { toolUseId: id, targets: [edit.rel] }));
      if (edit.text === null) rmSync(join(root, edit.rel), { force: true });
      else put(root, edit.rel, edit.text);
      await feed(edit.rel);
      ledger.ended(id);
    }
    if (finish) expect(state.plans.step({ key, phase: 'done' })).toEqual({ ok: true });
    clock.now += 60_000;
  };
  const human = async (rel: string, text: string | null): Promise<void> => {
    clock.now += 60_000;
    if (text === null) rmSync(join(root, rel), { force: true });
    else put(root, rel, text);
    await feed(rel);
  };
  const restart = async (): Promise<void> => { Object.assign(state, await boot(false)); };
  return {
    root, store, env, notes, approve, stepWork, human, feed, restart, clock,
    get plans() { return state.plans; }, get reverts() { return state.reverts; }, get changes() { return state.changes; }, get checkpoints() { return state.checkpoints; },
  };
}

describe('step rollback', () => {
  it('previews auto, confirm and not-rolled-back files', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [
      { rel: 'a.ts', text: 'a-new' },
      { rel: 'b.ts', text: 'b-new', by: 'tool' },
      { rel: 'dist/out.js', text: 'built', by: 'tool' },
      { rel: '.omc/state.json', text: '{}', by: 'tool' },
    ]);
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview).toMatchObject({ planId: 'plan-1', stepKey: 's1', allowed: true, reason: null, autoFiles: ['a.ts'], confirmFiles: ['b.ts'], conflicts: [] });
    expect(preview.notRolledBack.map((n) => n.path).sort()).toEqual(['.omc/state.json', 'dist/out.js']);
    expect(preview.notRolledBack.every((n) => n.why.length > 0)).toBe(true);
  });

  it('puts .git/HEAD in notRolledBack and never writes it', async () => {
    const f = await fixture();
    await f.approve();
    const head = read(f.root, '.git/HEAD');
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: '.git/HEAD', text: 'ref: refs/heads/other\n' }]);
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview.notRolledBack).toContainEqual({ path: '.git/HEAD', why: 'git state is never rolled back' });
    expect(preview.autoFiles).toEqual(['a.ts']);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, '.git/HEAD')).toBe('ref: refs/heads/other\n');
    expect(read(f.root, 'a.ts')).toBe('a-original');
    expect(head).not.toBe('ref: refs/heads/other\n');
  });

  it('restores an agent-only file and deletes a file the step created', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: 'fresh.ts', text: 'created' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-original');
    expect(existsSync(join(f.root, 'fresh.ts'))).toBe(false);
    expect(record).toMatchObject({ kind: 'step', planId: 'plan-1', stepKey: 's1', eventId: null, undoneAt: null });
    expect(record.files).toEqual([
      { path: 'a.ts', outcome: 'restored', reason: null },
      { path: 'fresh.ts', outcome: 'deleted', reason: null },
    ]);
    expect(f.reverts.reverts()).toEqual([record]);
  });

  it('recreates a file the step deleted with its mode', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'run.sh', text: null }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(record.files).toEqual([{ path: 'run.sh', outcome: 'recreated', reason: null }]);
    expect(read(f.root, 'run.sh')).toBe('echo');
    expect(statSync(join(f.root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('restores a confirmation file only when it is confirmed', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: 'b.ts', text: 'b-new', by: 'tool' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-original');
    expect(read(f.root, 'b.ts')).toBe('b-new');
    expect(record.files).toContainEqual({ path: 'b.ts', outcome: 'not-rolled-back', reason: 'not confirmed' });

    const g = await fixture();
    await g.approve();
    await g.stepWork('s1', [{ rel: 'b.ts', text: 'b-new', by: 'tool' }]);
    const confirmed = await g.reverts.rollbackStep('plan-1', 's1', ['b.ts']);
    expect(read(g.root, 'b.ts')).toBe('b-original');
    expect(confirmed.files).toEqual([{ path: 'b.ts', outcome: 'restored', reason: null }]);
  });

  it('ignores a confirmation that names a file that is not a confirmation file', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: 'b.ts', text: 'b-new', by: 'tool' }]);
    await f.reverts.rollbackStep('plan-1', 's1', ['c.ts', 'nope.ts']);
    expect(read(f.root, 'c.ts')).toBe('c-original');
    expect(read(f.root, 'b.ts')).toBe('b-new');
  });

  it('leaves a file the user edited after the step untouched and reports the conflict', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: 'b.ts', text: 'b-new' }]);
    await f.human('a.ts', 'user edit');
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview.conflicts).toEqual([{ path: 'a.ts', reason: "changed again after the agent's change" }]);
    expect(preview.autoFiles).toEqual(['b.ts']);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('user edit');
    expect(read(f.root, 'b.ts')).toBe('b-original');
    expect(record.files).toContainEqual({ path: 'a.ts', outcome: 'conflict', reason: "changed again after the agent's change" });
  });

  it('conflicts when the user restored the exact agent content afterwards (a later change exists)', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    await f.human('a.ts', 'user edit');
    await f.human('a.ts', 'a-new');
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-new');
    expect(record.files[0]).toMatchObject({ path: 'a.ts', outcome: 'conflict' });
  });

  it('leaves a file a later step changed untouched', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-step1' }]);
    await f.stepWork('s2', [{ rel: 'a.ts', text: 'a-step2' }, { rel: 'a.ts', text: 'a-step1' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-step1');
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: "changed again after the agent's change" }]);
  });

  it('restores a file changed twice by the same step to its content from before the step', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'first' }, { rel: 'a.ts', text: 'second' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-original');
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
  });

  it('conflicts when the file the step deleted exists again', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: null }]);
    put(f.root, 'a.ts', 'someone recreated me');
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('someone recreated me');
    expect(record.files[0]).toMatchObject({ outcome: 'conflict' });
  });

  it('never overwrites when the file changes between the check and the write', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    const real = (f.reverts as unknown as { o: { beforeCommit?: (rel: string) => Promise<void> } }).o;
    real.beforeCommit = async (rel) => { put(f.root, rel, 'raced user edit'); };
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('raced user edit');
    expect(record.files[0]).toMatchObject({ path: 'a.ts', outcome: 'conflict' });
  });

  it('reports a symlink the step replaced as a conflict and does not touch it', async () => {
    const f = await fixture();
    await f.approve();
    rmSync(join(f.root, 'link.ts'));
    await f.stepWork('s1', [{ rel: 'link.ts', text: 'now a regular file' }, { rel: 'b.ts', text: 'b-new' }]);
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview.conflicts).toEqual([{ path: 'link.ts', reason: 'cannot restore a symlink' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(record.files).toContainEqual({ path: 'link.ts', outcome: 'conflict', reason: 'cannot restore a symlink' });
    expect(read(f.root, 'link.ts')).toBe('now a regular file');
    expect(read(f.root, 'b.ts')).toBe('b-original');
  });

  it('rolls back a step that changed nothing and resets it', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', []);
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview).toMatchObject({ allowed: true, autoFiles: [], confirmFiles: [], notRolledBack: [], conflicts: [] });
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(record.files).toEqual([]);
    expect(f.plans.stepStates()['plan-1']).toEqual({ s1: 'pending' });
  });

  it('allows a rollback of an active step (the agent is idle between turns)', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }], false);
    expect((await f.reverts.previewStepRollback('plan-1', 's1')).allowed).toBe(true);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'a.ts')).toBe('a-original');
    expect(f.plans.stepStates()['plan-1']).toEqual({ s1: 'pending' });
    expect(f.plans.gate()).toMatchObject({ state: 'approved', activeStep: null });
  });

  it('refuses a step that has not run', async () => {
    const f = await fixture();
    await f.approve();
    expect(await f.reverts.previewStepRollback('plan-1', 's2')).toMatchObject({ allowed: false, reason: 'this step has not run' });
    await expect(f.reverts.rollbackStep('plan-1', 's2', [])).rejects.toThrow(RevertError);
  });

  it('refuses an unknown step key and an unknown plan', async () => {
    const f = await fixture();
    await f.approve();
    await expect(f.reverts.previewStepRollback('plan-1', 'nope')).rejects.toThrow('unknown step');
    await expect(f.reverts.rollbackStep('plan-9', 's1', [])).rejects.toThrow('unknown step');
  });

  it.each([
    ['agent busy', 'the agent is still working'],
    ['event pending', 'a watchdog question is open'],
  ])('refuses a rollback: %s', async (name, reason) => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    if (name === 'agent busy') f.env.idle = false;
    else f.env.pending = true;
    expect(await f.reverts.previewStepRollback('plan-1', 's1')).toMatchObject({ allowed: false, reason });
    await expect(f.reverts.rollbackStep('plan-1', 's1', [])).rejects.toThrow(reason);
    expect(read(f.root, 'a.ts')).toBe('a-new');
    expect(f.plans.stepStates()['plan-1']?.s1).toBe('done');
    expect(f.notes).toEqual([]);
    expect(f.reverts.reverts()).toEqual([]);
  });

  it('refuses a rollback: old version (a step of an earlier plan)', async () => {
    const f = await fixture();
    await f.approve({ goal: 'One', steps: [PLAN.steps[0]] });
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    await f.approve({ goal: 'Two', steps: [PLAN.steps[1]] });
    const reason = 'this step belongs to an older version of the plan';
    expect(await f.reverts.previewStepRollback('plan-1', 's1')).toMatchObject({ allowed: false, reason });
    await expect(f.reverts.rollbackStep('plan-1', 's1', [])).rejects.toThrow(reason);
    expect(read(f.root, 'a.ts')).toBe('a-new');
    expect(f.notes).toEqual([]);
  });

  it('refuses a rollback: old version (a step the latest version dropped)', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    await f.approve({ goal: 'Rollback', steps: PLAN.steps.slice(0, 2) });
    expect(f.plans.plans().at(-1)?.version).toBe(2);
    expect(await f.reverts.previewStepRollback('plan-1', 's3')).toMatchObject({ allowed: false, reason: 'this step belongs to an older version of the plan' });
    expect((await f.reverts.previewStepRollback('plan-1', 's1')).allowed).toBe(true);
  });

  it('puts the step back to pending and reopens a done plan', async () => {
    const f = await fixture();
    await f.approve({ goal: 'One', steps: [PLAN.steps[0]] });
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    expect(f.plans.gate()).toMatchObject({ state: 'done' });
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(f.plans.stepStates()['plan-1']).toEqual({ s1: 'pending' });
    expect(f.plans.gate()).toMatchObject({ state: 'approved', planId: 'plan-1', activeStep: null });
    expect(f.plans.plans().at(-1)).toMatchObject({ status: 'approved' });
    expect(f.plans.step({ key: 's1', phase: 'start' })).toEqual({ ok: true });
  });

  it('queues a note naming the restored and the not restored files', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }, { rel: 'b.ts', text: 'b-new', by: 'tool' }]);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(f.notes).toHaveLength(1);
    expect(f.notes[0]).toBe('[IDE] Step "s1" was rolled back by the user. Restored: a.ts. Not restored: b.ts (not confirmed). The step is pending again; check the current state of the files before you continue.');
  });

  it('emits the step record to listeners', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    const seen: unknown[] = [];
    f.reverts.onChange((r) => seen.push(r));
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(seen).toEqual([record]);
  });

  it('marks the restored changes reverted and can undo the step rollback', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'a-new' }]);
    const record = await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(f.changes.changes().find((c) => c.path === 'a.ts' && c.stepKey === 's1')?.resolution).toBe('reverted');
    const undone = await f.reverts.undo(record.id);
    expect(undone.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
    expect(read(f.root, 'a.ts')).toBe('a-new');
  });

  it('rolls back the same step again after it is re-run in a new cycle', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'first run' }]);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    await f.feed('a.ts');
    await f.stepWork('s1', [{ rel: 'b.ts', text: 'second run' }]);
    expect(f.checkpoints.manifests('plan-1', 's1')).toMatchObject({ cycle: 1 });
    const preview = await f.reverts.previewStepRollback('plan-1', 's1');
    expect(preview.autoFiles).toEqual(['b.ts']);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'b.ts')).toBe('b-original');
    expect(read(f.root, 'a.ts')).toBe('a-original');
    await f.stepWork('s1', [{ rel: 'c.ts', text: 'third run' }]);
    expect(f.checkpoints.manifests('plan-1', 's1')).toMatchObject({ cycle: 2 });
  });

  it('keeps counting cycles across a restart', async () => {
    const f = await fixture();
    await f.approve();
    await f.stepWork('s1', [{ rel: 'a.ts', text: 'first run' }]);
    await f.reverts.rollbackStep('plan-1', 's1', []);
    await f.restart();
    await f.stepWork('s1', [{ rel: 'b.ts', text: 'second run' }]);
    expect(f.checkpoints.manifests('plan-1', 's1')).toMatchObject({ cycle: 1 });
    await f.reverts.rollbackStep('plan-1', 's1', []);
    expect(read(f.root, 'b.ts')).toBe('b-original');
    await f.restart();
    await f.stepWork('s1', [{ rel: 'c.ts', text: 'third run' }]);
    expect(f.checkpoints.manifests('plan-1', 's1')).toMatchObject({ cycle: 2 });
    expect(f.store.stepCycle('plan-1', 's1')).toBe(2);
  });
});

describe('rollbackMessage', () => {
  it('is factual and lists both sides', () => {
    expect(rollbackMessage({ stepKey: 'edit', restored: ['a.ts', 'b.ts'], notRestored: [{ path: 'c.ts', reason: 'not confirmed' }] })).toBe(
      '[IDE] Step "edit" was rolled back by the user. Restored: a.ts, b.ts. Not restored: c.ts (not confirmed). The step is pending again; check the current state of the files before you continue.',
    );
  });

  it('shortens long lists with "and N more" and stays within 1500 characters', () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/${'d'.repeat(120)}/file-${i}.ts`);
    const text = rollbackMessage({ stepKey: 'k'.repeat(400), restored: many, notRestored: many.map((path) => ({ path, reason: 'changed again after the agent\'s change' })) });
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toMatch(/and \d+ more|\d+ files/);
    expect(text.startsWith('[IDE] Step "')).toBe(true);
  });

  it('omits the empty sides', () => {
    const text = rollbackMessage({ stepKey: 'x', restored: [], notRestored: [] });
    expect(text).not.toContain('Restored');
    expect(text).not.toContain('Not restored');
  });
});
