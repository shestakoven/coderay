import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import type { ToolCall } from '../../src/watchdog/activity';
import { waitFor } from '../helpers';
import { git, isolateGit } from '../worktree-fixture';
import { AWAIT, build, INIT, mcpWrite, type Built } from './harness';

isolateGit();

const WT = '.worktrees/wt1';
const A = `${WT}/backend/src/a.py`;
const OTHER = `${WT}/backend/src/other.py`;
const DIST = `${WT}/dist/x.js`;
const WT_SCRATCH = `${WT}/scratch.txt`;
const A_ORIGINAL = 'a = 1\n';
const OTHER_ORIGINAL = 'other = 1\n';
const COMPONENTS = [{ id: 'backend', name: 'Backend', files: ['backend/src/a.py', 'backend/src/other.py'], globs: [] }];

const plan = JSON.stringify({
  fake: 'mcp', id: 'toolu_plan', tool: 'propose_plan',
  input: { goal: 'Fix a', steps: [{ key: 'edit', title: 'Fix a', rationale: 'Needed', targets: [{ path: 'backend/src/a.py', op: 'modify' }] }] },
});
const step = (phase: string): string => JSON.stringify({ fake: 'mcp', id: `toolu_${phase}`, tool: 'step', input: { key: 'edit', phase } });
const write = (rel: string, content: string): string =>
  JSON.stringify({ fake: 'tool', id: `toolu_write_${rel.length}`, name: 'Write', input: { file_path: `$CWD/${rel}`, content }, result: 'The file was updated.', apply: true });
const result = '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}';
const HOLD = '{"fake":"sleep","ms":60000}';

interface FlowOptions { worktreeFirst?: boolean; dir?: string; runtime?: Parameters<typeof build>[0]['runtime'] }

async function worktreeFlow(scenario: string[], options: FlowOptions = {}) {
  const b = await build({
    scenario, start: false, sessionStart: false,
    files: { '.gitignore': '.worktrees/\ndist/\n', 'backend/src/a.py': A_ORIGINAL, 'backend/src/other.py': OTHER_ORIGINAL },
    runtime: { components: () => COMPONENTS, reconcileMs: 3_600_000, ...options.runtime },
  });
  git(b.root, 'add', '-A');
  git(b.root, 'commit', '-q', '-m', 'init');
  if (options.worktreeFirst !== false) git(b.root, 'worktree', 'add', '-q', options.dir ?? '.worktrees/wt1');
  await b.session.start();
  await b.rt.start();
  return b;
}

const file = (b: Built, rel: string): string => readFileSync(join(b.root, rel), 'utf8');
const closedTurns = (b: Built) => b.session.state().turns.filter((turn) => turn.closedAt !== null);
const hookRecords = (b: Built) => b.records().flatMap((record) => (record.hook ? [record.hook] : []));
const changeOf = (b: Built, rel: string) => b.changes().findLast((c) => c.path === rel);

