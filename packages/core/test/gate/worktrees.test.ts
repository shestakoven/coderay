import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { discoverNestedRepo, invalidateWorktrees, isWorktreeDir, nestedRepos, projectPrefix, refreshWorktrees, repoIdentity, repoOrigin, scopeRelOf, worktreeOf } from '../../src/gate/worktrees';
import { tempDir, waitFor, writeTree } from '../helpers';
import { addSubmodule, git, isolateGit, monorepoWithWorktree, projectWithWorktree, rewriteDotGit, submoduleSource } from '../worktree-fixture';

isolateGit();

const held = vi.hoisted(() => ({ on: false, calls: [] as (() => void)[] }));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = (file: string, args: string[], options: object, callback: (...results: unknown[]) => void) =>
    actual.execFile(file, args, options as never, ((...results: unknown[]) => {
      if (held.on) held.calls.push(() => callback(...results));
      else callback(...results);
    }) as never);
  return { ...actual, execFile };
});

const A = '.worktrees/wt1/backend/src/a.py';
const START = new Date('2030-01-01T00:00:00Z').getTime();

function frozenClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  vi.setSystemTime(START);
}

describe('worktreeOf', () => {
  it('names the worktree root, its directory and the path inside it', async () => {
    const { root, wt } = await projectWithWorktree();
    expect(worktreeOf(root, A)).toEqual({ worktreeRoot: wt, dir: '.worktrees/wt1', inner: 'backend/src/a.py' });
  });

  it('resolves a file that does not exist yet and a directory inside the worktree', async () => {
    const { root, wt } = await projectWithWorktree();
    expect(worktreeOf(root, '.worktrees/wt1/backend/src/new.py')).toMatchObject({ worktreeRoot: wt, inner: 'backend/src/new.py' });
    expect(worktreeOf(root, '.worktrees/wt1/backend/')).toMatchObject({ inner: 'backend/' });
  });

  it('returns null for an ordinary project path and for the root repository itself', async () => {
    const { root } = await projectWithWorktree();
    expect(['backend/src/a.py', 'README.md', '.gitignore', '.worktrees/other.txt'].map((rel) => worktreeOf(root, rel))).toEqual([null, null, null, null]);
  });

  it('returns null for the worktree directory itself and for a name that only shares its prefix', async () => {
    const { root } = await projectWithWorktree();
    expect([worktreeOf(root, '.worktrees/wt1'), worktreeOf(root, '.worktrees/wt10/backend/src/a.py')]).toEqual([null, null]);
  });

  it('returns null for the .git of a worktree, which is git internals and not project content', async () => {
    const { root } = await projectWithWorktree();
    expect([worktreeOf(root, '.worktrees/wt1/.git'), worktreeOf(root, '.worktrees/wt1/.git/HEAD')]).toEqual([null, null]);
  });

  it('keeps the directory relative to the root for a worktree deeper than the top level', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': '.worktrees/\nbackend/.trees/\n' });
    git(root, 'worktree', 'add', '-q', 'backend/.trees/deep');
    expect(worktreeOf(root, 'backend/.trees/deep/backend/src/a.py')).toMatchObject({ dir: 'backend/.trees/deep', inner: 'backend/src/a.py' });
  });

  it('tells apart several worktrees', async () => {
    const { root } = await projectWithWorktree();
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    invalidateWorktrees(root);
    await refreshWorktrees(root);
    expect(['.worktrees/wt1/x.py', '.worktrees/wt2/y.py'].map((rel) => worktreeOf(root, rel)?.dir)).toEqual(['.worktrees/wt1', '.worktrees/wt2']);
  });

  it('returns null for a directory without a .git', async () => {
    const { root } = await projectWithWorktree();
    mkdirSync(join(root, '.worktrees/plain/src'), { recursive: true });
    writeFileSync(join(root, '.worktrees/plain/src/x.py'), 'x');
    expect(worktreeOf(root, '.worktrees/plain/src/x.py')).toBeNull();
  });

  it('returns null for a submodule, which git does not list as a worktree', async () => {
    const lib = tempDir('wt-lib-');
    git(lib, 'init', '-q');
    await writeTree(lib, { 'lib.py': 'lib\n' });
    git(lib, 'add', '-A');
    git(lib, 'commit', '-q', '-m', 'lib');
    const { root } = await projectWithWorktree();
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    expect(worktreeOf(root, 'vendor/lib/lib.py')).toBeNull();
  });

  it('returns null for every path of a project whose own root is a linked worktree of another repository', async () => {
    const { root: main } = await projectWithWorktree();
    const linked = join(tempDir('wt-linked-'), 'checkout');
    git(main, 'worktree', 'add', '-q', linked);
    expect([worktreeOf(linked, 'backend/src/a.py'), worktreeOf(linked, 'README.md')]).toEqual([null, null]);
    expect(await nestedRepos(linked)).toEqual([]);
  });

  it('returns null instead of throwing when the root is not a git repository', () => {
    const root = tempDir('wt-plain-');
    expect(worktreeOf(root, '.worktrees/wt1/a.py')).toBeNull();
  });

  it('returns null instead of throwing when git cannot be run', async () => {
    const { root } = await projectWithWorktree();
    vi.stubEnv('PATH', tempDir('wt-no-git-'));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    expect(worktreeOf(root, A)).toBeNull();
    await expect(refreshWorktrees(root)).resolves.toBeUndefined();
    await expect(nestedRepos(root)).resolves.toEqual([]);
  });
});

