import type { MapSnapshot } from '@ide/protocol';

// A file edited inside a nested git worktree (`.worktrees/x/backend/a.py`) is the same logical file as the project's `backend/a.py`:
// the longest known suffix of the path names it on the map.
export function resolveProjectPath(files: ReadonlySet<string>, path: string): string {
  if (files.has(path)) return path;
  const segments = path.split('/');
  for (let from = 1; from < segments.length; from++) {
    const suffix = segments.slice(from).join('/');
    if (files.has(suffix)) return suffix;
  }
  return path;
}

const resolvers = new WeakMap<MapSnapshot, (path: string) => string>();

export function projectPathOf(snapshot: MapSnapshot | null): (path: string) => string {
  if (!snapshot) return (path) => path;
  let resolver = resolvers.get(snapshot);
  if (!resolver) {
    const files = new Set(snapshot.files.map((file) => file.path));
    const cache = new Map<string, string>();
    resolver = (path) => {
      let found = cache.get(path);
      if (found === undefined) {
        found = resolveProjectPath(files, path);
        cache.set(path, found);
      }
      return found;
    };
    resolvers.set(snapshot, resolver);
  }
  return resolver;
}
