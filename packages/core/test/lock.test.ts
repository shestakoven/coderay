import { spawn } from 'node:child_process';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireCoreLock, LOCK_FILE } from '../src/lock';
import { tempDir } from './helpers';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid ?? -1;
}

describe('acquireCoreLock', () => {
  it('refuses a second core while the core holding the lock is alive', () => {
    const dir = tempDir('ide-lock-');
    acquireCoreLock(dir);
    expect(acquireCoreLock(dir)).toMatchObject({ acquired: false, holder: process.pid, path: join(dir, LOCK_FILE) });
  });

  it('takes over a lock left by a core that is no longer running', async () => {
    const dir = tempDir('ide-lock-');
    writeFileSync(join(dir, LOCK_FILE), String(await deadPid()));
    expect(acquireCoreLock(dir).acquired).toBe(true);
  });

  it('lets the next core start after the lock is released', () => {
    const dir = tempDir('ide-lock-');
    acquireCoreLock(dir).release();
    expect(acquireCoreLock(dir).acquired).toBe(true);
  });

  it('creates the project dir 0700, since it holds full tool inputs', () => {
    const dir = join(tempDir('ide-home-'), 'projects', 'abc123');
    acquireCoreLock(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('fixes the project dir to 0700 when it already exists with looser permissions', () => {
    const dir = tempDir('ide-lock-');
    chmodSync(dir, 0o755);
    acquireCoreLock(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
