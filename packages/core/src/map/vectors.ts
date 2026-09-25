export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * (b[i] ?? 0);
  return sum;
}

export function centroid(vectors: Float32Array[]): Float32Array | null {
  const first = vectors[0];
  if (!first) return null;
  const sum = new Float32Array(first.length);
  for (const vector of vectors) {
    for (let i = 0; i < sum.length; i += 1) sum[i] = sum[i]! + (vector[i] ?? 0);
  }
  const norm = Math.sqrt(dot(sum, sum));
  return norm === 0 ? null : sum.map((value) => value / norm);
}
