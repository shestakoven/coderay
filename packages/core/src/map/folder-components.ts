import type { MapComponent } from '@ide/protocol';

interface Group {
  dir: string | null;
  files: string[];
}

const MIN_SPLIT_FILES = 12;

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function folderComponents(paths: string[]): MapComponent[] {
  if (paths.length === 0) return [];
  return split('', paths, paths.length).sort((a, b) => compare(a.id, b.id));
}

function split(prefix: string, paths: string[], total: number): MapComponent[] {
  const groups = groupByNextSegment(paths, prefix);
  return groups.flatMap((group) => {
    const dominant = group.files.length > total / 2 && group.files.length >= MIN_SPLIT_FILES;
    return group.dir !== null && (groups.length === 1 || dominant)
      ? split(group.dir, group.files, total)
      : [toComponent(group, prefix)];
  });
}

function groupByNextSegment(paths: string[], prefix: string): Group[] {
  const byKey = new Map<string, Group>();
  for (const path of [...paths].sort(compare)) {
    const rest = prefix ? path.slice(prefix.length + 1) : path;
    const slash = rest.indexOf('/');
    const dir = slash === -1 ? null : `${prefix ? `${prefix}/` : ''}${rest.slice(0, slash)}`;
    const key = dir ?? '';
    const group = byKey.get(key) ?? { dir, files: [] };
    group.files.push(path);
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => compare(a.dir ?? '', b.dir ?? ''));
}

function toComponent(group: Group, prefix: string): MapComponent {
  const base = { description: '', files: group.files, source: 'folder' as const, stale: false };
  if (group.dir !== null) {
    return { ...base, id: `folder:${group.dir}`, name: lastSegment(group.dir), globs: [`${group.dir}/**`] };
  }
  const label = prefix ? lastSegment(prefix) : 'root';
  return { ...base, id: `folder:${prefix || '.'}/*`, name: `${label} (files)`, globs: [prefix ? `${prefix}/*` : '*'] };
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
