import { describe, expect, it } from 'vitest';
import type { GitFile } from '@ide/protocol';
import { parseStatus } from '../../src/git/status-parse';

const z = (...tokens: string[]): string => `${tokens.join('\0')}\0`;
const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const ordinary = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${ZERO} ${ZERO} ${path}`;
const file = (path: string, over: Partial<GitFile> = {}): GitFile => ({ path, origPath: null, index: null, worktree: null, conflicted: false, ...over });

describe('parseStatus', () => {
  it.each([
    ['a branch, its upstream and the distance from it', [`# branch.oid ${A}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'], { branch: 'main', detached: false, sha: A, upstream: 'origin/main', ahead: 2, behind: 1 }],
    ['a detached head', [`# branch.oid ${A}`, '# branch.head (detached)'], { branch: null, detached: true, sha: A, upstream: null, ahead: 0, behind: 0 }],
    ['a branch before its first commit', ['# branch.oid (initial)', '# branch.head main'], { branch: 'main', detached: false, sha: null, upstream: null, ahead: 0, behind: 0 }],
  ])('reads the header of %s', (_, tokens, header) => {
    expect(parseStatus(z(...tokens))).toEqual({ ...header, files: [] });
  });

  it.each([
    ['the index and the work-tree letters, keeping spaces and non-ASCII in a path', [ordinary('M.', 'a.txt'), ordinary('AM', 'dir/a file é.txt'), ordinary('.D', 'd.txt')], [
      file('a.txt', { index: 'modified' }), file('dir/a file é.txt', { index: 'added', worktree: 'modified' }), file('d.txt', { worktree: 'deleted' }),
    ]],
    ['a rename with its old path, whatever the old path looks like', [`2 R. N... 100644 100644 100644 ${ZERO} ${ZERO} R100 intro.md`, '1 intro.md', '? after.txt'], [
      file('intro.md', { origPath: '1 intro.md', index: 'renamed' }), file('after.txt', { worktree: 'untracked' }),
    ]],
    ['an unmerged path as conflicted', [`u UU N... 100644 100644 100644 100644 ${ZERO} ${ZERO} ${ZERO} both.txt`], [file('both.txt', { conflicted: true })]],
  ])('reads %s', (_, tokens, files) => {
    expect(parseStatus(z(...tokens)).files).toEqual(files);
  });
});
