export const MAX_CACHED_BYTES = 96 * 1024 * 1024;
export const MAX_CACHED_IMAGES = 200;

export interface CachedImage {
  id: string;
  bytes: number;
  // How many shown images use it; those stay whatever the budget.
  users: number;
  usedAt: number;
}

// The least recently used images nobody shows, dropped until the cache fits its budget again.
export function pickEvictions(images: CachedImage[], maxBytes = MAX_CACHED_BYTES, maxCount = MAX_CACHED_IMAGES): string[] {
  let bytes = images.reduce((sum, image) => sum + image.bytes, 0);
  let count = images.length;
  const evicted: string[] = [];
  for (const image of images.filter((candidate) => candidate.users === 0).sort((a, b) => a.usedAt - b.usedAt)) {
    if (bytes <= maxBytes && count <= maxCount) break;
    evicted.push(image.id);
    bytes -= image.bytes;
    count -= 1;
  }
  return evicted;
}