describe('worktreeOf as a worktree comes and goes', () => {
  it('finds a worktree added after the first lookup once the listing is older than its TTL, and not before', async () => {
    const { root } = await projectWithWorktree();
    frozenClock();
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toBeNull();
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    vi.setSystemTime(START + 2_000);
    await refreshWorktrees(root);
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toBeNull();
    vi.setSystemTime(START + 3_500);
    await refreshWorktrees(root);
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toMatchObject({ dir: '.worktrees/wt2', inner: 'backend/src/a.py' });
  });

  it('finds a worktree added after the first lookup as soon as the cache is invalidated, whatever its age', async () => {
    const { root } = await projectWithWorktree();
    frozenClock();
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toBeNull();
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    invalidateWorktrees(root);
    await refreshWorktrees(root);
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toMatchObject({ dir: '.worktrees/wt2' });
  });

  it('lists the worktrees once for several refreshes inside the TTL', async () => {
    const { root } = await projectWithWorktree();
    frozenClock();
    await refreshWorktrees(root);
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    await Promise.all([refreshWorktrees(root), refreshWorktrees(root)]);
    expect((await nestedRepos(root)).map((repo) => repo.dir)).toEqual(['.worktrees/wt1']);
  });

  it('does not take a listing that was under way when the cache was invalidated as a fresh one', async () => {
    const { root } = await projectWithWorktree();
    frozenClock();
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toBeNull();
    vi.setSystemTime(START + 5_000);
    held.on = true;
    onTestFinished(() => { held.on = false; held.calls.length = 0; });
    const stale = refreshWorktrees(root);
    await waitFor(() => held.calls.length > 0, 'the listing finished and waiting');
    held.on = false;
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    invalidateWorktrees(root);
    for (const release of held.calls.splice(0)) release();
    await stale;
    await refreshWorktrees(root);
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toMatchObject({ dir: '.worktrees/wt2' });
  });

  it('does not let a listing that started before the invalidation overwrite the newer one that overtook it', async () => {
    const { root } = await projectWithWorktree();
    frozenClock();
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toBeNull();
    vi.setSystemTime(START + 5_000);
    held.on = true;
    onTestFinished(() => { held.on = false; held.calls.length = 0; });
    const stale = refreshWorktrees(root);
    await waitFor(() => held.calls.length > 0, 'the old listing finished and waiting');
    held.on = false;
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    invalidateWorktrees(root);
    const fresh = refreshWorktrees(root);
    await waitFor(() => worktreeOf(root, '.worktrees/wt2/backend/src/a.py'), 'the newer listing taken', 2_000);
    for (const release of held.calls.splice(0)) release();
    await Promise.all([stale, fresh]);
    expect(worktreeOf(root, '.worktrees/wt2/backend/src/a.py')).toMatchObject({ dir: '.worktrees/wt2' });
    expect((await nestedRepos(root)).map((repo) => repo.dir).sort()).toEqual(['.worktrees/wt1', '.worktrees/wt2']);
  });

  it('stops resolving a removed worktree at once, before the cached listing is refreshed', async () => {
    const { root } = await projectWithWorktree();
    expect(worktreeOf(root, A)).not.toBeNull();
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    expect(worktreeOf(root, A)).toBeNull();
  });

  it('resolves a worktree again when one is created at the same place', async () => {
    const { root } = await projectWithWorktree();
    expect(worktreeOf(root, A)).not.toBeNull();
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    expect(worktreeOf(root, A)).toBeNull();
    git(root, 'worktree', 'add', '-q', '.worktrees/wt1', '-b', 'again');
    expect(worktreeOf(root, A)).toMatchObject({ dir: '.worktrees/wt1' });
  });
});

