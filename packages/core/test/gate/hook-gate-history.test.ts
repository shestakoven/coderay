import { mkdirSync, writeFileSync } from 'node:fs';
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

// main ignores .env and tracks sub/, has origin with main as upstream and "remote-only" known by origin alone; "envbranch" tracks the .env
// that main ignores, "news" adds a file and edits one, and the project holds an .env of its own.
function repoWithOrigin(root: string): void {
  git(root, 'branch', '-M', 'main');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub/x.txt'), 'x');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'ignore env');
  const origin = tempDir('hist-origin-');
  git(origin, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'branch', 'remote-only');
  git(root, 'push', '-q', 'origin', 'remote-only');
  git(root, 'branch', '-q', '-D', 'remote-only');
  git(root, 'checkout', '-q', '-b', 'news');
  writeFileSync(join(root, 'added.txt'), 'added\n');
  writeFileSync(join(root, 'sub/x.txt'), 'x2\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'news');
  git(root, 'checkout', '-q', '-b', 'envbranch', 'main');
  writeFileSync(join(root, '.env'), 'TRACKED=1\n');
  git(root, 'add', '-f', '.env');
  git(root, 'commit', '-q', '-m', 'track env');
  git(root, 'push', '-q', 'origin', 'envbranch');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, '.env'), 'LOCAL=1\n');
}

type Bash = Awaited<ReturnType<typeof setup>>['bash'];
type Verdict = [command: string, decision: string | undefined, reason: string | undefined];

// Control mode A denies what mode B would ask about, so the verdict is what the user would be asked.
async function verdicts(bash: Bash, commands: string[]): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const [i, command] of commands.entries()) {
    const result = await bash(command, undefined, `toolu_${i}`);
    out.push([command, result?.permissionDecision, result?.permissionDecisionReason]);
  }
  return out;
}

const EVERY_FILE = expect.stringContaining('every tracked file');
const ENV_FILE = expect.stringContaining('.env (uncommitted)');

describe('HookGate for history commands in a repository with an origin and an ignored .env', () => {
  it('lets the usual rebase, pull, merge and checkout forms through on a clean tree', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    const commands = [
      'git fetch origin && git rebase origin/main', 'cd sub && git rebase main', 'git pull --rebase', 'git pull', 'git pull origin main',
      'git merge main', 'git checkout -b x', 'git checkout -b x main', 'git checkout main', 'git switch -c y', 'git checkout remote-only',
      'git switch remote-only', 'git reset --hard', 'git reset --hard HEAD~1', 'git status && git diff --stat | head -3; git rebase main',
      'git merge news', 'git rebase news', 'git checkout news', 'if git diff --quiet; then git rebase main; fi',
      'git commit -qm x && git rebase main', 'git rebase --continue',
    ];
    expect((await verdicts(bash, commands)).map(([command, decision]) => [command, decision])).toEqual(commands.map((command) => [command, 'allow']));
  });

  it('asks about every tracked file when a command that moves history also writes, runs a program, or reconfigures git', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    const commands = [
      'git hash-object -w README.md && git reset --hard main', 'git update-index --add README.md && git reset --hard main',
      'git rebase -xtrue main', 'git rebase --exec=true main', 'git -c core.hooksPath=/tmp/h rebase main',
      'git --exec-path=/tmp/x merge main', 'git diff --output=src/other.ts && git rebase main', 'git log --output out.txt; git rebase main',
      'echo x > out.txt && git rebase main', 'make && git rebase main', '$FIX && git rebase main', 'FOO=1 git rebase main',
      'sudo git rebase main', 'env git rebase main',
    ];
    expect(await verdicts(bash, commands)).toEqual(commands.map((command) => [command, 'deny', EVERY_FILE]));
  });

  it('names the ignored .env that a commit coming in tracks, whichever way the history command takes it, and every file when it cannot name the commit', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    git(root, 'branch', '-q', '-u', 'origin/envbranch', 'main');
    const brings = [
      'git checkout envbranch', 'git checkout -m envbranch', 'git switch envbranch', 'git checkout -', 'git switch -', 'git merge envbranch',
      'git merge -m msg envbranch', 'git merge', 'git rebase envbranch', 'git rebase -m envbranch', 'git rebase --onto envbranch main', 'git rebase',
      'git rebase main envbranch', 'git reset --hard envbranch', 'git cherry-pick envbranch', 'git cherry-pick -m 1 envbranch',
      'git pull origin envbranch', 'git pull', 'git pull --rebase', 'cd sub && git checkout envbranch',
    ];
    expect(await verdicts(bash, brings)).toEqual(brings.map((command) => [command, 'deny', ENV_FILE]));
    const unnamed = ['git rebase "$BRANCH"', 'git merge no-such-branch', 'git pull origin a:b'];
    expect(await verdicts(bash, unnamed)).toEqual(unnamed.map((command) => [command, 'deny', EVERY_FILE]));
  });

  it('asks before checkout writes files from a commit or the index and leaves HEAD where it is', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    const commands = [
      'git checkout main -- README.md', 'git checkout -- README.md', 'git checkout main README.md', 'git checkout -p main',
      'git checkout --patch', 'git checkout --pathspec-from-file=list main',
    ];
    expect(await verdicts(bash, commands)).toEqual(commands.map((command) => [command, 'deny', EVERY_FILE]));
  });
});
