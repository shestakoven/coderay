import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPaths } from '../../src/gate/paths';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { tempDir, writeTree } from '../helpers';
import { addSubmodule, git, isolateGit, monorepoWithWorktree, projectWithWorktree, submoduleSource } from '../worktree-fixture';

isolateGit();

const WT = '.worktrees/wt1';

async function classify(root: string, rels: string[]) {
  return classifyPaths(rels.map((rel) => join(root, rel)), { root, policy: DEFAULT_POLICY, home: tempDir('ide-fake-home-'), tempRoots: [] });
}

describe('classifyPaths in a nested worktree', () => {
  it('enforces a project file of the worktree, naming it by its real path and by its path inside the worktree', async () => {
    const { root } = await projectWithWorktree();
    const [info] = await classify(root, [`${WT}/backend/src/a.py`]);
    expect(info).toMatchObject({ rel: `${WT}/backend/src/a.py`, cls: 'enforced', guarded: false, exists: true, isDir: false, scopeRel: 'backend/src/a.py' });
  });

  it('enforces a file the worktree does not have yet', async () => {
    const { root } = await projectWithWorktree();
    const [info] = await classify(root, [`${WT}/backend/src/new.py`]);
    expect(info).toMatchObject({ rel: `${WT}/backend/src/new.py`, cls: 'enforced', exists: false, scopeRel: 'backend/src/new.py' });
  });

  it('enforces a directory of the worktree by its path inside it', async () => {
    const { root } = await projectWithWorktree();
    const [info] = await classify(root, [`${WT}/backend`]);
    expect(info).toMatchObject({ rel: `${WT}/backend`, cls: 'enforced', isDir: true, scopeRel: 'backend' });
  });

  it('does not record a path the outer repository ignores only because of ".worktrees/"', async () => {
    const { root } = await projectWithWorktree();
    const [info] = await classify(root, [`${WT}/README.md`]);
    expect([info!.cls, info!.why]).not.toEqual(['recorded', 'gitignored']);
    expect(info!.cls).toBe('enforced');
  });

  it("records a file the worktree's own .gitignore ignores", async () => {
    const { root } = await projectWithWorktree();
    const infos = await classify(root, [`${WT}/dist/x.js`, `${WT}/dist/new.js`]);
    expect(infos.map((info) => [info.rel, info.cls, info.why, info.scopeRel])).toEqual([
      [`${WT}/dist/x.js`, 'recorded', 'gitignored', 'dist/x.js'],
      [`${WT}/dist/new.js`, 'recorded', 'gitignored', 'dist/new.js'],
    ]);
  });

  it('reads the .gitignore of the worktree, not the one of the project', async () => {
    const { root, wt } = await projectWithWorktree();
    writeFileSync(join(wt, '.gitignore'), '.worktrees/\ndist/\ngenerated/\n');
    const infos = await classify(root, [`${WT}/generated/g.py`, `${WT}/backend/src/a.py`, 'generated/g.py']);
    expect(infos.map((info) => info.cls)).toEqual(['recorded', 'enforced', 'enforced']);
  });

  it('keeps a tracked file of the worktree enforced although its .gitignore matches it', async () => {
    const { root, wt } = await projectWithWorktree();
    writeFileSync(join(wt, '.gitignore'), '.worktrees/\ndist/\nbackend/src/a.py\n');
    const infos = await classify(root, [`${WT}/backend/src/a.py`, `${WT}/backend/src/new.py`]);
    expect(infos.map((info) => info.cls)).toEqual(['enforced', 'enforced']);
    writeFileSync(join(wt, '.gitignore'), '.worktrees/\ndist/\nbackend/src/new.py\n');
    expect((await classify(root, [`${WT}/backend/src/new.py`]))[0]!.cls).toBe('recorded');
  });

  it('guards a secret inside the worktree even when the worktree ignores it', async () => {
    const { root, wt } = await projectWithWorktree();
    writeFileSync(join(wt, '.gitignore'), '.worktrees/\n.env*\n');
    const infos = await classify(root, [`${WT}/.env`, `${WT}/backend/.env.local`]);
    expect(infos.map((info) => [info.cls, info.guarded, info.scopeRel])).toEqual([['enforced', true, '.env'], ['enforced', true, 'backend/.env.local']]);
  });

  it('records a harness path inside the worktree', async () => {
    const { root, wt } = await projectWithWorktree();
    mkdirSync(join(wt, '.omc'));
    const infos = await classify(root, [`${WT}/.omc/state.json`, `${WT}/.omc`]);
    expect(infos.map((info) => [info.cls, info.why])).toEqual([['recorded', 'a harness path'], ['recorded', 'a harness path']]);
  });

  it('classifies ordinary project files as before, with no inner name', async () => {
    const { root } = await projectWithWorktree();
    const infos = await classify(root, ['backend/src/a.py', 'backend/src/new.py', 'dist/x.js']);
    expect(infos.map((info) => [info.cls, info.why, info.scopeRel ?? info.rel])).toEqual([
      ['enforced', 'a project file', 'backend/src/a.py'],
      ['enforced', 'a project file', 'backend/src/new.py'],
      ['recorded', 'gitignored', 'dist/x.js'],
    ]);
  });

  it('classifies files of the worktree and of the project in one call, each by its own repository', async () => {
    const { root } = await projectWithWorktree();
    const infos = await classify(root, ['dist/x.js', `${WT}/backend/src/a.py`, `${WT}/dist/x.js`, 'backend/src/a.py']);
    expect(infos.map((info) => info.cls)).toEqual(['recorded', 'enforced', 'recorded', 'enforced']);
  });

  it('finds a worktree the project does not ignore, created after the first classification, as soon as its .git is among the paths', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': 'dist/\n' });
    await classify(root, [`${WT}/backend/src/a.py`]);
    git(root, 'worktree', 'add', '-q', 'trees/wt2');
    const infos = await classify(root, ['trees/wt2/.git', 'trees/wt2/backend/src/a.py']);
    expect(infos[1]).toMatchObject({ rel: 'trees/wt2/backend/src/a.py', cls: 'enforced', scopeRel: 'backend/src/a.py' });
  });

  it('finds a worktree the project does not ignore, created after the first classification, when the cache is invalidated', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': 'dist/\n' });
    await classify(root, [`${WT}/backend/src/a.py`]);
    git(root, 'worktree', 'add', '-q', 'trees/wt2');
    invalidateWorktrees(root);
    expect((await classify(root, ['trees/wt2/backend/src/a.py']))[0]).toMatchObject({ cls: 'enforced', scopeRel: 'backend/src/a.py' });
  });

  it('finds a worktree the project ignores, created after the first classification, by the repository around the path', async () => {
    const { root } = await projectWithWorktree();
    await classify(root, [`${WT}/backend/src/a.py`]);
    git(root, 'worktree', 'add', '-q', '.worktrees/wt2');
    expect((await classify(root, ['.worktrees/wt2/backend/src/a.py']))[0]).toMatchObject({ cls: 'enforced', scopeRel: 'backend/src/a.py' });
  });

  it('judges a file of a removed worktree by the outer repository again', async () => {
    const { root } = await projectWithWorktree();
    await classify(root, [`${WT}/backend/src/a.py`]);
    git(root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    const [info] = await classify(root, [`${WT}/backend/src/a.py`]);
    expect([info!.cls, info!.why, info!.scopeRel]).toEqual(['recorded', 'gitignored', undefined]);
  });
});

