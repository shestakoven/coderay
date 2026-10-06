import { describe, expect, it } from 'vitest';
import { parseStatus } from '../../src/git/status-parse';

const z = (...tokens: string[]): string => `${tokens.join('\0')}\0`;
const ZERO = '0'.repeat(40);
const ordinary = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${ZERO} ${ZERO} ${path}`;

describe('parseStatus', () => {
  it('reads the branch, its upstream and the distance from it', () => {
    const out = z(`# branch.oid ${'a'.repeat(40)}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1');
    expect(parseStatus(out)).toEqual({ branch: 'main', detached: false, sha: 'a'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1, files: [] });
  });

  it('has no branch name on a detached head and no sha before the first commit', () => {
    expect(parseStatus(z(`# branch.oid ${'b'.repeat(40)}`, '# branch.head (detached)'))).toMatchObject({ branch: null, detached: true, sha: 'b'.repeat(40) });
    expect(parseStatus(z('# branch.oid (initial)', '# branch.head main'))).toMatchObject({ branch: 'main', detached: false, sha: null });
  });

  it('splits the two status letters into the index and the work-tree side', () => {
    const files = parseStatus(z(ordinary('M.', 'a.txt'), ordinary('.M', 'b.txt'), ordinary('AM', 'c.txt'), ordinary('.D', 'd.txt'))).files;
    expect(files.map((f) => [f.path, f.index, f.worktree])).toEqual([
      ['a.txt', 'modified', null], ['b.txt', null, 'modified'], ['c.txt', 'added', 'modified'], ['d.txt', null, 'deleted'],
    ]);
  });

  it('keeps spaces and non-ASCII characters in a path', () => {
    expect(parseStatus(z(ordinary('.M', 'dir/a file é.txt'))).files[0]!.path).toBe('dir/a file é.txt');
  });

  it('reads a rename with its old path and does not mistake the old path for an entry', () => {
    const out = z(`2 R. N... 100644 100644 100644 ${ZERO} ${ZERO} R100 new name.txt`, 'old name.txt', '? after.txt');
    expect(parseStatus(out).files).toEqual([
      { path: 'new name.txt', origPath: 'old name.txt', index: 'renamed', worktree: null, conflicted: false },
      { path: 'after.txt', origPath: null, index: null, worktree: 'untracked', conflicted: false },
    ]);
  });

  it('marks an unmerged path as conflicted', () => {
    const out = z(`u UU N... 100644 100644 100644 100644 ${ZERO} ${ZERO} ${ZERO} both.txt`);
    expect(parseStatus(out).files).toEqual([{ path: 'both.txt', origPath: null, index: null, worktree: null, conflicted: true }]);
  });

  it('lists untracked files and skips ignored ones', () => {
    expect(parseStatus(z('? new.txt', '! ignored.txt')).files.map((f) => f.path)).toEqual(['new.txt']);
  });
});
