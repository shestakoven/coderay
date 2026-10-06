import type { GitKind, GitStatus } from '@ide/protocol';

export type ParsedStatus = Pick<GitStatus, 'branch' | 'detached' | 'sha' | 'upstream' | 'ahead' | 'behind' | 'files'>;

const KIND: Record<string, GitKind> = { M: 'modified', T: 'typechange', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };
const kindOf = (letter: string | undefined): GitKind | null => (letter === undefined ? null : (KIND[letter] ?? null));

// "1 XY sub mH mI mW hH hI path": the path is what follows the fixed fields and may hold spaces.
function split(token: string, fields: number): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < fields; i++) {
    const at = token.indexOf(' ', from);
    parts.push(token.slice(from, at));
    from = at + 1;
  }
  return { parts, rest: token.slice(from) };
}

export function parseStatus(raw: string): ParsedStatus {
  const status: ParsedStatus = { branch: null, detached: false, sha: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice(13);
      status.sha = oid === '(initial)' ? null : oid;
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice(14);
      status.detached = head === '(detached)';
      status.branch = status.detached ? null : head;
    } else if (token.startsWith('# branch.upstream ')) {
      status.upstream = token.slice(18);
    } else if (token.startsWith('# branch.ab ')) {
      const match = /^\+(\d+) -(\d+)$/.exec(token.slice(12));
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (token.startsWith('1 ')) {
      const { parts, rest } = split(token, 8);
      status.files.push({ path: rest, origPath: null, index: kindOf(parts[1]![0]), worktree: kindOf(parts[1]![1]), conflicted: false });
    } else if (token.startsWith('2 ')) {
      const { parts, rest } = split(token, 9);
      status.files.push({ path: rest, origPath: tokens[++i] ?? null, index: kindOf(parts[1]![0]), worktree: kindOf(parts[1]![1]), conflicted: false });
    } else if (token.startsWith('u ')) {
      status.files.push({ path: split(token, 10).rest, origPath: null, index: null, worktree: null, conflicted: true });
    } else if (token.startsWith('? ')) {
      status.files.push({ path: token.slice(2), origPath: null, index: null, worktree: 'untracked', conflicted: false });
    }
  }
  return status;
}
