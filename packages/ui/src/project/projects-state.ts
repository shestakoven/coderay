import type { HubProject, HubSnapshot, ProjectInfo, RecentProject } from '@ide/protocol';
import { IDLE, type ProjectStatus } from './project-status';

export const LEGACY_ID = 'legacy';

export interface ProjectsState {
  // 'pending' until the first message of the control socket says which kind of core it is.
  mode: 'pending' | 'hub' | 'legacy';
  projects: HubProject[];
  activeId: string | null;
  // Most recently shown first: Ctrl+Tab walks it, closing a tab falls back along it.
  recency: string[];
  recent: RecentProject[];
  home: string;
  status: Record<string, ProjectStatus>;
  // Closed in the UI, still stopping in the hub: hidden until the hub drops them.
  closing: string[];
}

export type ProjectsAction =
  | { type: 'hub'; hub: HubSnapshot }
  | { type: 'legacy'; info: ProjectInfo }
  | { type: 'activate'; id: string }
  | { type: 'order'; ids: string[] }
  | { type: 'remove'; id: string }
  | { type: 'status'; id: string; status: ProjectStatus };

export const initialProjects: ProjectsState = { mode: 'pending', projects: [], activeId: null, recency: [], recent: [], home: '', status: {}, closing: [] };

const sameStatus = (a: ProjectStatus | undefined, b: ProjectStatus): boolean => a !== undefined && a.kind === b.kind && a.line === b.line;

function settle(state: ProjectsState, projects: HubProject[], wanted: string | null): ProjectsState {
  const ids = new Set(projects.map((project) => project.id));
  const activeId = wanted !== null && ids.has(wanted) ? wanted : (state.recency.find((id) => ids.has(id)) ?? projects[0]?.id ?? null);
  const recency = [...(activeId === null ? [] : [activeId]), ...state.recency.filter((id) => id !== activeId && ids.has(id)), ...projects.map((project) => project.id).filter((id) => id !== activeId && !state.recency.includes(id))];
  const status = Object.fromEntries(Object.entries(state.status).filter(([id]) => ids.has(id)));
  return { ...state, projects, activeId, recency, status };
}

export function projectsReducer(state: ProjectsState, action: ProjectsAction): ProjectsState {
  switch (action.type) {
    case 'hub': {
      const closing = state.closing.filter((id) => action.hub.projects.some((project) => project.id === id));
      return settle({ ...state, mode: 'hub', recent: action.hub.recent, home: action.hub.home, closing }, action.hub.projects.filter((project) => !closing.includes(project.id)), action.hub.activeId);
    }
    case 'remove':
      return settle({ ...state, closing: [...state.closing, action.id] }, state.projects.filter((project) => project.id !== action.id), state.activeId === action.id ? null : state.activeId);
    case 'legacy': {
      const project: HubProject[] = action.info.root === null
        ? []
        : [{ id: LEGACY_ID, root: action.info.root, name: action.info.name, state: 'running', port: null, token: null, error: null }];
      return settle({ ...state, mode: 'legacy', recent: action.info.recent, home: action.info.home }, project, project[0]?.id ?? null);
    }
    case 'activate':
      return state.projects.some((project) => project.id === action.id) && state.activeId !== action.id ? settle(state, state.projects, action.id) : state;
    case 'order': {
      const byId = new Map(state.projects.map((project) => [project.id, project]));
      const ordered = action.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      const rest = state.projects.filter((project) => !action.ids.includes(project.id));
      return { ...state, projects: [...ordered, ...rest] };
    }
    case 'status':
      return sameStatus(state.status[action.id], action.status) ? state : { ...state, status: { ...state.status, [action.id]: action.status } };
  }
}

export const statusOf = (state: ProjectsState, id: string): ProjectStatus => state.status[id] ?? IDLE;

export const activeProject = (state: ProjectsState): HubProject | null => state.projects.find((project) => project.id === state.activeId) ?? null;

// Ctrl+Tab: the project before (dir 1) or after (dir -1) the current one in recency order, wrapping around.
export function cycleTarget(state: ProjectsState, dir: 1 | -1): string | null {
  const ids = state.recency.filter((id) => state.projects.some((project) => project.id === id));
  if (ids.length < 2 || state.activeId === null) return null;
  const at = ids.indexOf(state.activeId);
  return ids[(at + dir + ids.length) % ids.length] ?? null;
}

// Cmd+1..9 follow tab order; 9 is the last tab, as in browsers.
export function jumpTarget(state: ProjectsState, key: number): string | null {
  if (!Number.isInteger(key) || key < 1 || key > 9 || state.projects.length === 0) return null;
  return state.projects[key === 9 ? state.projects.length - 1 : key - 1]?.id ?? null;
}

// Closing the shown tab goes back to the project used just before it.
export function afterClose(state: ProjectsState, id: string): string | null {
  if (state.activeId !== id) return state.activeId;
  return state.recency.find((candidate) => candidate !== id && state.projects.some((project) => project.id === candidate)) ?? null;
}

// Two projects can share a folder name: the label then carries the parent folder.
export function tabLabels(projects: HubProject[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  const parentOf = (root: string): string => root.split('/').filter(Boolean).at(-2) ?? '';
  return Object.fromEntries(projects.map((project) => [project.id, (counts.get(project.name) ?? 0) > 1 && parentOf(project.root) !== '' ? `${parentOf(project.root)}/${project.name}` : project.name]));
}

export const projectLetter = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();

// A stable tint per project, so tabs stay recognisable.
export function projectHue(root: string): number {
  let hash = 0;
  for (const char of root) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
