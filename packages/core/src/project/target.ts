import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateProjectName } from '@ide/protocol';

export interface Target {
  path: string;
  created: boolean;
}

export type ProjectResult = { root: string } | { error: string };

export function prepareTarget(parent: string, rawName: string): Target | { error: string } {
  const name = rawName.trim();
  const invalid = validateProjectName(name);
  if (invalid) return { error: invalid };
  if (!isAbsolute(parent)) return { error: 'The parent folder path must be absolute.' };
  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
    if (!statSync(realParent).isDirectory()) return { error: 'The parent path is not a folder.' };
  } catch {
    return { error: 'The parent folder does not exist or is not readable.' };
  }
  const path = join(realParent, name);
  try {
    if (!statSync(path).isDirectory() || readdirSync(path).length > 0) return { error: `"${name}" already exists in that folder and is not empty.` };
    return { path, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { error: `Cannot use "${name}": ${(error as Error).message}` };
    return { path, created: true };
  }
}

// A folder that existed before the call was empty and may be the user's own: empty it, never remove it.
export function discardTarget({ path, created }: Target): void {
  try {
    if (created) rmSync(path, { recursive: true, force: true });
    else for (const entry of readdirSync(path)) rmSync(join(path, entry), { recursive: true, force: true });
  } catch {
    // The folder is already gone.
  }
}