describe('classifyPaths in a nested clone', () => {
  async function projectWithClone() {
    const project = await projectWithWorktree({ '.gitignore': '.worktrees/\nvendor/\ndist/\n' });
    git(project.root, 'clone', '-q', project.root, 'vendor/clone1');
    return project;
  }

  it('records a file of a clone in an ignored directory as gitignored: a clone is not a worktree of the project', async () => {
    const { root } = await projectWithClone();
    const [info] = await classify(root, ['vendor/clone1/backend/src/a.py']);
    expect([info!.cls, info!.why, info!.scopeRel]).toEqual(['recorded', 'gitignored', undefined]);
  });

  it("records a file of the clone that the clone's own .gitignore ignores, with no inner name", async () => {
    const { root } = await projectWithClone();
    const [info] = await classify(root, ['vendor/clone1/dist/x.js']);
    expect([info!.cls, info!.why, info!.scopeRel]).toEqual(['recorded', 'gitignored', undefined]);
  });

  it('still records a file of an ignored directory that holds no repository', async () => {
    const { root } = await projectWithClone();
    mkdirSync(join(root, 'vendor/plain'), { recursive: true });
    await writeTree(root, { 'vendor/plain/x.py': 'x' });
    const [info] = await classify(root, ['vendor/plain/x.py']);
    expect([info!.cls, info!.why, info!.scopeRel]).toEqual(['recorded', 'gitignored', undefined]);
  });

  it('keeps a clone that the project does not ignore as ordinary project content', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': '.worktrees/\n' });
    git(root, 'clone', '-q', root, 'vendor/clone1');
    const [info] = await classify(root, ['vendor/clone1/backend/src/a.py']);
    expect([info!.cls, info!.scopeRel]).toEqual(['enforced', undefined]);
  });
});

