import { posix } from 'node:path';
import type { FileEdge } from '@ide/protocol';

export type Owners = Pick<ReadonlyMap<string, string>, 'get'>;

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_STEM = /^test_.|._test$|\.(test|spec)$|^conftest$/;

const stemOf = (name: string): string => name.slice(0, name.length - posix.extname(name).length);

export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  return segments.some((segment) => TEST_DIRS.has(segment)) || TEST_STEM.test(stemOf(name));
}

export function importTargets(edges: FileEdge[]): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    const list = targets.get(edge.from);
    if (list) list.push(edge.to);
    else targets.set(edge.from, [edge.to]);
  }
  return targets;
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
