import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { projectDir } from '../home';
import { acquireCoreLock } from '../lock';

export function successorArgs(argv: string[], newRoot: string | null, port: number): string[] {
  const kept: string[] = [];
  let skipValue = false;
  for (const arg of argv) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (arg === '--project' || arg === '--port') {
      skipValue = true;
      continue;
    }
    if (arg.startsWith('--project=') || arg.startsWith('--port=') || arg === '--token-stdin') continue;
    kept.push(arg);
  }
  return [...kept, ...(newRoot === null ? [] : ['--project', newRoot]), '--port', String(port)];
}

export const busyMessage = (pid: number | string): string => `That project is already open in another IDE core (pid ${pid}).`;

export function projectBusy(home: string, root: string): string | null {
  const probe = acquireCoreLock(projectDir(home, root));
  if (!probe.acquired) return busyMessage(probe.holder);
  probe.release();
  return null;
}

export function validateProjectPath(path: string): { root: string } | { error: string } {
  if (!isAbsolute(path)) return { error: 'The folder path must be absolute.' };
  try {
    const root = realpathSync.native(path);
    if (!statSync(root).isDirectory()) return { error: 'That path is not a folder.' };
    return { root };
  } catch {
    return { error: 'That folder does not exist or is not readable.' };
  }
}