describe('classifyPaths for a repository that is not a worktree of the project', () => {
  async function unrelatedRepo(): Promise<string> {
    const other = tempDir('wt-other-');
    git(other, 'init', '-q');
    await writeTree(other, { 'lib/x.ex': 'x\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other');
    return other;
  }
  const view = (infos: Awaited<ReturnType<typeof classify>>) => infos.map((info) => [info.cls, info.why, info.scopeRel]);

  it('keeps the file of a repository that is not the project, in a directory the project ignores, recorded as gitignored', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': '.worktrees/\ndeps/\n' });
    git(await unrelatedRepo(), 'worktree', 'add', '-q', join(root, 'deps/foo'));
    git(root, 'clone', '-q', await unrelatedRepo(), join(root, 'deps/bar'));
    expect(view(await classify(root, ['deps/foo/lib/x.ex', 'deps/bar/lib/x.ex']))).toEqual([['recorded', 'gitignored', undefined], ['recorded', 'gitignored', undefined]]);
  });

  it('judges the file of such a repository the project does not ignore by its own path, with no inner name', async () => {
    const { root } = await projectWithWorktree();
    git(root, 'clone', '-q', await unrelatedRepo(), join(root, 'deps/foo'));
    expect(view(await classify(root, ['deps/foo/lib/x.ex', 'deps/foo/lib/new.ex']))).toEqual([['enforced', 'a project file', undefined], ['enforced', 'a project file', undefined]]);
  });

  it('does not take a worktree of the project that lies in the project of a clone for one', async () => {
    const { root } = await projectWithWorktree({ '.gitignore': '.worktrees/\nvendor/\n' });
    const clone = join(root, 'vendor/clone1');
    git(root, 'clone', '-q', root, clone);
    git(clone, 'worktree', 'add', '-q', 'inner');
    expect(view(await classify(root, ['vendor/clone1/inner/backend/src/a.py']))).toEqual([['recorded', 'gitignored', undefined]]);
  });

  it('recognizes the worktrees of a project given by a path through a symbolic link', async () => {
    const { root } = await projectWithWorktree();
    const link = join(tempDir('wt-link-'), 'project');
    symlinkSync(root, link);
    const [info] = await classify(link, [`${WT}/backend/src/a.py`]);
    expect(info).toMatchObject({ rel: `${WT}/backend/src/a.py`, cls: 'enforced', scopeRel: 'backend/src/a.py' });
  });
});

