import { posix } from 'node:path';
import { accepts, type EmbeddingRule } from './embedding-check';
import type { AiComponent } from './map-file';
import { isTestPath, testSubject } from './test-files';
import { centroid, dot } from './vectors';

export const EMBEDDING_RULE: EmbeddingRule | null = null;
export const MIN_SIBLINGS = 2;

export type Evidence = 'manual' | 'grouped' | 'test' | 'glob' | 'directory' | 'embedding';

export interface AssignInput {
  paths: string[];
  ai: AiComponent[];
  manualOwner: ReadonlyMap<string, string>;
  imports: ReadonlyMap<string, string[]>;
  vector: (path: string) => Float32Array | undefined;
  rule: EmbeddingRule | null;
}

export interface Assignment {
  owner: Map<string, string>;
  evidence: Map<string, Evidence>;
  pending: string[];
  unassigned: string[];
}

export function assignFiles(input: AssignInput): Assignment {
  const aiIds = new Set(input.ai.map((component) => component.id));
  const owner = new Map<string, string>();
  const evidence = new Map<string, Evidence>();
  const place = (path: string, id: string, reason: Evidence): void => {
    owner.set(path, id);
    evidence.set(path, reason);
  };
  const live = new Set(input.paths);
  for (const [path, id] of input.manualOwner) if (live.has(path)) place(path, id, 'manual');
  for (const component of input.ai) {
    for (const path of component.files) if (live.has(path) && !owner.has(path)) place(path, component.id, 'grouped');
  }

  const open = () => input.paths.filter((path) => !owner.has(path));
  const globbed = new Map(open().flatMap((path) => {
    const id = globOwner(path, input.ai);
    return id ? [[path, id] as const] : [];
  }));
  const anchors = new Map([...owner, ...globbed]);
  for (const path of open()) {
    const subject = isTestPath(path) ? testSubject(path, input.imports.get(path) ?? [], anchors) : null;
    if (subject !== null && aiIds.has(subject)) place(path, subject, 'test');
  }
  for (const [path, id] of globbed) if (!owner.has(path)) place(path, id, 'glob');

  const siblings = new Map<string, string[]>();
  for (const path of owner.keys()) {
    const dir = posix.dirname(path);
    const list = siblings.get(dir);
    if (list) list.push(path);
    else siblings.set(dir, [path]);
  }
  for (const path of open()) {
    const around = siblings.get(posix.dirname(path)) ?? [];
    const ids = new Set(around.map((sibling) => owner.get(sibling)!));
    const [only] = ids;
    if (around.length >= MIN_SIBLINGS && ids.size === 1 && only !== undefined && aiIds.has(only)) place(path, only, 'directory');
  }

  const pending: string[] = [];
  const unassigned: string[] = [];
  const rule = input.rule;
  const centroids = rule ? aiCentroids(membersOf(owner, aiIds), input.vector) : new Map<string, Float32Array>();
  for (const path of open()) {
    const vector = rule ? input.vector(path) : undefined;
    const id = rule && vector ? nearestComponent(vector, centroids, rule) : null;
    if (id) place(path, id, 'embedding');
    else if (rule && !vector) pending.push(path);
    else unassigned.push(path);
  }
  return { owner, evidence, pending, unassigned };
}

export function aiCentroids(
  components: Pick<AiComponent, 'id' | 'files'>[],
  vector: (path: string) => Float32Array | undefined,
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  for (const component of components) {
    const center = centroid(
      component.files.flatMap((path) => {
        const found = vector(path);
        return found ? [found] : [];
      }),
    );
    if (center) result.set(component.id, center);
  }
  return result;
}

export function nearestComponent(vector: Float32Array, centroids: ReadonlyMap<string, Float32Array>, rule: EmbeddingRule): string | null {
  if (centroids.size < 2) return null;
  let best: string | null = null;
  let bestSimilarity = -Infinity;
  let secondSimilarity = -Infinity;
  for (const [id, center] of centroids) {
    const similarity = dot(vector, center);
    if (similarity > bestSimilarity) {
      secondSimilarity = bestSimilarity;
      best = id;
      bestSimilarity = similarity;
    } else if (similarity > secondSimilarity) {
      secondSimilarity = similarity;
    }
  }
  return accepts(rule, { bestSimilarity, margin: bestSimilarity - secondSimilarity }) ? best : null;
}

function globOwner(path: string, ai: AiComponent[]): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const component of ai) {
    for (const glob of component.globs) {
      if (ownsPath(path, glob) && (!best || glob.length > best.length)) best = { id: component.id, length: glob.length };
    }
  }
  return best?.id;
}

const GLOB_META = /[*?[\]{}!]/;

// ownedGlobs (component-map.ts) only ever stores "dir/**" or "**"; a prefix check avoids the cost of a general glob matcher on the hot path.
// Falls back for a hand-edited "dir/**" whose "dir" is itself a pattern (e.g. "src/*/generated/**").
function ownsPath(path: string, glob: string): boolean {
  if (glob === '**') return true;
  if (glob.endsWith('/**') && !GLOB_META.test(glob.slice(0, -3))) return path.startsWith(glob.slice(0, -2));
  return posix.matchesGlob(path, glob);
}

function membersOf(owner: ReadonlyMap<string, string>, ids: ReadonlySet<string>): Pick<AiComponent, 'id' | 'files'>[] {
  const files = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const [path, id] of owner) files.get(id)?.push(path);
  return [...files].map(([id, list]) => ({ id, files: list }));
}
