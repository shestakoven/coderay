import type { GitBranch, GitFile, GitKind, GitStatus } from '@ide/protocol';

export interface GitSections {
  staged: GitFile[];
  changes: GitFile[];
  untracked: GitFile[];
  conflicts: GitFile[];
}

export function sections(status: GitStatus): GitSections {
  const out: GitSections = { staged: [], changes: [], untracked: [], conflicts: [] };
  for (const file of status.files) {
    if (file.conflicted) out.conflicts.push(file);
    else if (file.worktree === 'untracked') out.untracked.push(file);
    else {
      if (file.index !== null) out.staged.push(file);
      if (file.worktree !== null) out.changes.push(file);
    }
  }
  return out;
}

export const changedCount = (status: GitStatus | null): number => status?.files.length ?? 0;

const LETTER: Record<GitKind, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U' };
export const kindLetter = (kind: GitKind | null): string => (kind ? LETTER[kind] : '');

export const kindLabel: Record<GitKind, string> = {
  added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typechange: 'Type changed', untracked: 'Untracked',
};

export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

export interface CommitState {
  enabled: boolean;
  reason: string | null;
}

export function commitState(status: GitStatus, message: string): CommitState {
  if (status.operation) return { enabled: false, reason: `A ${status.operation} is in progress: continue in the terminal.` };
  if (status.files.some((file) => file.conflicted)) return { enabled: false, reason: 'Resolve the conflicted files first.' };
  if (!status.files.some((file) => file.index !== null)) return { enabled: false, reason: 'Stage a change to commit.' };
  if (message.trim() === '') return { enabled: false, reason: 'Write a commit message.' };
  return { enabled: true, reason: null };
}

export interface ChipView {
  label: string;
  title: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export function chipView(status: GitStatus): ChipView | null {
  if (!status.repo) return null;
  const label = status.branch ?? (status.sha ? status.sha.slice(0, 7) : 'no commits yet');
  const dirty = status.files.length > 0;
  const distance = [status.ahead ? `${status.ahead} ahead` : '', status.behind ? `${status.behind} behind` : ''].filter(Boolean).join(', ');
  const title = [
    status.detached ? `Detached HEAD at ${label}` : `Branch ${label}`,
    status.upstream ? `tracking ${status.upstream}` : '',
    distance,
    dirty ? `${status.files.length} changed` : 'clean',
  ].filter(Boolean).join(' · ');
  return { label, title, dirty, ahead: status.ahead, behind: status.behind };
}

export function matchBranches(branches: GitBranch[], query: string): { matches: GitBranch[]; create: string | null } {
  const q = query.trim();
  const matches = q === '' ? branches : branches.filter((branch) => branch.name.toLowerCase().includes(q.toLowerCase()));
  return { matches, create: q !== '' && !branches.some((branch) => branch.name === q) ? q : null };
}
