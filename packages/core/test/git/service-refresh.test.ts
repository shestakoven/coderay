import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitStatus } from '@ide/protocol';
import { isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

const paths = (status: GitStatus | undefined): string[] => status?.files.map((f) => f.path) ?? [];
const wait = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

describe('GitService refresh', () => {
  it('broadcasts a status when the working tree changes, and only when it changed', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git } = service(root, { debounceMs: 20 });
    const seen: GitStatus[] = [];
    git.onStatus((status) => seen.push(status));
    git.start();
    await wait(() => expect(seen).toHaveLength(1));
    await git.ready();
    await put(root, { 'a.txt': 'b\n' });
    await wait(() => expect(paths(seen.at(-1))).toEqual(['a.txt']));
    const count = seen.length;
    git.poke();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(count);
  });

  it('sees what git does outside the IDE, such as a git add typed in a terminal', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    await put(root, { 'a.txt': 'b\n' });
    const { git } = service(root, { debounceMs: 20 });
    const seen: GitStatus[] = [];
    git.onStatus((status) => seen.push(status));
    git.start();
    await wait(() => expect(seen.at(-1)?.files[0]).toMatchObject({ index: null, worktree: 'modified' }));
    await git.ready();
    sh(root, 'add', 'a.txt');
    await wait(() => expect(seen.at(-1)?.files[0]).toMatchObject({ index: 'modified', worktree: null }));
  });

  it('finds a repository that appears after the IDE started', async () => {
    const root = await makeRepo({}, false);
    await rm(join(root, '.git'), { recursive: true });
    const { git } = service(root, { debounceMs: 20 });
    const seen: GitStatus[] = [];
    git.onStatus((status) => seen.push(status));
    git.start();
    await wait(() => expect(seen.at(-1)?.repo).toBe(false));
    await git.ready();
    sh(root, 'init', '-q');
    await wait(() => expect(seen.at(-1)?.repo).toBe(true));
  });

  it('never lets an older status overwrite a newer one', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git } = service(root);
    const first = git.refresh();
    await put(root, { 'a.txt': 'changed\n' });
    const second = git.refresh();
    const [, newer] = await Promise.all([first, second]);
    expect(paths(newer)).toEqual(['a.txt']);
    expect(git.snapshot()).toEqual(newer);
  });
});

describe('GitService.handle', () => {
  it('answers a request with its id and reports a failure as an error string', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    await put(root, { 'a.txt': 'b\n' });
    const { git } = service(root);
    const replies: unknown[] = [];
    const reply = (message: unknown) => void replies.push(message);
    await git.handle({ type: 'git.stage', requestId: 'r1', paths: ['a.txt'] }, reply);
    await git.handle({ type: 'git.commit', requestId: 'r2', message: '' }, reply);
    await git.handle({ type: 'git.branches', requestId: 'r3' }, reply);
    expect(replies).toEqual([
      { type: 'git.result', requestId: 'r1', error: null },
      { type: 'git.result', requestId: 'r2', error: 'The commit message is empty.' },
      { type: 'git.result', requestId: 'r3', error: null, branches: [expect.objectContaining({ name: 'main', current: true })] },
    ]);
    expect(paths(git.snapshot() ?? undefined)).toEqual(['a.txt']);
  });
});
