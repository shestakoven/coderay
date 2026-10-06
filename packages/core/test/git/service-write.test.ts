import { chmodSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitStatus } from '@ide/protocol';
import { isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

const sides = (status: GitStatus): Record<string, unknown> => Object.fromEntries(status.files.map((f) => [f.path, [f.index, f.worktree]]));

describe('GitService writes', () => {
  it('stages, unstages and commits exactly the named files, even names that look like options, globs and non-ASCII', async () => {
    const root = await makeRepo({ 'seed.txt': 's\n' });
    const names = ['a b.txt', '-n.txt', '*.ts', 'é.txt'];
    await put(root, { ...Object.fromEntries(names.map((n) => [n, `${n}\n`])), 'b.ts': 'b\n' });
    const { git } = service(root);
    await git.stage(names);
    expect(sides(await git.status())).toEqual({ ...Object.fromEntries(names.map((n) => [n, ['added', null]])), 'b.ts': [null, 'untracked'] });
    await git.unstage(['-n.txt']);
    await git.commit('add files\n\nbody text');
    const message = sh(root, 'log', '-1', '--format=%B');
    expect(message).toContain('add files');
    expect(message).toContain('body text');
    const committed = sh(root, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
    expect(committed).toEqual(['*.ts', 'a b.txt', 'é.txt']);
    expect(sides(await git.status())).toEqual({ '-n.txt': [null, 'untracked'], 'b.ts': [null, 'untracked'] });
  });

  it('stages and unstages everything at once, deletions included', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await rm(join(root, 'a.txt'));
    await put(root, { 'c.txt': 'c\n' });
    const { git } = service(root);
    await git.stage('all');
    expect(sides(await git.status())).toEqual({ 'a.txt': ['deleted', null], 'c.txt': ['added', null] });
    await git.unstage('all');
    expect(sides(await git.status())).toEqual({ 'a.txt': [null, 'deleted'], 'c.txt': [null, 'untracked'] });
  });

  it('stages, unstages and makes the first commit in a repository without commits', async () => {
    const root = await makeRepo({}, false);
    await put(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const { git } = service(root);
    await git.stage(['a.txt']);
    await git.unstage(['a.txt']);
    expect(sides(await git.status())).toEqual({ 'a.txt': [null, 'untracked'], 'b.txt': [null, 'untracked'] });
    await git.stage('all');
    await git.unstage('all');
    expect(sides(await git.status())).toEqual({ 'a.txt': [null, 'untracked'], 'b.txt': [null, 'untracked'] });
    await git.stage(['a.txt']);
    await git.commit('first');
    expect((await git.status()).sha).toHaveLength(40);
  });

  it('shows what a failing hook printed and keeps the index', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    await put(root, { 'a.txt': 'b\n' });
    const { git } = service(root);
    await git.stage(['a.txt']);
    await expect(git.commit('msg')).rejects.toThrow('lint failed');
    expect(sides(await git.status())['a.txt']).toEqual(['modified', null]);
  });

  it('runs twenty parallel stage calls without an index.lock race', async () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, `${i}\n`]));
    const root = await makeRepo({ 'seed.txt': 's\n' });
    await put(root, files);
    const { git } = service(root);
    await Promise.all(Object.keys(files).map((path) => git.stage([path])));
    expect(Object.values(sides(await git.status())).every((s) => (s as unknown[])[0] === 'added')).toBe(true);
  });

  it('deletes a merged branch and refuses an unmerged one', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    sh(root, 'branch', 'done');
    sh(root, 'checkout', '-q', '-b', 'wip');
    await put(root, { 'a.txt': 'wip\n' });
    sh(root, 'commit', '-q', '-am', 'wip');
    sh(root, 'checkout', '-q', 'main');
    const { git } = service(root);
    await git.branchDelete('done');
    await expect(git.branchDelete('wip')).rejects.toThrow(/not fully merged/);
    expect(sh(root, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()).toEqual(['main', 'wip']);
  });
});
