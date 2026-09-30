import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT, removeGateFiles, SESSION_START_SCRIPT, writeGateFiles } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

describe('writeGateFiles', () => {
  it("writes a PreToolUse command hook for every tool, run by the core's Node, and its private config", () => {
    const dir = join(tempDir('ide-home-'), 'run');
    const files = writeGateFiles(dir, 'key-s1', { url: 'http://127.0.0.1:4317/hook', secret: 's3cret' });
    const settings = JSON.parse(readFileSync(files.settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: [HOOK_SCRIPT, files.hookConfigPath], timeout: 3600 }] },
    ]);
    expect(JSON.parse(readFileSync(files.hookConfigPath, 'utf8'))).toEqual({ url: 'http://127.0.0.1:4317/hook', secret: 's3cret', deadlineMs: 3_540_000 });
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect([mode(dir), mode(files.settingsPath), mode(files.hookConfigPath)]).toEqual([0o700, 0o600, 0o600]);
  });

  it('turns disableAllHooks off and installs a SessionStart canary next to the PreToolUse hook', () => {
    const dir = tempDir('run-');
    const files = writeGateFiles(dir, 'k-s1', { url: 'http://127.0.0.1:1/hook', secret: 's3cret', sessionId: 's1' });
    const settings = JSON.parse(readFileSync(files.settingsPath, 'utf8'));
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
    const start = settings.hooks.SessionStart[0].hooks[0];
    expect([start.command, start.args, start.timeout]).toEqual([process.execPath, [SESSION_START_SCRIPT, files.hookConfigPath], 30]);
    expect(SESSION_START_SCRIPT).toMatch(/session-start\.mjs$/);
    expect(JSON.parse(readFileSync(files.hookConfigPath, 'utf8')).sessionId).toBe('s1');
  });

  it('removes both files', () => {
    const dir = join(tempDir('ide-home-'), 'run');
    const files = writeGateFiles(dir, 'key-s1', { url: 'http://127.0.0.1:1/hook', secret: 's' });
    removeGateFiles(dir, 'key-s1');
    expect([existsSync(files.settingsPath), existsSync(files.hookConfigPath)]).toEqual([false, false]);
  });
});
