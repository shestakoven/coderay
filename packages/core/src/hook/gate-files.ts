import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileNoFollow } from '../mcp/config';
import { nodeExecutable } from '../node-exec';

export const HOOK_SCRIPT = fileURLToPath(new URL('./pre-tool-use.mjs', import.meta.url));
export const SESSION_START_SCRIPT = fileURLToPath(new URL('./session-start.mjs', import.meta.url));
export const AGENT_EVENT_SCRIPT = fileURLToPath(new URL('./agent-event.mjs', import.meta.url));
export const HOOK_TIMEOUT_S = 3600;
export const HOOK_DEADLINE_MS = 3_540_000;

const SESSION_START_TIMEOUT_S = 30;
const AGENT_EVENT_TIMEOUT_S = 30;
// What the terminal's spinner says while a hook runs: a call's check takes moments, but it waits as long as the user has a question to answer.
const GATE_STATUS = 'IDE gate: checking or waiting for you';
const TURN_END_STATUS = 'IDE: waiting for you if a question is open';
const TOOL_EVENTS = ['PostToolUse', 'PostToolUseFailure'];
const SESSION_EVENTS = ['UserPromptSubmit', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionStart'];
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
  hook: { url: string; secret: string; sessionId?: string; deadlineMs?: number; nodePath?: string; events?: boolean },
): GateFiles {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, RUN_DIR_MODE);
  const files = pathsOf(dir, base);
  writeFileNoFollow(files.hookConfigPath, JSON.stringify({ url: hook.url, secret: hook.secret, sessionId: hook.sessionId, deadlineMs: hook.deadlineMs ?? HOOK_DEADLINE_MS }), PRIVATE_FILE_MODE);
  const nodePath = hook.nodePath ?? nodeExecutable();
  const command = { type: 'command', command: nodePath, args: [HOOK_SCRIPT, files.hookConfigPath], timeout: HOOK_TIMEOUT_S, ...(hook.events ? { statusMessage: GATE_STATUS } : {}) };
  const start = { type: 'command', command: nodePath, args: [SESSION_START_SCRIPT, files.hookConfigPath], timeout: SESSION_START_TIMEOUT_S };
  const event = (timeout: number, statusMessage?: string) => ({
    type: 'command', command: nodePath, args: [AGENT_EVENT_SCRIPT, files.hookConfigPath], timeout, ...(statusMessage === undefined ? {} : { statusMessage }),
  });
  // The end of a turn waits for the user while a question about the agent's changes is open, and is where the IDE asks about a step left active.
  const hooks: Record<string, object[]> = {
    PreToolUse: [{ matcher: '*', hooks: [command] }],
    SessionStart: [{ hooks: [start] }],
    Stop: [{ hooks: [event(HOOK_TIMEOUT_S, TURN_END_STATUS)] }],
  };
  // An agent in a terminal has no stream to read: its hooks report the turns, tools and subagents instead.
  if (hook.events) {
    for (const name of TOOL_EVENTS) hooks[name] = [{ matcher: '*', hooks: [event(AGENT_EVENT_TIMEOUT_S)] }];
    for (const name of SESSION_EVENTS) hooks[name] = [...(hooks[name] ?? []), { hooks: [event(AGENT_EVENT_TIMEOUT_S)] }];
  }
  const settings = { disableAllHooks: false, hooks };
  writeFileNoFollow(files.settingsPath, JSON.stringify(settings), PRIVATE_FILE_MODE);
  return files;
}

export function removeGateFiles(dir: string, base: string): void {
  const files = pathsOf(dir, base);
  rmSync(files.settingsPath, { force: true });
  rmSync(files.hookConfigPath, { force: true });
}
