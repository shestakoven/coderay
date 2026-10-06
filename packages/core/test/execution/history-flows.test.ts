import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../helpers';
import { git, isolateGit } from '../worktree-fixture';
import { AWAIT, build, INIT, type Built } from './harness';

isolateGit();

const WT = '.worktrees/wt1';
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' };
const FILES = { '.gitignore': '.worktrees/\n', 'old.txt': 'old\n', 'gone.txt': 'gone\n', 'ren.txt': 'ren\n', 'outside.txt': 'outside\n' };
const plan = JSON.stringify({
  fake: 'mcp', id: 'toolu_plan', tool: 'propose_plan',
  input: { goal: 'Fix app', steps: [{ key: 'edit', title: 'Fix app', rationale: 'Needed', targets: [{ path: 'src/app.ts', op: 'modify' }] }] },
});
const step = JSON.stringify({ fake: 'mcp', id: 'toolu_start', tool: 'step', input: { key: 'edit', phase: 'start' } });
const bash = (command: string, cwd?: string): string =>
  JSON.stringify({ fake: 'tool', id: 'toolu_git', name: 'Bash', input: { command }, result: 'ok', apply: true, ...(cwd ? { cwd } : {}) });
const result = '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}';
const HOLD = '{"fake":"sleep","ms":60000}';

// The project root, or a worktree of it, is on a branch one commit ahead of main, which meanwhile deleted gone.txt, renamed ren.txt and changed old.txt and outside.txt.
async function flow(where: 'root' | 'worktree', command: string, tail: string[]): Promise<Built> {
  const b = await build({
    scenario: [AWAIT, INIT, plan, step, bash(command, where === 'worktree' ? WT : undefined), ...tail],
    start: false, sessionStart: false, files: FILES, claudeEnv: IDENTITY,
  });
  git(b.root, 'add', '-A');
  git(b.root, 'commit', '-q', '-m', 'c0');
  git(b.root, 'branch', '-M', 'main');
  const feature = where === 'root' ? b.root : join(b.root, WT);
  if (where === 'root') git(b.root, 'checkout', '-q', '-b', 'feat');
  else git(b.root, 'worktree', 'add', '-q', '-b', 'feat', WT);
  writeFileSync(join(feature, 'notes.txt'), 'notes feature\n');
  git(feature, 'add', 'notes.txt');
  git(feature, 'commit', '-q', '-m', 'f1');
  if (where === 'root') git(b.root, 'checkout', '-q', 'main');
  git(b.root, 'rm', '-q', 'gone.txt');
  git(b.root, 'mv', 'ren.txt', 'renamed.txt');
  writeFileSync(join(b.root, 'old.txt'), 'old v2\n');
  writeFileSync(join(b.root, 'outside.txt'), 'outside v2\n');
  git(b.root, 'commit', '-q', '-am', 'm1');
  if (where === 'root') git(b.root, 'checkout', '-q', 'feat');
  await b.session.start();
  await b.rt.start();
  return b;
}

const changeOf = (b: Built, rel: string) => b.changes().findLast((c) => c.path === rel);

describe.each([
  ['the project root', 'root', ''],
  ['a nested worktree', 'worktree', `${WT}/`],
] as const)('git rebase on a clean tree in %s, under a plan that covers one file', { timeout: 60_000 }, (_name, where, prefix) => {
  it('raises no prompt and no event, and records what git deleted, renamed and rewrote as git work with no step', async () => {
    const b = await flow(where, 'git rebase main', [result, AWAIT]);
    await b.send();
    await waitFor(() => b.session.state().turns.some((turn) => turn.closedAt !== null), 'the turn closed', 20_000);
    for (const rel of ['gone.txt', 'ren.txt', 'old.txt', 'outside.txt']) await waitFor(() => changeOf(b, `${prefix}${rel}`), `${rel} recorded`);
    await waitFor(() => changeOf(b, '.git/refs/heads/feat'), 'the branch ref recorded');
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    await b.rt.changes.idle();
    await b.rt.watchdog.quiesce();
    const notGit = b.changes().filter((c) => c.origin !== 'git' || c.planId !== null || c.stepKey !== null || c.resolution !== null);
    expect(notGit).toEqual([]);
    expect([b.rt.gate.gate.prompts(), b.events(), b.rt.hold.isHeld()]).toEqual([[], [], false]);
  });
});

describe('git cherry-pick -n and revert -n, which leave HEAD where it was', { timeout: 60_000 }, () => {
  it('is still the agent work: after the call ends the watchdog raises an event for the files outside the plan, whether written during the call or at its end', async () => {
    const b = await flow('root', 'git cherry-pick -n main && sleep 1 && git revert -n HEAD', [HOLD, AWAIT]);
    await b.send();
    const files = ['gone.txt', 'notes.txt', 'old.txt', 'outside.txt', 'ren.txt', 'renamed.txt'];
    await waitFor(() => files.every((rel) => b.events().some((e) => e.changes.some((c) => c.path === rel))), 'every file in watchdog events', 20_000);
    const raised = b.events().flatMap((e) => e.changes.map((c) => [c.path, c.origin, c.outOfPlan]));
    expect(raised.sort()).toEqual(files.map((rel) => [rel, 'agent-tool', true]));
    expect([changeOf(b, 'outside.txt')?.stepKey, changeOf(b, 'notes.txt')?.stepKey, b.rt.gate.gate.prompts()]).toEqual(['edit', 'edit', []]);
  });
});