describe('a plan on the files of a project whose agent works in a nested worktree', { timeout: 30_000 }, () => {
  const inPlan = [AWAIT, INIT, plan, step('start'), write(A, 'a = 2\n'), mcpWrite('toolu_mcp', [{ path: DIST, content: 'built\n' }]), result, AWAIT, INIT, step('done'), result, AWAIT];

  it('takes a write to the worktree for a write to the plan file: no out-of-plan event, an enforced change stamped with the step', async () => {
    const b = await worktreeFlow(inPlan);
    await b.send();
    await waitFor(() => closedTurns(b).length === 1, 'the turn closed');
    await waitFor(() => changeOf(b, A), 'the change recorded');
    await b.rt.changes.idle();
    await b.rt.watchdog.quiesce();
    const planId = b.rt.gate.plans.plans()[0]!.id;
    expect(file(b, A)).toBe('a = 2\n');
    expect(changeOf(b, A)).toMatchObject({ enforcement: 'enforced', origin: 'agent', outOfPlan: false, planId, stepKey: 'edit', resolution: null });
    expect([b.events(), b.rt.hold.isHeld()]).toEqual([[], false]);
    expect(hookRecords(b).filter((hook) => hook.tool === 'Write').map((hook) => hook.allowed)).toEqual([true]);
  });

  it('does not track a file the worktree ignores', async () => {
    const b = await worktreeFlow(inPlan);
    await b.send();
    await waitFor(() => closedTurns(b).length === 1, 'the turn closed');
    await waitFor(() => changeOf(b, A), 'the change recorded');
    await b.rt.changes.idle();
    expect(existsSync(join(b.root, DIST))).toBe(true);
    expect(b.changes().map((c) => c.path)).toEqual([A]);
    expect(b.store.baselines().map((row) => row.path)).not.toContain(DIST);
  });

  it('puts the worktree file into the step checkpoint, previews it as an automatic rollback and restores its original content', async () => {
    const b = await worktreeFlow(inPlan);
    await b.send();
    await waitFor(() => closedTurns(b).length === 1, 'the turn closed');
    await waitFor(() => changeOf(b, A), 'the change recorded');
    b.session.send('finish');
    const done = await waitFor(() => b.rt.gate.plans.plans().find((p) => p.status === 'done'), 'the plan done');
    await waitFor(() => b.rt.checkpoints.views().find((view) => view.sealedAt !== null), 'the sealed checkpoint');
    await waitFor(() => closedTurns(b).length === 2, 'the second turn closed');
    await b.rt.changes.idle();
    expect(Object.keys(b.rt.checkpoints.manifests(done.id, 'edit')!.after)).toEqual([A]);
    const preview = await b.rt.reverts.previewStepRollback(done.id, 'edit');
    expect(preview).toMatchObject({ allowed: true, autoFiles: [A], confirmFiles: [], notRolledBack: [], conflicts: [] });
    await b.rt.reverts.rollbackStep(done.id, 'edit', []);
    expect(existsSync(join(b.root, A))).toBe(true);
    expect([file(b, A), file(b, DIST)]).toEqual([A_ORIGINAL, 'built\n']);
    expect(file(b, 'backend/src/a.py')).toBe(A_ORIGINAL);
  });
});

describe('a write to the worktree that the plan does not cover', { timeout: 30_000 }, () => {
  const outOfPlan = [AWAIT, INIT, plan, step('start'),
    mcpWrite('toolu_out', [{ path: A, content: 'a = 2\n' }, { path: OTHER, content: 'other = 2\n' }, { path: DIST, content: 'built\n' }]), HOLD, AWAIT];

  it('raises the watchdog for the file outside the plan only, and a revert restores the original content', async () => {
    const b = await worktreeFlow(outOfPlan);
    await b.send();
    const event = await waitFor(() => b.events().find((e) => e.phase === 'pending' && e.changes.some((c) => c.path === OTHER)), 'a pending event for the worktree file');
    expect(event.changes.map((c) => [c.path, c.enforcement, c.outOfPlan])).toEqual([[OTHER, 'enforced', true]]);
    expect([event.kind, event.interrupted, b.rt.hold.isHeld()]).toEqual(['watchdog', true, true]);
    expect(changeOf(b, A)).toMatchObject({ enforcement: 'enforced', outOfPlan: false });
    expect(changeOf(b, DIST)).toBeUndefined();
    await b.rt.watchdog.answer(event.id, { kind: 'all', answer: 'revert' });
    expect([existsSync(join(b.root, OTHER)), file(b, OTHER)]).toEqual([true, OTHER_ORIGINAL]);
    expect(file(b, A)).toBe('a = 2\n');
  });
});

