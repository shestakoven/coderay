export interface DirEntry {
  name: string;
  isGit: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export type ClonePhase = 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checking-out';

export interface ProjectInfo {
  root: string | null;
  name: string;
  home: string;
  recent: RecentProject[];
}

export type ProjectClientMessage =
  | { type: 'fs.list'; requestId: string; path: string | null }
  | { type: 'project.open'; requestId: string; path: string }
  | { type: 'project.create'; requestId: string; parent: string; name: string }
  | { type: 'project.clone'; requestId: string; url: string; parent: string; name: string | null }
  | { type: 'project.clone.cancel'; requestId: string }
  | { type: 'project.close'; requestId: string };

export type ProjectServerMessage =
  | { type: 'project.info'; info: ProjectInfo }
  | { type: 'fs.list.result'; requestId: string; path: string; parent: string | null; entries: DirEntry[]; error: string | null }
  | { type: 'project.open.result'; requestId: string; error: string | null }
  | { type: 'project.create.result'; requestId: string; error: string | null }
  | { type: 'project.clone.progress'; requestId: string; phase: ClonePhase; percent: number }
  | { type: 'project.clone.result'; requestId: string; error: string | null }
  | { type: 'project.close.result'; requestId: string; error: string | null };
