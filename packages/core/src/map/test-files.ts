import { posix } from 'node:path';
import type { FileEdge } from '@ide/protocol';

export type Owners = Pick<ReadonlyMap<string, string>, 'get'>;

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);

export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';

  if (name === 'conftest.py') return true;
  if (TEST_DIRS.has(name)) return true;

  for (const segment of segments) {
    if (TEST_DIRS.has(segment)) return true;
  }

  const withoutExt = posix.parse(name).name;
  if (/\.(test|spec)$/.test(withoutExt)) return true;
  if (/^test_/.test(withoutExt)) return true;
  if (/_test$/.test(withoutExt)) return true;

  return false;
}

export function importTargets(edges: FileEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const current = result.get(edge.from) ?? [];
    current.push(edge.to);
    result.set(edge.from, current);
  }
  return result;
}

export function testSubject(path: string, imports: readonly string[], owner: Owners): string | null {
  const counts = new Map<string, number>();
  for (const target of imports) {
    const id = isTestPath(target) ? undefined : owner.get(target);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const [first, second] = [...counts].sort((a, b) => b[1] - a[1]);
  if (first && (!second || first[1] > second[1])) return first[0];
  for (const candidate of mirroredSources(path)) {
    const id = owner.get(candidate);
    if (id) return id;
  }
  return null;
}

function mirroredSources(path: string): string[] {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  const extension = posix.extname(name);
  const bare = `${stemOf(name).replace(/\.(test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '')}${extension}`;
  const testDir = segments.findLastIndex((segment) => TEST_DIRS.has(segment));
  const dirs = [segments];
  if (testDir >= 0) {
    dirs.push([...segments.slice(0, testDir), 'src', ...segments.slice(testDir + 1)]);
    dirs.push([...segments.slice(0, testDir), ...segments.slice(testDir + 1)]);
  }
  return dirs.map((dir) => [...dir, bare].join('/')).filter((candidate) => candidate !== path);
}

function stemOf(name: string): string {
  return posix.parse(name).name;
}
