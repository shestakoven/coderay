import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRun } from '../../src/git/git-run';
import { tempDir } from '../helpers';

function script(body: string): { bin: string; dir: string } {
  const dir = tempDir('run-');
  const bin = join(dir, 'fake-git');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

describe('createRun', () => {
  it('hands git an environment whose messages are English even when LC_ALL says otherwise', async () => {
    const { bin, dir } = script('printf "%s|%s" "${LC_ALL-unset}" "$LC_MESSAGES"');
    vi.stubEnv('LC_ALL', 'ru_RU.UTF-8');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    expect(await createRun(dir, bin)(['x'])).toBe('unset|C');
  });

  it('asks a command that exceeds its time limit to stop with SIGTERM, so git can remove its lock files', async () => {
    const { bin, dir } = script('trap \'echo term > "$2"; exit 0\' TERM\nsleep 5 &\nwait $!');
    const mark = join(dir, 'mark');
    await expect(createRun(dir, bin)([mark], { timeoutMs: 150 })).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(existsSync(mark) && readFileSync(mark, 'utf8')).toBe('term\n'), { timeout: 3000 });
  });
});
