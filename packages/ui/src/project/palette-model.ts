import type { HubProject, RecentProject } from '@ide/protocol';

export type PaletteAction = 'open-folder' | 'clone' | 'new' | 'close';

export type PaletteRow =
  | { kind: 'open'; project: HubProject; label: string }
  | { kind: 'recent'; recent: RecentProject }
  | { kind: 'action'; action: PaletteAction; label: string; keys: string };

export interface PaletteGroup {
  title: string;
  rows: PaletteRow[];
}

export interface PaletteInput {
  projects: HubProject[];
  labels: Record<string, string>;
  recent: RecentProject[];
  query: string;
  mac: boolean;
}

const action = (name: PaletteAction, label: string, keys: string): Extract<PaletteRow, { kind: 'action' }> => ({ kind: 'action', action: name, label, keys });

export const matches = (text: string, query: string): boolean => query === '' || text.toLowerCase().includes(query.toLowerCase());

export function paletteGroups({ projects, labels, recent, query, mac }: PaletteInput): PaletteGroup[] {
  const q = query.trim();
  const key = mac ? '⌘' : 'Ctrl+';
  const open = projects.filter((project) => matches(project.name, q) || matches(labels[project.id] ?? '', q) || matches(project.root, q));
  const openRoots = new Set(projects.map((project) => project.root));
  const others = recent.filter((item) => !openRoots.has(item.path) && (matches(item.name, q) || matches(item.path, q))).slice(0, q === '' ? 3 : 6);
  const actions = [
    action('open-folder', 'Open folder…', `${key}O`),
    action('clone', 'Clone repository…', ''),
    action('new', 'New project…', ''),
    ...(projects.length > 0 ? [action('close', 'Close this project', `${key}W`)] : []),
  ].filter((row) => matches(row.label, q));
  return [
    { title: 'Open projects', rows: open.map((project) => ({ kind: 'open' as const, project, label: labels[project.id] ?? project.name })) },
    { title: 'Recent', rows: others.map((item) => ({ kind: 'recent' as const, recent: item })) },
    { title: 'Actions', rows: actions },
  ].filter((group) => group.rows.length > 0);
}

// With no query, Enter should flip to the project used before this one, like Cmd+Tab.
export function initialRow(groups: PaletteGroup[], recency: string[], query: string): number {
  if (query.trim() !== '') return 0;
  const target = recency[1];
  if (target === undefined) return 0;
  const flat = groups.flatMap((group) => group.rows);
  const at = flat.findIndex((row) => row.kind === 'open' && row.project.id === target);
  return at < 0 ? 0 : at;
}
