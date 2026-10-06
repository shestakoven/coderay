import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers';
import { hashOf, isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

const head = (root: string): string => sh(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

describe('GitService guarded operations', () => {
  it('refuses a switch, a branch create and a discard while the agent is busy, and still allows stage and commit', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    sh(root, 'branch', 'other');
    await put(root, { 'a.txt': 'x\n' });
    const { git, busy } = service(root);
    busy.reason = 'the agent is working';
    await expect(git.branchSwitch('other')).rejects.toThrow('Cannot switch branches while the agent is working.');
    await expect(git.branchCreate('new')).rejects.toThrow('Cannot create a branch while the agent is working.');
    await expect(git.discard(['a.txt'])).rejects.toThrow('Cannot discard changes while the agent is working.');
    expect(head(root)).toBe('main');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('x\n');
    expect((await git.status()).busy).toBe('the agent is working');
    await git.stage(['a.txt']);
    await git.commit('wip');
  });

  it('discards the work-tree side back to the index, deletes an untracked file, and claims both as IDE writes', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    await put(root, { 'a.txt': 'staged\n' });
    sh(root, 'add', 'a.txt');
    await put(root, { 'a.txt': 'edited\n', 'u.txt': 'u\n' });
    const { git, ideWrites } = service(root);
    await git.discard(['a.txt', 'u.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('staged\n');
    expect(existsSync(join(root, 'u.txt'))).toBe(false);
    expect((await git.status()).files).toEqual([expect.objectContaining({ path: 'a.txt', index: 'modified', worktree: null })]);
    expect(ideWrites.claim('a.txt', hashOf(root, 'a.txt'))).toBe(true);
    expect(ideWrites.claim('u.txt', null)).toBe(true);
  });

  it('discards only what the status lists, and nothing through a symlink out of the project', async () => {
    const root = await makeRepo({ 'seed.txt': 's\n' });
    const outside = tempDir('outside-');
    await put(outside, { 'secret.txt': 'keep\n' });
    symlinkSync(outside, join(root, 'link'));
    const { git } = service(root);
    await expect(git.discard(['seed.txt'])).rejects.toThrow('has no changes to discard');
    await expect(git.discard(['link/secret.txt'])).rejects.toThrow('has no changes to discard');
    await expect(git.discard(['../outside'])).rejects.toThrow('is not a path inside the project');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('keep\n');
  });

  it('creates a branch from HEAD and switches to it', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git } = service(root);
    await git.branchCreate('feature/x');
    expect(head(root)).toBe('feature/x');
    await expect(git.branchCreate('bad name')).rejects.toThrow('is not a valid branch name');
  });

  it('switches branch and claims every changed file with its new blob', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n', 'gone.txt': 'g\n' });
    sh(root, 'checkout', '-q', '-b', 'feature');
    await put(root, { 'a.txt': 'feature\n', 'new.txt': 'n\n' });
    await rm(join(root, 'gone.txt'));
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'f');
    sh(root, 'checkout', '-q', 'main');
    const { git, ideWrites } = service(root);
    await git.branchSwitch('feature');
    expect(head(root)).toBe('feature');
    expect(ideWrites.claim('a.txt', hashOf(root, 'a.txt'))).toBe(true);
    expect(ideWrites.claim('new.txt', hashOf(root, 'new.txt'))).toBe(true);
    expect(ideWrites.claim('gone.txt', null)).toBe(true);
  });

  it('claims only the paths inside the project folder, relative to it', async () => {
    const root = await makeRepo({ 'sub/x.txt': 'x\n', 'top.txt': 't\n' });
    sh(root, 'checkout', '-q', '-b', 'f');
    await put(root, { 'sub/x.txt': 'x2\n', 'top.txt': 't2\n' });
    sh(root, 'commit', '-q', '-am', 'f');
    sh(root, 'checkout', '-q', 'main');
    const { git, ideWrites } = service(join(root, 'sub'));
    await git.branchSwitch('f');
    expect(ideWrites.claim('x.txt', hashOf(root, 'sub/x.txt'))).toBe(true);
    expect(ideWrites.claim('top.txt', hashOf(root, 'top.txt'))).toBe(false);
    expect(ideWrites.claim('../top.txt', hashOf(root, 'top.txt'))).toBe(false);
  });
});
