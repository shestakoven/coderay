import { createHash } from 'node:crypto';
import type { FileEdge } from '@ide/protocol';
import type { AiComponent } from './map-file';
import { dot } from './vectors';

export interface GroupingBaseline {
  mapKey: string;
  centroids: Record<string, number[]>;
  componentEdges: string[];
  members: Record<string, [componentId: string, contentHash: string]>;
  complete: boolean;
}

export interface StalenessInput {
  totalFiles: number;
  unassigned: number;
  centroids: ReadonlyMap<string, Float32Array>;
  changedFiles: ReadonlyMap<string, number>;
  baseline: GroupingBaseline | null;
  componentEdges: ReadonlySet<string>;
}

export interface Staleness {
  reasons: string[];
  driftedComponents: string[];
}

const MIN_UNASSIGNED = 3;
const UNASSIGNED_RATIO = 0.1;
const MIN_CHANGED_FILES = 3;
const EDGE_CHANGE_RATIO = 0.3;
const MIN_EDGES = 4;

export function mapKey(ai: Pick<AiComponent, 'id' | 'files'>[], groupedAt: string | null): string {
  const content = JSON.stringify([groupedAt, ai.map((component) => [component.id, component.files])]);
  return createHash('sha256').update(content).digest('hex');
}

export function staleness(input: StalenessInput): Staleness {
  const reasons: string[] = [];
  if (input.unassigned >= MIN_UNASSIGNED && input.unassigned > input.totalFiles * UNASSIGNED_RATIO) {
    reasons.push(`${input.unassigned} of ${input.totalFiles} files are not in any component`);
  }
  const drifted = input.baseline ? driftedComponents(input.baseline.centroids, input.centroids, input.changedFiles) : [];
  if (drifted.length > 0) reasons.push(`${drifted.join(', ')} changed a lot since the grouping`);
  if (input.baseline) {
    const before = new Set(input.baseline.componentEdges);
    const union = new Set([...before, ...input.componentEdges]);
    const changed = [...union].filter((edge) => before.has(edge) !== input.componentEdges.has(edge)).length;
    if (union.size >= MIN_EDGES && changed / union.size > EDGE_CHANGE_RATIO) {
      reasons.push(`${Math.round((changed / union.size) * 100)}% of the dependencies between components changed`);
    }
  }
  return { reasons, driftedComponents: drifted };
}

export function componentEdges(edges: FileEdge[], owner: ReadonlyMap<string, string>): Set<string> {
  const result = new Set<string>();
  for (const edge of edges) {
    const from = owner.get(edge.from);
    const to = owner.get(edge.to);
    if (from && to && from !== to) result.add(`${from} -> ${to}`);
  }
  return result;
}

export function changedFiles(
  members: GroupingBaseline['members'],
  owner: ReadonlyMap<string, string>,
  hashes: ReadonlyMap<string, string>,
): Map<string, number> {
  const changed = new Map<string, number>();
  const count = (id: string) => changed.set(id, (changed.get(id) ?? 0) + 1);
  for (const [path, [id, hash]] of Object.entries(members)) {
    if (owner.get(path) !== id || hashes.get(path) !== hash) count(id);
  }
  for (const [path, id] of owner) {
    if (members[path]?.[0] !== id) count(id);
  }
  return changed;
}

function driftedComponents(
  baseline: Record<string, number[]>,
  current: ReadonlyMap<string, Float32Array>,
  changed: ReadonlyMap<string, number>,
): string[] {
  const before = Object.entries(baseline).map(([id, values]) => [id, Float32Array.from(values)] as const);
  return before.flatMap(([id, vector]) => {
    const now = current.get(id);
    if (!now || (changed.get(id) ?? 0) < MIN_CHANGED_FILES) return [];
    const neighbour = Math.max(...before.filter(([other]) => other !== id).map(([, other]) => dot(vector, other)));
    if (!Number.isFinite(neighbour)) return [];
    return dot(now, vector) < (1 + neighbour) / 2 ? [id] : [];
  });
}
