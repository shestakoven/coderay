import { posix } from 'node:path';
import type { AiComponent } from './map-file';
import { isTestPath, testSubject } from './test-files';
import { dot } from './vectors';

export type EmbeddingRule = { kind: 'threshold'; min: number } | { kind: 'margin'; min: number };

export const MIN_LOWER_BOUND = 0.9;

export interface ResidualSample {
  own: string;
  best: string;
  bestSimilarity: number;
  margin: number;
}

export interface RuleCheck {
  assigned: number;
  correct: number;
  lowerBound: number;
  passes: boolean;
}

export const accepts = (rule: EmbeddingRule, sample: Pick<ResidualSample, 'bestSimilarity' | 'margin'>): boolean =>
  (rule.kind === 'threshold' ? sample.bestSimilarity : sample.margin) >= rule.min;

export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  return (p + z2 / (2 * trials) - z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials);
}

export function checkRule(rule: EmbeddingRule, samples: ResidualSample[]): RuleCheck {
  const accepted = samples.filter((sample) => accepts(rule, sample));
  const correct = accepted.filter((sample) => sample.best === sample.own).length;
  const lowerBound = wilsonLowerBound(correct, accepted.length);
  return { assigned: accepted.length, correct, lowerBound, passes: lowerBound >= MIN_LOWER_BOUND };
}

// Judges every directory as if it were new and skips files a stored glob or the test rule would place.
export function residualSamples(
  components: Pick<AiComponent, 'id' | 'files'>[],
  allPaths: string[],
  vector: (path: string) => Float32Array | undefined,
  imports: ReadonlyMap<string, string[]>,
): ResidualSample[] {
  const owner = new Map(components.flatMap((component) => component.files.map((path) => [path, component.id] as const)));
  const under = new Map<string, Map<string, number>>();
  const direct = new Map<string, string[]>();
  for (const path of allPaths) {
    const dir = posix.dirname(path);
    const list = direct.get(dir);
    if (list) list.push(path);
    else direct.set(dir, [path]);
    for (const ancestor of ancestors(dir)) add(under, ancestor, owner.get(path) ?? '', 1);
  }
  const sums = new Map<string, { sum: Float32Array; count: number }>();
  for (const [path, id] of owner) {
    const found = vector(path);
    if (!found) continue;
    const entry = sums.get(id) ?? { sum: new Float32Array(found.length), count: 0 };
    for (let i = 0; i < found.length; i += 1) entry.sum[i] = entry.sum[i]! + found[i]!;
    entry.count += 1;
    sums.set(id, entry);
  }

  const samples: ResidualSample[] = [];
  for (const [dir, files] of direct) {
    const removed = new Map<string, number>();
    for (const path of files) removed.set(owner.get(path) ?? '', (removed.get(owner.get(path) ?? '') ?? 0) + 1);
    const covered = ancestors(dir).some((ancestor) => ownedAfterRemoval(under.get(ancestor), removed));
    const gone = new Set(files);
    const ownerWithout = { get: (path: string) => (gone.has(path) ? undefined : owner.get(path)) };
    const centroids = centroidsWithout(sums, files, owner, vector);
    if (centroids.size < 2) continue;
    for (const path of files) {
      const own = owner.get(path);
      const found = vector(path);
      if (!own || !found || covered) continue;
      if (isTestPath(path) && testSubject(path, imports.get(path) ?? [], ownerWithout) !== null) continue;
      const ranked = [...centroids].map(([id, center]) => ({ id, similarity: dot(found, center) })).sort((a, b) => b.similarity - a.similarity);
      const [best, second] = ranked;
      samples.push({ own, best: best!.id, bestSimilarity: best!.similarity, margin: best!.similarity - second!.similarity });
    }
  }
  return samples;
}

function ancestors(dir: string): string[] {
  const result = [dir];
  for (let current = dir; current !== '.'; ) {
    current = posix.dirname(current);
    result.push(current);
  }
  return result;
}

function add(counts: Map<string, Map<string, number>>, dir: string, id: string, amount: number): void {
  const map = counts.get(dir) ?? new Map<string, number>();
  map.set(id, (map.get(id) ?? 0) + amount);
  counts.set(dir, map);
}

function ownedAfterRemoval(counts: Map<string, number> | undefined, removed: ReadonlyMap<string, number>): boolean {
  if (!counts) return false;
  const left = [...counts].filter(([id, count]) => count - (removed.get(id) ?? 0) > 0);
  return left.length === 1 && left[0]![0] !== '';
}

function centroidsWithout(
  sums: ReadonlyMap<string, { sum: Float32Array; count: number }>,
  files: string[],
  owner: ReadonlyMap<string, string>,
  vector: (path: string) => Float32Array | undefined,
): Map<string, Float32Array> {
  const minus = new Map<string, { sum: Float32Array; count: number }>();
  for (const path of files) {
    const id = owner.get(path);
    const found = vector(path);
    if (!id || !found) continue;
    const entry = minus.get(id) ?? { sum: new Float32Array(found.length), count: 0 };
    for (let i = 0; i < found.length; i += 1) entry.sum[i] = entry.sum[i]! + found[i]!;
    entry.count += 1;
    minus.set(id, entry);
  }
  const result = new Map<string, Float32Array>();
  for (const [id, { sum, count }] of sums) {
    const taken = minus.get(id);
    if (count - (taken?.count ?? 0) <= 0) continue;
    const rest = sum.map((value, i) => value - (taken?.sum[i] ?? 0));
    const norm = Math.sqrt(dot(rest, rest));
    if (norm > 0) result.set(id, rest.map((value) => value / norm));
  }
  return result;
}
