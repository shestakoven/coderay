import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HookGate } from '../../src/gate/hook-gate';
import { Baselines } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { GitOps } from '../../src/history/git-ops';
import { IdeWrites } from '../../src/history/ide-writes';
import { ShadowRepo } from '../../src/history/shadow';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger } from '../../src/watchdog/activity';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';
import { git, isolateGit, projectWithWorktree } from '../worktree-fixture';

isolateGit();

const WT = '.worktrees/wt1';
const components: ComponentRef[] = [{ id: 'app', name: 'App', files: ['backend/src/a.py'], globs: [] }];
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };

function files(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === '.git') return [];
    const rel = base === '' ? name : `${base}/${name}`;
    return statSync(join(dir, name)).isDirectory() ? files(join(dir, name), rel) : [rel];
  });
}

const snapshot = (dir: string): Map<string, string> => new Map(files(dir).map((rel) => [rel, readFileSync(join(dir, rel), 'utf8')]));

// The project's .worktrees/wt1 sits on "work"; "other" adds twelve files under pkg/ and edits a.py, "side" adds side.txt.
async function setup() {
  const { root, wt } = await projectWithWorktree({ '.gitignore': '.worktrees/\n.env\n', '.env.example': 'X=1\n' });
  git(wt, 'checkout', '-q', '-b', 'other');
  await writeTree(wt, { 'backend/src/a.py': 'a = 2\n', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`pkg/m${i}.py`, `m = ${i}\n`])) });
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'other');
  git(wt, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  await writeTree(wt, { 'side.txt': 's\n' });
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'side');
  git(wt, 'checkout', '-q', '-b', 'work', 'HEAD~1');

  const store = openStore(tempDir('nwt-store-'));
  onTestFinished(() => store.close());
  store.saveSession(sessionRecord('s1', root));
  const policy = { ...DEFAULT_POLICY, mode: 'B' as const };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home: tempDir('nwt-home-'), tempRoots: [] }),
  });
  const gate = new HookGate({
    root, store, sessionId: () => 's1', policy: () => policy, plans, components: () => components,
    context: () => ({ parentToolUseId: null, lastMessage: 'Moving history.' }), home: tempDir('nwt-home-'), tempRoots: [],
  });
  await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ path: 'backend/src/a.py', op: 'modify' }] }] });
  plans.step({ key: 'edit', phase: 'start' });

  const clock = { now: 1000 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  const ops = new GitOps({ root, settle: (id) => service.settleGit(id) });
  const service: ChangeService = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow: await ShadowRepo.open(tempDir('nwt-shadow-')), baselines: new Baselines(store), ideWrites: new IdeWrites(), ledger, store,
    checkpoints: new Checkpoints(store, () => 's1'), sessionId: () => 's1', plans: { gate: () => ({ state: 'none' }) }, gitMoved: (id) => ops.moved(id),
  });
  gate.onAllowed((call) => {
    ledger.allowed(call);
    ops.begin(call);
  });
  const watch = async (paths: string[], seen: Map<string, string>): Promise<void> => {
    for (const rel of paths) await service.handle({ rel: `${WT}/${rel}`, exists: seen.has(rel), at: clock.now, wall: Date.now() });
    await service.idle();
  };
  await watch(files(wt), snapshot(wt));

  // The agent's call as the gate judges it and the shell runs it, with the files it changed reported to the watcher before the call ends.
  // `staleIndex` runs git on a copy of the index that is put back after the report, as git does between writing files and the index.
  async function bash(command: string, id: string, o: { answer?: 'allow-once'; staleIndex?: boolean } = {}): Promise<Record<string, string>> {
    const before = snapshot(wt);
    const verdict = gate.evaluate({ tool_name: 'Bash', tool_input: { command }, tool_use_id: id, cwd: root }, new AbortController().signal);
    if (o.answer) gate.answer((await waitFor(() => gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt')).id, o.answer);
    expect((await verdict)?.permissionDecision).toBe('allow');
    clock.now += 10;
    const index = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    if (o.staleIndex) copyFileSync(index, `${index}.copy`);
    execFileSync('bash', ['-c', command], { cwd: root, stdio: 'ignore', env: { ...process.env, ...IDENTITY, ...(o.staleIndex ? { GIT_INDEX_FILE: `${index}.copy` } : {}) } });
    clock.now += 10;
    const after = snapshot(wt);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((rel) => before.get(rel) !== after.get(rel));
    await watch(changed, after);
    if (o.staleIndex) renameSync(`${index}.copy`, index);
    ledger.ended(id);
    await ops.toolEnded(id);
    await service.idle();
    const paths = new Set(changed.map((rel) => `${WT}/${rel}`));
    return Object.fromEntries(service.changes().filter((change) => paths.has(change.path)).map((change) => [change.path.slice(WT.length + 1), change.origin]));
  }

  return { root, wt, bash };
}

const MOVED = ['backend/src/a.py', ...Array.from({ length: 12 }, (_, i) => `pkg/m${i}.py`)].sort();

describe('ChangeService for a history command in a nested worktree', () => {
  it('gives git what the command moved, however many files and whatever else the call writes, and the agent the file it names and what git did not move', async () => {
    const { root, bash } = await setup();
    const reset = await bash(`cd ${join(root, WT)} && git status --short && git reset --hard other && cp -n .env.example .env && ls .env`, 'toolu_reset', { answer: 'allow-once' });
    expect(Object.fromEntries(Object.entries(reset).filter(([, origin]) => origin === 'git'))).toEqual(Object.fromEntries(MOVED.map((rel) => [rel, 'git'])));
    expect(reset['.env']).toBe('agent');
    const pick = await bash(`cd ${join(root, WT)} && git cherry-pick -n side && cp -n .env.example .env.local`, 'toolu_pick', { answer: 'allow-once' });
    expect(pick).toEqual({ 'side.txt': 'agent-tool', '.env.local': 'agent' });
  });

  it('gives git the files its checkout creates before it writes the index', async () => {
    const { root, bash } = await setup();
    const reset = await bash(`cd ${join(root, WT)} && git reset --hard other`, 'toolu_stale', { staleIndex: true });
    expect(reset).toEqual(Object.fromEntries(MOVED.map((rel) => [rel, 'git'])));
  });

  it('keeps a file a sed script writes the agent, though a commit in the same call carries it', async () => {
    const { root, bash } = await setup();
    const evil = await bash(`cd ${join(root, WT)} && echo evil | sed -n 'w backend/src/evil.py' && git add -A && git commit -qm w && git reset -q`, 'toolu_sed');
    expect(evil).toEqual({ 'backend/src/evil.py': 'agent-tool' });
  });

  it('keeps every file the agent, when the call also runs a program the gate cannot read', async () => {
    const { root, bash } = await setup();
    const reset = await bash(`cd ${join(root, WT)} && git reset --hard other && bash -c 'cp -n .env.example .env'`, 'toolu_wild', { answer: 'allow-once' });
    expect(new Set(Object.values(reset))).toEqual(new Set(['agent']));
  });
});
