import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive } from './os-process';

export interface CoreLock {
  acquired: boolean;
  holder: number;
  path: string;
  release(): void;
}

export const LOCK_FILE = 'core.lock';

export function acquireCoreLock(dir: string): CoreLock {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        acquired: true,
        holder: process.pid,
        path,
        release: () => {
          if (holderOf(path) === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = holderOf(path);
      if (holder !== null && isAlive(holder)) return { acquired: false, holder, path, release: () => {} };
      rmSync(path, { force: true });
    }
  }
  return { acquired: false, holder: holderOf(path) ?? -1, path, release: () => {} };
}

function holderOf(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
