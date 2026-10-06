import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers';
import { isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

describe('GitService.status', () => {
  it('reports the branch and each file by its index and work-tree side', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    await put(root, { 'a.txt': 'a2\n', 'new/file one.txt': 'n\n', 'b.txt': 'b2\n' });
    sh(root, 'add', 'b.txt');
    await put(root, { 'b.txt': 'b3\n' });
    const status = await service(root).git.status();
    expect(status).toMatchObject({ repo: true, branch: 'main', detached: false, upstream: null, operation: null, busy: null, problem: null });
    expect(Object.fromEntries(status.files.map((f) => [f.path, [f.index, f.worktree]]))).toEqual({
      'a.txt': [null, 'modified'],
      'b.txt': ['modified', 'modified'],
      'new/file one.txt': [null, 'untracked'],
    });
  });

  it('is not a repository in a plain folder, and says nothing is wrong, until the folder is initialized', async () => {
    const { git } = service(tempDir('plain-'));
    expect(await git.status()).toMatchObject({ repo: false, files: [], problem: null });
    await git.init();
    expect((await git.status()).repo).toBe(true);
  });

  it('shows and stages the whole repository when the project is a subfolder of it', async () => {
    const root = await makeRepo({ 'sub/x.txt': 'x\n', 'top.txt': 't\n' });
    await put(root, { 'sub/x.txt': 'x2\n', 'top.txt': 't2\n' });
    const { git } = service(join(root, 'sub'));
    expect((await git.status()).files.map((f) => f.path).sort()).toEqual(['sub/x.txt', 'top.txt']);
    await git.stage(['top.txt']);
    expect((await git.status()).files.find((f) => f.path === 'top.txt')).toMatchObject({ index: 'modified', worktree: null });
  });

  it.each([['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick']])('reads %s as a %s in progress', async (marker, operation) => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    writeFileSync(join(root, '.git', marker), `${sh(root, 'rev-parse', 'HEAD').trim()}\n`);
    expect((await service(root).git.status()).operation).toBe(operation);
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

  it('shows an untracked text file as all added and an untracked binary file as binary', async () => {
    const root = await makeRepo({ 'seed.txt': 's\n' });
    await put(root, { 'new.txt': 'x\ny\n', 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) });
    const { git } = service(root);
    expect(await git.diff('new.txt', 'unstaged')).toMatchObject({ added: 2, removed: 0, binary: false });
    expect(await git.diff('bin.dat', 'unstaged')).toMatchObject({ binary: true, hunks: [] });
  });

  it('refuses a path that leaves the project or reaches into .git', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git } = service(root);
    for (const path of ['../x', '/etc/passwd', '.git/config', 'a/../b', '']) await expect(git.diff(path, 'unstaged')).rejects.toThrow('is not a path inside the project');
  });
});
