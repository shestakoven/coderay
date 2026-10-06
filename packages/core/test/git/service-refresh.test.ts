import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitStatus } from '@ide/protocol';
import { isolateGit, makeRepo, put, service, sh } from './fixture';

isolateGit();

const paths = (status: GitStatus | undefined): string[] => status?.files.map((f) => f.path) ?? [];
const wait = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

describe('GitService refresh', () => {
  it('broadcasts a status when the working tree or the agent state changes, and only when it changed', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    const { git, busy } = service(root, { debounceMs: 20 });
    const seen: GitStatus[] = [];
    git.onStatus((status) => seen.push(status));
    git.start();
    await wait(() => expect(seen).toHaveLength(1));
    await git.ready();
    await put(root, { 'a.txt': 'b\n' });
    await wait(() => expect(paths(seen.at(-1))).toEqual(['a.txt']));
    const count = seen.length;
    git.poke();
    git.checkBusy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(count);
    busy.reason = 'the agent is working';
    git.checkBusy();
    await wait(() => expect(seen.at(-1)?.busy).toBe('the agent is working'));
    busy.reason = null;
    git.checkBusy();
    await wait(() => expect(seen.at(-1)?.busy).toBeNull());
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

  it('answers a refresh asked for while a status is running with a status taken after it', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    let runs = 0;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const agentBusy = () => {
      started();
      return `run ${++runs}`;
    };
    const { git } = service(root, { agentBusy });
    const first = git.refresh();
    await running;
    const second = git.refresh();
    expect((await first).busy).toBe('run 1');
    expect((await second).busy).toBe('run 2');
    expect(git.snapshot()?.busy).toBe('run 2');
  });
});

describe('GitService.handle', () => {
  it('answers each request with its id and result, reports a failure as an error string, and refreshes after a write', async () => {
    const root = await makeRepo({ 'a.txt': 'a\n' });
    sh(root, 'branch', 'feature');
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
      {
        type: 'git.result', requestId: 'r3', error: null,
        branches: expect.arrayContaining([expect.objectContaining({ name: 'main', current: true }), expect.objectContaining({ name: 'feature', current: false })]),
      },
    ]);
    expect(git.snapshot()?.files).toEqual([expect.objectContaining({ path: 'a.txt', index: 'modified', worktree: null })]);
  });
});