describe('nestedRepos', () => {
  it('lists each worktree with its directory and absolute path, and never the root', async () => {
    const { root, wt } = await projectWithWorktree();
    expect(await nestedRepos(root)).toEqual([{ dir: '.worktrees/wt1', abs: wt }]);
  });

  it('is empty for a project without worktrees', async () => {
    const { root } = await projectWithWorktree();
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    invalidateWorktrees(root);
    expect(await nestedRepos(root)).toEqual([]);
  });

  it('leaves out a worktree whose directory is gone before git has pruned it', async () => {
    const { root, wt } = await projectWithWorktree();
    rmSync(wt, { recursive: true });
    invalidateWorktrees(root);
    expect(await nestedRepos(root)).toEqual([]);
  });
});

describe('discoverNestedRepo', () => {
  // A worktree of the project added after the listing was read, so only discovery can find it; a clone is not one.
  async function projectWithLateWorktree() {
    const project = await projectWithWorktree({ '.gitignore': '.worktrees/\nvendor/\n' });
    worktreeOf(project.root, 'README.md');
    git(project.root, 'worktree', 'add', '-q', 'vendor/late1');
    return { ...project, late: join(project.root, 'vendor/late1') };
  }

  it('finds the nearest enclosing worktree of a path and remembers it for worktreeOf', async () => {
    const { root, late } = await projectWithLateWorktree();
    expect(worktreeOf(root, 'vendor/late1/backend/src/a.py')).toBeNull();
    expect(discoverNestedRepo(root, 'vendor/late1/backend/src/a.py')).toEqual({ worktreeRoot: late, dir: 'vendor/late1', inner: 'backend/src/a.py' });
    expect(worktreeOf(root, 'vendor/late1/backend/src/other.py')).toEqual({ worktreeRoot: late, dir: 'vendor/late1', inner: 'backend/src/other.py' });
    expect(await nestedRepos(root)).toEqual(expect.arrayContaining([{ dir: 'vendor/late1', abs: late }]));
  });

  it('returns null for a path with no repository above it', async () => {
    const { root } = await projectWithLateWorktree();
    mkdirSync(join(root, 'vendor/plain'), { recursive: true });
    expect([discoverNestedRepo(root, 'vendor/plain/x.py'), discoverNestedRepo(root, 'README.md'), discoverNestedRepo(root, 'vendor/x.py')]).toEqual([null, null, null]);
  });

  it('never looks inside dependency, cache or git directories', async () => {
    const { root } = await projectWithLateWorktree();
    const paths = ['vendor/late1/node_modules/p/i.js', 'vendor/late1/.venv/lib.py', 'vendor/late1/__pycache__/m.pyc', 'vendor/late1/.git/config'];
    expect(paths.map((rel) => discoverNestedRepo(root, rel))).toEqual([null, null, null, null]);
  });

  it('sees a worktree created after a negative answer once that answer is older than the TTL', async () => {
    const { root } = await projectWithLateWorktree();
    frozenClock();
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toBeNull();
    git(root, 'worktree', 'add', '-q', 'vendor/later');
    vi.setSystemTime(START + 2_000);
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toBeNull();
    vi.setSystemTime(START + 3_500);
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toMatchObject({ dir: 'vendor/later', inner: 'src/x.py' });
  });

  it('does not see a worktree created after a negative answer until the cache is invalidated', async () => {
    const { root } = await projectWithLateWorktree();
    frozenClock();
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toBeNull();
    git(root, 'worktree', 'add', '-q', 'vendor/later');
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toBeNull();
    invalidateWorktrees(root);
    expect(discoverNestedRepo(root, 'vendor/later/src/x.py')).toMatchObject({ dir: 'vendor/later', inner: 'src/x.py' });
  });
});

