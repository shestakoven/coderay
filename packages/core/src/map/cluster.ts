import { dot } from './vectors';

export interface ClusterOptions {
  targetGroups: number;
  edgeBonus: number;
}

interface Merge {
  a: number;
  b: number;
  similarity: number;
}

export function averageLinkageGroups(vectors: Float32Array[], links: [number, number][], options: ClusterOptions): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  const merges = nearestNeighbourChain(similarityMatrix(vectors, links, options.edgeBonus), n);
  return cut(merges, n, options.targetGroups);
}

function similarityMatrix(vectors: Float32Array[], links: [number, number][], edgeBonus: number): Float32Array {
  const n = vectors.length;
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const similarity = dot(vectors[i]!, vectors[j]!);
      sim[i * n + j] = similarity;
      sim[j * n + i] = similarity;
    }
  }
  const linked = new Set(links.filter(([a, b]) => a !== b).map(([a, b]) => Math.min(a, b) * n + Math.max(a, b)));
  for (const key of linked) {
    const a = Math.floor(key / n);
    const b = key % n;
    sim[a * n + b] = sim[a * n + b]! + edgeBonus;
    sim[b * n + a] = sim[b * n + a]! + edgeBonus;
  }
  return sim;
}

function nearestNeighbourChain(sim: Float32Array, n: number): Merge[] {
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const merges: Merge[] = [];
  const chain: number[] = [];
  for (let remaining = n; remaining > 1; ) {
    if (chain.length === 0) chain.push(active.indexOf(true));
    const a = chain[chain.length - 1]!;
    const previous = chain.length > 1 ? chain[chain.length - 2]! : -1;
    let best = previous;
    let bestSimilarity = previous === -1 ? -Infinity : sim[a * n + previous]!;
    for (let c = 0; c < n; c += 1) {
      if (!active[c] || c === a) continue;
      const similarity = sim[a * n + c]!;
      if (similarity > bestSimilarity) {
        best = c;
        bestSimilarity = similarity;
      }
    }
    if (best !== previous) {
      chain.push(best);
      continue;
    }
    chain.length -= 2;
    const keep = Math.min(a, best);
    const drop = Math.max(a, best);
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === keep || k === drop) continue;
      const merged = (size[keep]! * sim[keep * n + k]! + size[drop]! * sim[drop * n + k]!) / (size[keep]! + size[drop]!);
      sim[keep * n + k] = merged;
      sim[k * n + keep] = merged;
    }
    size[keep] = size[keep]! + size[drop]!;
    active[drop] = false;
    merges.push({ a: keep, b: drop, similarity: bestSimilarity });
    remaining -= 1;
  }
  return merges;
}

function cut(merges: Merge[], n: number, targetGroups: number): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const ordered = merges
    .map((merge, order) => ({ ...merge, order }))
    .sort((x, y) => y.similarity - x.similarity || x.order - y.order);
  for (const merge of ordered.slice(0, Math.max(0, n - targetGroups))) parent[find(merge.b)] = find(merge.a);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const members = groups.get(root);
    if (members) members.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}
