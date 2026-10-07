import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ControlMode } from '@ide/protocol';
import { HookGate } from '../../src/gate/hook-gate';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import type { ToolCall } from '../../src/watchdog/activity';
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
  it('asks once, and only about a dirty tracked file outside the plan, named from the repository top even when run from a subdirectory and reached by two commands', async () => {
    const { root, bash, pending, gate } = await setup('B');
    const src = join(root, 'src');
    expect((await bash('git rebase main', src))?.permissionDecision).toBe('allow');
    writeFileSync(join(root, 'src/app.ts'), 'dirty');
    expect((await bash('git rebase main', src))?.permissionDecision).toBe('allow');
    writeFileSync(join(root, 'README.md'), 'dirty');
    const answer = bash('git rebase main && git merge main', src);
    const prompt = await pending();
    expect(gate.prompts()).toHaveLength(1);
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
// that main ignores, "dirbranch" adds a directory named .env, "news" adds a file and edits one, a linked worktree sits in .worktrees/wt,
// and the project holds an .env of its own.
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
  git(root, 'checkout', '-q', '-b', 'dirbranch', 'main');
  mkdirSync(join(root, '.env'));
  writeFileSync(join(root, '.env/inner.txt'), 'inner\n');
  git(root, 'add', '-f', '.env/inner.txt');
  git(root, 'commit', '-q', '-m', 'env as a directory');
  git(root, 'checkout', '-q', '-b', 'envbranch', 'main');
  writeFileSync(join(root, '.env'), 'TRACKED=1\n');
  git(root, 'add', '-f', '.env');
  git(root, 'commit', '-q', '-m', 'track env');
  git(root, 'push', '-q', 'origin', 'envbranch');
  git(root, 'checkout', '-q', 'main');
  git(root, 'worktree', 'add', '-q', '--detach', '.worktrees/wt');
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
  it('lets the usual rebase, pull, merge, checkout and commit forms through on a clean tree, however they are chained, piped or prefixed', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    git(root, 'checkout', '-q', 'news');
    git(root, 'checkout', '-q', 'main');
    const commands = [
      'git fetch origin && git rebase origin/main', 'cd sub && git rebase main', 'git pull --rebase', 'git pull', 'git pull origin main',
      'git stash && git rebase main && git stash pop', 'git merge main', 'git merge news', 'git rebase news', 'git checkout -b feature',
      'git checkout -b x main', 'git checkout main', 'git checkout news', 'git checkout remote-only', 'git switch remote-only', 'git switch -',
      'git switch -c x', 'git reset --hard', 'git reset --hard HEAD~1', 'git commit -am x && git rebase main', 'git commit -qm x && git rebase main',
      'git rebase main 2>&1 | tail -5', 'git rebase main; echo done', 'git status && git diff --stat | head -3; git rebase main',
      'if git diff --quiet; then git rebase main; fi', 'until git rebase main; do sleep 1; done', 'git rebase main; exit 0', 'git rebase --continue',
      'git rebase main || git rebase --abort', 'GIT_EDITOR=true git rebase --continue', 'git rebase main && git push',
      'pwd; true; false; :; sleep 0; ls; cat README.md | head -1 | tail -1 | wc -l; grep -q x README.md; test -f a; which git; set -e; git rebase main',
      'cd .worktrees/wt && git reset --hard', 'git remote -v; git config --get user.name; git branch --show-current; git tag -l; git rebase main',
    ];
    expect((await verdicts(bash, commands)).map(([command, decision]) => [command, decision])).toEqual(commands.map((command) => [command, 'allow']));
  });

  it('asks about every tracked file when a command that moves history also writes, runs a program, reconfigures git, or may run in another directory', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    const forged = 'git update-index --add --cacheinfo 100644,$(git hash-object -w README.md),forged.txt && t=$(git write-tree) && '
      + 'c=$(git commit-tree "$t" -p HEAD -m x) && git update-ref refs/heads/forged "$c" && git reset --hard forged';
    const commands = [
      'git hash-object -w README.md && git reset --hard main', 'git update-index --add README.md && git reset --hard main', forged,
      'git rebase -xtrue main', 'git rebase -qxtrue main', 'git rebase --exec=true main', "git rebase --exe='true' main", 'git rebase --exe=true main',
      'git fetch --upload-pa=prog origin && git rebase main', 'git fetch --upload-pa=prog && git pull', 'git -c core.hooksPath=/tmp/h rebase main',
      'git --exec-path=/tmp/x merge main', 'git diff --output=src/other.ts && git rebase main', 'git log --output out.txt; git rebase main',
      'echo x > out.txt && git rebase main', `python3 -c "open('src/other.ts','w').write('x')" && git pull`, 'make && git rebase main',
      '$FIX && git rebase main', 'FOO=1 git rebase main', 'sudo git rebase main', 'env git rebase main', 'GIT_DIR=/elsewhere/.git git checkout main',
      './cat README.md && git rebase main', '/tmp/x/git rebase main', './git rebase main',
      'alias cd=true; cd .worktrees/wt && git reset --hard', 'f() { :; }; cd .worktrees/wt && git reset --hard',
      'CDPATH=/x cd .worktrees/wt && git reset --hard', 'git diff --ext && git rebase main', 'git config core.hooksPath /tmp/h && git rebase main',
      'git remote set-url origin /tmp/x && git pull',
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
    const unnamed = ['git rebase "$BRANCH"', 'git merge no-such-branch', 'git pull origin a:b', 'git reset {--hard,} envbranch', 'git reset $"--hard" envbranch'];
    expect(await verdicts(bash, unnamed)).toEqual(unnamed.map((command) => [command, 'deny', EVERY_FILE]));
    // A stopped sequence brings nothing new in, however many commits the upstream holds; an --abort goes back to ORIG_HEAD, which is absent until the first rebase, merge or reset.
    const resumes = [
      'git rebase --continue', 'GIT_EDITOR=true git rebase --continue', 'git rebase --skip', 'git rebase --quit', 'git rebase --root', 'git rebase --abort',
      'git merge --continue', 'git merge --quit', 'git merge --abort', 'git cherry-pick --continue', 'git revert --skip',
    ];
    expect((await verdicts(bash, resumes)).map(([command, decision]) => [command, decision])).toEqual(resumes.map((command) => [command, 'allow']));
    git(root, 'update-ref', 'ORIG_HEAD', 'envbranch');
    expect(await verdicts(bash, ['git rebase --abort', 'git cherry-pick --abort', 'git merge --abort'])).toEqual([
      ['git rebase --abort', 'deny', ENV_FILE], ['git cherry-pick --abort', 'deny', ENV_FILE], ['git merge --abort', 'allow', expect.any(String)],
    ]);
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

  it('names the file a history command would discard or overwrite when the call hides the command from a plain reading', async () => {
    const { root, bash } = await setup('A');
    repoWithOrigin(root);
    mkdirSync(join(root, 'vendor/lib'), { recursive: true });
    git(join(root, 'vendor/lib'), 'init', '-q');
    writeFileSync(join(root, 'README.md'), 'dirty');
    git(root, 'update-index', '--assume-unchanged', 'sub/x.txt');
    writeFileSync(join(root, 'sub/x.txt'), 'edited');
    // What the user is asked about: README.md has an edit git shows, sub/x.txt one it hides, and .env is an ignored file a directory would replace.
    const readme = 'README.md (uncommitted)';
    const rows: [command: string, asked: string | null][] = [
      ['false && cd vendor/lib; git reset --hard', readme],
      ['git commit -m "$(cat <<\'EOF\'\nfix: it\'s done\nEOF\n)" && git reset --hard', readme],
      ['git commit -m "$(echo msg # it\'s done\n)" && git reset --hard', readme],
      ['cat <<-EOF\n\tbody\n\tEOF\ngit reset --hard', readme],
      ['cat <<EOF\n$(git reset --hard)\nEOF', readme],
      ['echo ${X:-$(git reset --hard)}', readme],
      ["cat <<'EOF'\n$(git reset --hard)\nEOF", null],
      ['git checkout main', 'sub/x.txt (uncommitted)'],
      ['git checkout dirbranch', '.env (uncommitted)'],
      ['git --super-prefix=x reset --hard', 'a git option the IDE cannot read'],
      ['echo "$(git status', 'a command substitution the IDE cannot read to its end'],
    ];
    const results = await verdicts(bash, rows.map(([command]) => command));
    expect(results.map(([command, decision, reason], i) => [command, decision, rows[i]![1] === null || (reason ?? '').includes(rows[i]![1]!)])).toEqual(
      rows.map(([command, asked]) => [command, asked === null ? 'allow' : 'deny', true]),
    );
  });
});

describe('HookGate for a history command that the call also follows with writes to named files', () => {
  it('names the nested worktree the command moves history in, and no other directory, unless the call may write files it does not name', async () => {
    const { root, gate, bash } = await setup('C');
    repoWithOrigin(root);
    const calls: ToolCall[] = [];
    gate.onAllowed((call) => calls.push(call));
    const rows: [command: string, dirs: string[]][] = [
      ['cd .worktrees/wt && git reset --hard && touch notes.txt', ['.worktrees/wt']],
      ['git -C .worktrees/wt reset --hard && touch notes.txt', ['.worktrees/wt']],
      ['git -C .worktrees/wt reset --hard && touch .worktrees/wt/notes.txt', ['.worktrees/wt']],
      ['git -C .worktrees/wt reset --hard && ./gen.sh', []],
      ['git reset --hard && touch notes.txt', []],
      [`cd "$D" && git reset --hard && touch ${join(root, 'notes.txt')}`, []],
    ];
    for (const [i, [command]] of rows.entries()) expect([command, (await bash(command, root, `toolu_${i}`))?.permissionDecision]).toEqual([command, 'allow']);
    expect(calls.map((call) => [call.toolUseId, (call.history ?? []).map((h) => h.dir)])).toEqual(rows.map(([, dirs], i) => [`toolu_${i}`, dirs]));
    expect(calls[0]!.history).toEqual([{ dir: '.worktrees/wt', top: join(realpathSync(root), '.worktrees/wt'), head: git(join(root, '.worktrees/wt'), 'rev-parse', 'HEAD').trim() }]);
  });
});