describe('repoIdentity', () => {
  it('is null where there is no repository', async () => {
    const { root } = await projectWithWorktree();
    expect(repoIdentity(join(root, 'backend'))).toBeNull();
  });

  it('is stable for one repository and differs once another one replaces it', async () => {
    const { root, wt } = await projectWithWorktree();
    const first = repoIdentity(wt);
    expect([typeof first, repoIdentity(wt)]).toEqual(['string', first]);
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    git(root, 'worktree', 'add', '-q', '.worktrees/wt1', '-b', 'again');
    expect(repoIdentity(wt)).not.toBeNull();
    expect(repoIdentity(wt)).not.toBe(first);
  });
});

describe('which directories count as worktrees of the project', () => {
  async function projectWithOthers() {
    const project = await projectWithWorktree({ '.gitignore': '.worktrees/\nvendor/\n' });
    const { root } = project;
    const unrelated = tempDir('wt-unrelated-');
    git(unrelated, 'init', '-q');
    await writeTree(unrelated, { 'lib/x.ex': 'x\n' });
    git(unrelated, 'add', '-A');
    git(unrelated, 'commit', '-q', '-m', 'other');
    git(root, 'clone', '-q', root, join(root, 'vendor/clone1'));
    git(root, 'clone', '-q', unrelated, join(root, 'vendor/unrelated'));
    git(unrelated, 'worktree', 'add', '-q', join(root, 'vendor/foreign'));
    mkdirSync(join(root, 'vendor/plain'), { recursive: true });
    return project;
  }

  it('says yes for a worktree of the repository of the project and no for a clone, another repository, a worktree of another repository, a plain directory and a missing one', async () => {
    const { root } = await projectWithOthers();
    const dirs = ['.worktrees/wt1', 'vendor/clone1', 'vendor/unrelated', 'vendor/foreign', 'vendor/plain', 'vendor/missing'];
    expect(dirs.map((dir) => isWorktreeDir(root, dir))).toEqual([true, false, false, false, false, false]);
  });

  it('still counts a worktree whose .git file reaches the repository through a symbolic link', async () => {
    const { root, wt } = await projectWithWorktree();
    const alias = join(tempDir('wt-alias-'), 'repo-git');
    symlinkSync(join(root, '.git'), alias);
    const dotgit = join(wt, '.git');
    writeFileSync(dotgit, readFileSync(dotgit, 'utf8').replace(join(root, '.git'), alias));
    expect(isWorktreeDir(root, '.worktrees/wt1')).toBe(true);
  });

  it('says no for the submodule of the project', async () => {
    const lib = await submoduleSource();
    const { root } = await projectWithWorktree({}, '.worktrees/wt1', (repo) => { addSubmodule(repo, lib, 'vendor/lib'); });
    expect(isWorktreeDir(root, 'vendor/lib')).toBe(false);
  });

  it('cannot say when git cannot be run', async () => {
    const { root } = await projectWithWorktree();
    vi.stubEnv('PATH', tempDir('wt-no-git-'));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    expect(isWorktreeDir(root, '.worktrees/wt1')).toBeNull();
  });

  it('does not discover a clone, another repository or a foreign worktree around a path', async () => {
    const { root } = await projectWithOthers();
    const paths = ['vendor/clone1/backend/src/a.py', 'vendor/unrelated/lib/x.ex', 'vendor/foreign/lib/x.ex'];
    expect(paths.map((rel) => discoverNestedRepo(root, rel))).toEqual([null, null, null]);
  });

  it('does not list them among the nested repositories even when they are known from before', async () => {
    const { root, wt } = await projectWithOthers();
    const repos = await nestedRepos(root, ['vendor/clone1', 'vendor/unrelated', 'vendor/foreign', 'vendor/plain', '.worktrees/wt1']);
    expect(repos).toEqual([{ dir: '.worktrees/wt1', abs: wt }]);
  });

  it('lists a known worktree git does not list, and recognizes its files afterwards', async () => {
    const { root, wt } = await projectWithWorktree();
    const late = join(root, 'trees/late');
    frozenClock();
    await refreshWorktrees(root);
    git(root, 'worktree', 'add', '-q', late);
    await refreshWorktrees(root);
    expect(worktreeOf(root, 'trees/late/backend/src/a.py')).toBeNull();
    expect(await nestedRepos(root, ['trees/late'])).toEqual(expect.arrayContaining([{ dir: '.worktrees/wt1', abs: wt }, { dir: 'trees/late', abs: late }]));
    expect(worktreeOf(root, 'trees/late/backend/src/a.py')).toMatchObject({ dir: 'trees/late' });
  });
});

