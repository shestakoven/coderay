import type { FileDiff } from './history';

export type GitKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked';

export interface GitFile {
  path: string;
  origPath: string | null;
  index: GitKind | null;
  worktree: GitKind | null;
  conflicted: boolean;
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick';

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  detached: boolean;
  sha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  operation: GitOperation | null;
  // Why branch switch, branch create and discard are unavailable right now, or null.
  busy: string | null;
  // Why git could not be read (git missing, unexpected failure), or null.
  problem: string | null;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  sha: string;
}

export type GitSide = 'staged' | 'unstaged';

export type GitServerMessage =
  | { type: 'git.snapshot'; status: GitStatus }
  | { type: 'git.result'; requestId: string; error: string | null; diff?: FileDiff; branches?: GitBranch[] };

export type GitClientMessage =
  | { type: 'git.refresh' }
  | { type: 'git.init'; requestId: string }
  | { type: 'git.diff'; requestId: string; path: string; side: GitSide }
  | { type: 'git.stage'; requestId: string; paths: string[] | 'all' }
  | { type: 'git.unstage'; requestId: string; paths: string[] | 'all' }
  | { type: 'git.discard'; requestId: string; paths: string[] }
  | { type: 'git.commit'; requestId: string; message: string }
  | { type: 'git.branches'; requestId: string }
  | { type: 'git.branch-create'; requestId: string; name: string }
  | { type: 'git.branch-switch'; requestId: string; name: string }
  | { type: 'git.branch-delete'; requestId: string; name: string };
