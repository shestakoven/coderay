import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers';
import { isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

describe('GitService.status', () => {
  it('reports the branch and each file by its index and work-tree side', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    await put(root, { 'a.txt': 'a2\n', 'new file.txt': 'n\n', 'b.txt': 'b2\n' });
    sh(root, 'add', 'b.txt');
    await put(root, { 'b.txt': 'b3\n' });
    const status = await service(root).git.status();
    expect(status).toMatchObject({ repo: true, branch: 'main', detached: false, upstream: null, operation: null, busy: null, problem: null });
    expect(Object.fromEntries(status.files.map((f) => [f.path, [f.index, f.worktree]]))).toEqual({
      'a.txt': [null, 'modified'],
      'b.txt': ['modified', 'modified'],
      'new file.txt': [null, 'untracked'],
    });
  });

  it('is not a repository outside one, and says nothing is wrong', async () => {
    const status = await service(tempDir('plain-')).git.status();
    expect(status).toMatchObject({ repo: false, files: [], problem: null });
  });

  it('reads a repository without commits', async () => {
    const root = await makeRepo({}, false);
    await put(root, { 'a.txt': 'a\n' });
    const status = await service(root).git.status();
    expect(status).toMatchObject({ repo: true, branch: 'main', sha: null });
    expect(status.files.map((f) => [f.path, f.worktree])).toEqual([['a.txt', 'untracked']]);
  });

  it('names a detached head by its sha', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    sh(root, 'checkout', '-q', '--detach');
    const status = await service(root).git.status();
    expect(status).toMatchObject({ detached: true, branch: null });
    expect(status.sha).toHaveLength(40);
  });

  it('lists paths from the repository top when the project is a subfolder', async () => {
    const root = await makeRepo({ 'sub/x.txt': 'x\n', 'top.txt': 't\n' });
    await put(root, { 'sub/x.txt': 'x2\n', 'top.txt': 't2\n' });
    const status = await service(join(root, 'sub')).git.status();
    expect(status.files.map((f) => f.path).sort()).toEqual(['sub/x.txt', 'top.txt']);
  });

  it('reports a merge in progress', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), `${sh(root, 'rev-parse', 'HEAD').trim()}\n`);
    expect((await service(root).git.status()).operation).toBe('merge');
  });
});

describe('GitService.branches', () => {
  it('lists local branches with the current one flagged', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    sh(root, 'branch', 'feature');
    const branches = await service(root).git.branches();
    expect(branches.map((b) => [b.name, b.current])).toEqual(expect.arrayContaining([['main', true], ['feature', false]]));
  });
});

describe('GitService.diff', () => {
  it('shows an unstaged edit against the index and a staged one against HEAD', async () => {
    const root = await makeRepo({ 'a.txt': 'one\ntwo\n' });
    await put(root, { 'a.txt': 'one\nTWO\n' });
    const { git } = service(root);
    const unstaged = await git.diff('a.txt', 'unstaged');
    expect(unstaged).toMatchObject({ added: 1, removed: 1, binary: false });
    expect(unstaged.hunks[0]!.lines).toContainEqual({ op: 'add', text: 'TWO' });
    sh(root, 'add', 'a.txt');
    expect((await git.diff('a.txt', 'unstaged')).hunks).toEqual([]);
    expect(await git.diff('a.txt', 'staged')).toMatchObject({ added: 1, removed: 1 });
  });

  it('shows an untracked file as all added', async () => {
    const root = await makeRepo({ 'seed.txt': 's\n' });
    await put(root, { 'new.txt': 'x\ny\n' });
    expect(await service(root).git.diff('new.txt', 'unstaged')).toMatchObject({ added: 2, removed: 0 });
  });

  it('marks a binary file', async () => {
    const root = await makeRepo({ 'seed.txt': 's\n' });
    await put(root, { 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) });
    expect(await service(root).git.diff('bin.dat', 'unstaged')).toMatchObject({ binary: true, hunks: [] });
  });

  it('reads the staged diff of the first commit', async () => {
    const root = await makeRepo({}, false);
    await put(root, { 'a.txt': 'hello\n' });
    sh(root, 'add', 'a.txt');
    expect(await service(root).git.diff('a.txt', 'staged')).toMatchObject({ added: 1, removed: 0 });
  });

  it('refuses a path that leaves the project or reaches into .git', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git } = service(root);
    for (const path of ['../x', '/etc/passwd', '.git/config', 'a/../b', '']) await expect(git.diff(path, 'unstaged')).rejects.toThrow('is not a path inside the project');
  });
});