describe('where the project lies in its repository', () => {
  it('names a file of a worktree by its path inside it when the project is the top of its repository', async () => {
    const { root } = await projectWithWorktree();
    const hit = worktreeOf(root, A)!;
    expect([projectPrefix(root), scopeRelOf(root, hit)]).toEqual(['', 'backend/src/a.py']);
  });

  it('cuts the directory of the project off the path inside the worktree when the project is a subdirectory of its repository', async () => {
    const { root } = await monorepoWithWorktree();
    const hit = worktreeOf(root, '.worktrees/wt1/packages/app/src/a.py')!;
    expect([hit.inner, projectPrefix(root), scopeRelOf(root, hit)]).toEqual(['packages/app/src/a.py', 'packages/app/', 'src/a.py']);
  });

  it('has the empty name for the equivalent of the project root and none for a path beyond the part that holds the project', async () => {
    const { root, wt } = await monorepoWithWorktree();
    const at = (inner: string) => scopeRelOf(root, { worktreeRoot: wt, dir: '.worktrees/wt1', inner });
    expect([at('packages/app'), at('packages/other/x.py'), at('packages/application/x.py'), at('README.md'), at('packages')]).toEqual(['', null, null, null, null]);
  });
});

describe('repoOrigin', () => {
  it('is null where there is no repository', async () => {
    const { root } = await projectWithWorktree();
    expect(repoOrigin(join(root, 'backend'))).toBeNull();
  });

  it('is kept when the .git file is written anew, which changes the identity of the repository but not its git dir or HEAD', async () => {
    const { wt } = await projectWithWorktree();
    const [identity, origin] = [repoIdentity(wt), repoOrigin(wt)];
    rewriteDotGit(wt);
    expect([typeof origin, repoOrigin(wt)]).toEqual(['string', origin]);
    expect(repoIdentity(wt)).not.toBe(identity);
  });

  it('differs for a worktree created at the same place on another branch', async () => {
    const { root, wt } = await projectWithWorktree();
    const origin = repoOrigin(wt);
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    git(root, 'worktree', 'add', '-q', '.worktrees/wt1', '-b', 'again');
    expect(repoOrigin(wt)).not.toBe(origin);
  });
});
