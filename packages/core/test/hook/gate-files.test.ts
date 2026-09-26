import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT, removeGateFiles, writeGateFiles } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

describe('writeGateFiles', () => {
  it("writes a PreToolUse command hook for every tool, run by the core's Node, and its private config", () => {
    const dir = join(tempDir('ide-home-'), 'run');
    const files = writeGateFiles(dir, 'key-s1', { url: 'http://127.0.0.1:4317/hook', secret: 's3cret' });
    expect(JSON.parse(readFileSync(files.settingsPath, 'utf8'))).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: [HOOK_SCRIPT, files.hookConfigPath], timeout: 3600 }] }] },
    });
    expect(JSON.parse(readFileSync(files.hookConfigPath, 'utf8'))).toEqual({ url: 'http://127.0.0.1:4317/hook', secret: 's3cret', deadlineMs: 3_540_000 });
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect([mode(dir), mode(files.settingsPath), mode(files.hookConfigPath)]).toEqual([0o700, 0o600, 0o600]);
  });

  it('removes both files', () => {
    const dir = join(tempDir('ide-home-'), 'run');
    const files = writeGateFiles(dir, 'key-s1', { url: 'http://127.0.0.1:1/hook', secret: 's' });
    removeGateFiles(dir, 'key-s1');
    expect([existsSync(files.settingsPath), existsSync(files.hookConfigPath)]).toEqual([false, false]);
  });
});
