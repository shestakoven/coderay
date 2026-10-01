import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DirEntry } from '@ide/protocol';

export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  error: string | null;
}

export function listDirectories(path: string | null, home: string): Listing {
  const requested = resolve(path ?? home);
  let real: string;
  try {
    real = realpathSync.native(requested);
    if (!statSync(real).isDirectory()) return failure(requested, 'Not a directory.');
  } catch {
    return failure(requested, 'Folder not found or not readable.');
  }
  const parentPath = dirname(real);
  const parent = parentPath === real ? null : parentPath;
  try {
    const entries: DirEntry[] = [];
    for (const item of readdirSync(real, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const full = join(real, item.name);
      if (!isDirectory(full)) continue;
      entries.push({ name: item.name, isGit: existsSync(join(full, '.git')) });
    }
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
    return { path: real, parent, entries, error: null };
  } catch {
    return { path: real, parent, entries: [], error: 'Folder not readable.' };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function failure(path: string, error: string): Listing {
  return { path, parent: null, entries: [], error };
}
