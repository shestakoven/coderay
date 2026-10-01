export interface DirEntry {
  name: string;
  isGit: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export interface ProjectInfo {
  root: string;
  name: string;
  home: string;
  recent: RecentProject[];
}

export type ProjectClientMessage =
  | { type: 'fs.list'; requestId: string; path: string | null }
  | { type: 'project.open'; requestId: string; path: string };

export type ProjectServerMessage =
  | { type: 'project.info'; info: ProjectInfo }
  | { type: 'fs.list.result'; requestId: string; path: string; parent: string | null; entries: DirEntry[]; error: string | null }
  | { type: 'project.open.result'; requestId: string; error: string | null };
