import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileNoFollow } from '../mcp/config';

export const HOOK_SCRIPT = fileURLToPath(new URL('./pre-tool-use.mjs', import.meta.url));
export const SESSION_START_SCRIPT = fileURLToPath(new URL('./session-start.mjs', import.meta.url));
export const HOOK_TIMEOUT_S = 3600;
export const HOOK_DEADLINE_MS = 3_540_000;

const SESSION_START_TIMEOUT_S = 30;
const RUN_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface GateFiles {
  settingsPath: string;
  hookConfigPath: string;
}

const pathsOf = (dir: string, base: string): GateFiles => ({
  settingsPath: join(dir, `${base}.settings.json`),
  hookConfigPath: join(dir, `${base}.hook.json`),
});

export function writeGateFiles(
  dir: string,
  base: string,
  hook: { url: string; secret: string; sessionId?: string; deadlineMs?: number; nodePath?: string },
): GateFiles {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, RUN_DIR_MODE);
  const files = pathsOf(dir, base);
  writeFileNoFollow(files.hookConfigPath, JSON.stringify({ url: hook.url, secret: hook.secret, sessionId: hook.sessionId, deadlineMs: hook.deadlineMs ?? HOOK_DEADLINE_MS }), PRIVATE_FILE_MODE);
  const nodePath = hook.nodePath ?? process.execPath;
  const command = { type: 'command', command: nodePath, args: [HOOK_SCRIPT, files.hookConfigPath], timeout: HOOK_TIMEOUT_S };
  const start = { type: 'command', command: nodePath, args: [SESSION_START_SCRIPT, files.hookConfigPath], timeout: SESSION_START_TIMEOUT_S };
  const settings = { disableAllHooks: false, hooks: { PreToolUse: [{ matcher: '*', hooks: [command] }], SessionStart: [{ hooks: [start] }] } };
  writeFileNoFollow(files.settingsPath, JSON.stringify(settings), PRIVATE_FILE_MODE);
  return files;
}

export function removeGateFiles(dir: string, base: string): void {
  const files = pathsOf(dir, base);
  rmSync(files.settingsPath, { force: true });
  rmSync(files.hookConfigPath, { force: true });
}