describe('a worktree created while CodeRay runs', { timeout: 30_000 }, () => {
  it('takes the files of its checkout as they are, then records the agent write against the content git has', async () => {
    const b = await worktreeFlow([AWAIT, INIT, result, AWAIT, INIT, plan, step('start'), write(A, 'a = 2\n'), HOLD, AWAIT], { worktreeFirst: false });
    b.session.send('first');
    await waitFor(() => closedTurns(b).length === 1, 'the first turn closed');
    git(b.root, 'worktree', 'add', '-q', '.worktrees/wt1');
    await waitFor(() => b.store.baselines().some((row) => row.path === A), 'the checkout baselined from the watcher events');
    await b.rt.changes.idle();
    expect(b.changes().filter((c) => c.enforcement === 'enforced')).toEqual([]);
    b.session.send('second');
    const change = await waitFor(() => changeOf(b, A), 'the change recorded');
    expect([change.beforeHash, change.enforcement, change.outOfPlan]).toEqual([git(b.root, 'hash-object', 'backend/src/a.py').trim(), 'enforced', false]);
    expect(b.events()).toEqual([]);
  });
});

describe.each([
  ['not gitignored', 'trees/w1'],
  ['guarded', '.claude/worktrees/w1'],
] as const)('a worktree in a %s place removed while CodeRay runs', { timeout: 30_000 }, (_kind, dir) => {
  it('records no change for its files, forgets them at the next scan and raises nothing', async () => {
    const b = await worktreeFlow([AWAIT, INIT, result, AWAIT], { dir });
    const under = (): string[] => b.store.baselines().map((row) => row.path).filter((path) => path.startsWith(`${dir}/`));
    expect(under()).toContain(`${dir}/backend/src/a.py`);
    git(b.root, 'worktree', 'remove', '--force', dir);
    invalidateWorktrees(b.root);
    await b.send();
    await waitFor(() => closedTurns(b).length === 1, 'the turn closed');
    await waitFor(() => under().length === 0, 'the baselines of the removed worktree dropped');
    await b.rt.changes.idle();
    await b.rt.watchdog.quiesce();
    expect([b.changes().filter((c) => c.path.startsWith(`${dir}/`)), b.events(), b.rt.hold.isHeld()]).toEqual([[], [], false]);
  });
});

describe('a periodic scan that meets a worktree the watcher did not report', { timeout: 30_000 }, () => {
  const toolCall = (): ToolCall => ({
    toolUseId: 'toolu_running', parentToolUseId: null, tool: 'Bash', toolClass: 'shell', targets: [], allTracked: true,
    cwdRel: null, background: false, allowedOnce: false,
  });

  it('hands the files that are not settled to the change service, so that such a file is never reverted as a deletion', async () => {
    const b = await worktreeFlow([AWAIT, INIT, HOLD, AWAIT], {
      worktreeFirst: false,
      runtime: { watcherOptions: { testHooks: { dropRawFileEvents: (rel) => rel.startsWith('.worktrees/') } } },
    });
    const marked = vi.spyOn(b.rt.changes, 'markUnsighted');
    git(b.root, 'worktree', 'add', '-q', '.worktrees/wt1');
    invalidateWorktrees(b.root);
    writeFileSync(join(b.root, WT_SCRATCH), 'scratch\n');
    const later = new Date(Date.now() + 60_000);
    for (const rel of [WT_SCRATCH, A]) utimesSync(join(b.root, rel), later, later);
    b.rt.ledger.allowed(toolCall());
    await b.send();
    await waitFor(() => marked.mock.calls.length > 0, 'the scan handed over the files not settled');
    expect(marked.mock.calls[0]![0]).toEqual(expect.arrayContaining([WT_SCRATCH, A]));
    await b.rt.changes.handle({ rel: WT_SCRATCH, exists: true, at: performance.now(), wall: Date.now() });
    const change = await waitFor(() => changeOf(b, WT_SCRATCH), 'the change recorded');
    expect([change.beforeHash, change.beforeMode]).toEqual([null, 0o644]);
    const record = await b.rt.reverts.revertChanges({ changeIds: [change.id], eventId: null });
    expect(record.files).toEqual([{ path: WT_SCRATCH, outcome: 'conflict', reason: 'the previous content is not known' }]);
    expect(file(b, WT_SCRATCH)).toBe('scratch\n');
  });
});