describe('classifyPaths for a worktree gone from a place the project does not ignore', () => {
  it.each([
    ['not gitignored', 'trees/w1', false],
    ['guarded', '.claude/worktrees/w1', true],
  ] as const)('judges a file in a %s place by the outer repository again once the worktree is removed', async (_kind, dir, guarded) => {
    const { root } = await projectWithWorktree({}, dir);
    const rel = `${dir}/backend/src/a.py`;
    expect((await classify(root, [rel]))[0]).toMatchObject({ cls: 'enforced', scopeRel: 'backend/src/a.py' });
    git(root, 'worktree', 'remove', '--force', dir);
    const [info] = await classify(root, [rel]);
    expect([info!.cls, info!.guarded, info!.scopeRel]).toEqual(['enforced', guarded, undefined]);
  });
});

describe('classifyPaths for paths inside a submodule', () => {
  async function projectWithSubmodule() {
    const lib = await submoduleSource();
    const project = await projectWithWorktree({}, WT, (root) => addSubmodule(root, lib, 'vendor/lib'));
    git(project.wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
    return project;
  }

  it('records the files of a submodule of the project as inside a submodule and classifies the others in the batch by their own rules', async () => {
    const { root } = await projectWithSubmodule();
    const infos = await classify(root, ['dist/x.js', 'vendor/lib/lib.py', 'backend/src/a.py', 'vendor/lib/new.py']);
    expect(infos.map((info) => [info.cls, info.why])).toEqual([
      ['recorded', 'gitignored'], ['recorded', 'inside a submodule'], ['enforced', 'a project file'], ['recorded', 'inside a submodule'],
    ]);
  });

  it('does the same for the submodule of a worktree, in a batch with files of the worktree and of the project', async () => {
    const { root } = await projectWithSubmodule();
    const infos = await classify(root, [`${WT}/dist/x.js`, `${WT}/vendor/lib/lib.py`, `${WT}/backend/src/a.py`, 'vendor/lib/lib.py', 'dist/x.js']);
    expect(infos.map((info) => [info.cls, info.why])).toEqual([
      ['recorded', 'gitignored'], ['recorded', 'inside a submodule'], ['enforced', 'a project file in a nested worktree'], ['recorded', 'inside a submodule'], ['recorded', 'gitignored'],
    ]);
  });
});

describe('classifyPaths for a project that is a directory of a larger repository', () => {
  const INNER = '.worktrees/wt1/packages/app';

  it('names a file of the worktree by its path from the equivalent of the project root', async () => {
    const { root } = await monorepoWithWorktree();
    const [info] = await classify(root, [`${INNER}/src/a.py`]);
    expect(info).toMatchObject({ rel: `${INNER}/src/a.py`, cls: 'enforced', scopeRel: 'src/a.py' });
  });

  it('records a file of the worktree beyond the part that holds the project as outside the project', async () => {
    const { root } = await monorepoWithWorktree();
    const infos = await classify(root, ['.worktrees/wt1/packages/other/x.py', '.worktrees/wt1/README.md', '.worktrees/wt1/packages']);
    expect(infos.map((info) => [info.cls, info.why, info.scopeRel])).toEqual(Array(3).fill(['recorded', 'outside the project in a nested worktree', undefined]));
  });

  it('enforces the equivalent of the project root itself, naming it by the empty path', async () => {
    const { root } = await monorepoWithWorktree();
    const [info] = await classify(root, [INNER]);
    expect([info!.cls, info!.why, info!.scopeRel]).toEqual(['enforced', 'the project root in a nested worktree', '']);
  });

  it("applies the worktree's own ignore rules to a file in the part that holds the project, and keeps a secret guarded", async () => {
    const { root } = await monorepoWithWorktree();
    const infos = await classify(root, [`${INNER}/dist/x.js`, `${INNER}/.env`]);
    expect(infos.map((info) => [info.cls, info.guarded, info.scopeRel])).toEqual([['recorded', false, 'dist/x.js'], ['enforced', true, '.env']]);
  });

  it('records the files of a submodule in the part that holds the project as inside a submodule', async () => {
    const { repo, root } = await monorepoWithWorktree();
    addSubmodule(repo, await submoduleSource(), 'packages/app/vendor/lib');
    const infos = await classify(root, ['vendor/lib/lib.py', 'dist/x.js']);
    expect(infos.map((info) => info.why)).toEqual(['inside a submodule', 'gitignored']);
  });
});
