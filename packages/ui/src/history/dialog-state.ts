import type { FileAnswer, WatchdogAnswer, WatchdogEventView } from '@ide/protocol';

export interface DialogChoice { files: Record<string, FileAnswer | undefined> }
export interface DirGroup { dir: string; paths: string[]; shownPaths?: string[]; answer: FileAnswer | 'mixed' | null }

export const PAGE_FILES = 100;

const guarded = (path: string): boolean => path === '.git/HEAD' || path.startsWith('.git/refs/');

export const fileOptions = (path: string): FileAnswer[] => (guarded(path) ? ['keep'] : ['keep', 'revert', 'mine']);

const eventPaths = (event: WatchdogEventView): string[] => [...new Set(event.changes.map((c) => c.path))].sort();

export function initialChoice(event: WatchdogEventView): DialogChoice {
  const files: DialogChoice['files'] = {};
  if (event.mode === 'A') {
    for (const path of eventPaths(event)) files[path] = fileOptions(path).includes('revert') ? 'revert' : 'keep';
  }
  return { files };
}

export function chooseFile(c: DialogChoice, path: string, a: FileAnswer): DialogChoice {
  if (!fileOptions(path).includes(a)) return c;
  return { files: { ...c.files, [path]: a } };
}

export function chooseDir(c: DialogChoice, group: DirGroup, a: FileAnswer): DialogChoice {
  const files = { ...c.files };
  for (const path of group.paths) if (fileOptions(path).includes(a)) files[path] = a;
  return { files };
}

const dirOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '.' : path.slice(0, at);
};

export function groupByDir(event: WatchdogEventView, choice?: DialogChoice): DirGroup[] {
  const byDir = new Map<string, string[]>();
  for (const path of eventPaths(event)) {
    const dir = dirOf(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, paths]) => {
      const answers = new Set(paths.map((p) => choice?.files[p] ?? null));
      const only = answers.size === 1 ? [...answers][0] : undefined;
      return { dir, paths, answer: only === undefined ? 'mixed' : only };
    });
}

export function visibleFiles(groups: DirGroup[], expanded: boolean): { shown: DirGroup[]; hidden: number } {
  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  if (expanded || total <= PAGE_FILES) return { shown: groups, hidden: 0 };
  const shown: DirGroup[] = [];
  let room = PAGE_FILES;
  for (const group of groups) {
    if (room <= 0) break;
    shown.push(group.paths.length <= room ? group : { ...group, shownPaths: group.paths.slice(0, room) });
    room -= group.paths.length;
  }
  return { shown, hidden: total - PAGE_FILES };
}

export function buildAnswer(event: WatchdogEventView, c: DialogChoice): WatchdogAnswer | null {
  const paths = eventPaths(event);
  if (paths.length === 0) return null;
  const files: Record<string, FileAnswer> = {};
  for (const path of paths) {
    const answer = c.files[path];
    if (answer === undefined) return null;
    files[path] = answer;
  }
  const first = files[paths[0]!]!;
  return paths.every((p) => files[p] === first) ? { kind: 'all', answer: first } : { kind: 'files', files };
}

export const canExpand = (event: WatchdogEventView): boolean => event.canExpand;

export function stopAgentLabel(event: WatchdogEventView): string | null {
  if (event.interrupted || event.runningSubagents <= 0) return null;
  const n = event.runningSubagents;
  return `Stop agent (stops ${n} ${n === 1 ? 'subagent' : 'subagents'})`;
}

export function fileDiffRange(event: WatchdogEventView, path: string): { before: string | null; after: string | null } | null {
  const own = event.changes.filter((c) => c.path === path).sort((a, b) => a.at - b.at);
  const first = own[0];
  const last = own[own.length - 1];
  return first && last ? { before: first.beforeHash, after: last.afterHash } : null;
}

export function markCounts(nodeIds: (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of nodeIds) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export const openEvents = (events: WatchdogEventView[]): WatchdogEventView[] => events.filter((e) => e.phase !== 'resolved');

export function dialogEvent(events: WatchdogEventView[]): WatchdogEventView | null {
  return events
    .filter((e) => e.phase === 'pending')
    .reduce<WatchdogEventView | null>((oldest, e) => (oldest === null || e.ts < oldest.ts ? e : oldest), null);
}

export const eventFilePaths = (events: WatchdogEventView[]): Set<string> =>
  new Set(openEvents(events).flatMap((e) => e.changes.map((c) => c.path)));
