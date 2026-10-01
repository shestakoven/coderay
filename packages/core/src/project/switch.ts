import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function successorArgs(argv: string[], newRoot: string, port: number): string[] {
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
  return [...kept, '--project', newRoot, '--port', String(port)];
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
