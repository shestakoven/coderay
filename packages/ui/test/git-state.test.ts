import { describe, expect, it } from 'vitest';
import type { GitBranch, GitFile, GitStatus } from '@ide/protocol';
import { changedCount, chipView, commitState, kindLetter, matchBranches, sections, splitPath } from '../src/git/git-state';

const file = (path: string, over: Partial<GitFile> = {}): GitFile => ({ path, origPath: null, index: null, worktree: null, conflicted: false, ...over });
const status = (files: GitFile[], over: Partial<GitStatus> = {}): GitStatus => ({
  repo: true, branch: 'main', detached: false, sha: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, files, operation: null, busy: null, problem: null, ...over,
});

describe('sections', () => {
  it('puts a file with both an index and a work-tree change in both lists, and keeps conflicts and untracked apart', () => {
    const result = sections(status([
      file('both.ts', { index: 'modified', worktree: 'modified' }),
      file('staged.ts', { index: 'added' }),
      file('new.ts', { worktree: 'untracked' }),
      file('clash.ts', { conflicted: true }),
    ]));
    expect(result.staged.map((f) => f.path)).toEqual(['both.ts', 'staged.ts']);
    expect(result.changes.map((f) => f.path)).toEqual(['both.ts']);
    expect(result.untracked.map((f) => f.path)).toEqual(['new.ts']);
    expect(result.conflicts.map((f) => f.path)).toEqual(['clash.ts']);
    expect(changedCount(status([file('a', { worktree: 'modified' }), file('b', { index: 'added' })]))).toBe(2);
    expect(changedCount(null)).toBe(0);
  });
});

describe('commitState', () => {
  const staged = [file('a.ts', { index: 'added' })];
  it('names the first thing that blocks a commit', () => {
    expect(commitState(status(staged, { operation: 'merge' }), 'm')).toEqual({ enabled: false, reason: 'A merge is in progress: continue in the terminal.' });
    expect(commitState(status([file('x', { conflicted: true })]), 'm').reason).toBe('Resolve the conflicted files first.');
    expect(commitState(status([file('a', { worktree: 'modified' })]), 'm').reason).toBe('Stage a change to commit.');
    expect(commitState(status(staged), '  ').reason).toBe('Write a commit message.');
    expect(commitState(status(staged), 'fix')).toEqual({ enabled: true, reason: null });
  });
});

describe('chipView', () => {
  it('shows the branch, or the short sha when detached, with dirtiness and distance', () => {
    expect(chipView(status([], { branch: 'main' }))).toMatchObject({ label: 'main', dirty: false });
    expect(chipView(status([file('a', { worktree: 'modified' })], { ahead: 2, behind: 1 }))).toMatchObject({ dirty: true, ahead: 2, behind: 1 });
    expect(chipView(status([], { branch: null, detached: true, sha: 'abcdef0123456789' }))?.label).toBe('abcdef0');
    expect(chipView({ ...status([]), repo: false })).toBeNull();
  });
});

describe('matchBranches', () => {
  const branches: GitBranch[] = ['main', 'feature/login', 'fix/typo'].map((name) => ({ name, current: name === 'main', upstream: null, sha: 'abc' }));
  it('filters by substring and offers to create a branch only for a new name', () => {
    expect(matchBranches(branches, 'fe')).toEqual({ matches: [branches[1]], create: 'fe' });
    expect(matchBranches(branches, 'main')).toEqual({ matches: [branches[0]], create: null });
    expect(matchBranches(branches, '  ')).toEqual({ matches: branches, create: null });
  });
});

describe('path helpers', () => {
  it('splits a path into name and folder and letters a kind', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', dir: 'src/a' });
    expect(splitPath('b.ts')).toEqual({ name: 'b.ts', dir: '' });
    expect([kindLetter('added'), kindLetter('untracked'), kindLetter(null)]).toEqual(['A', 'U', '']);
  });
});
