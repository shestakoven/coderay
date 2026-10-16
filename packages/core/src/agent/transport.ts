import type { ChatImage, EffortLevel, EngineId, ImageMediaType } from '@ide/protocol';
import type { HookAnswer } from '../gate/hook-gate';
import type { ClaudeCommand, ProcessExit } from './claude-process';
import type { CodexCommand } from './codex/command';
import type { JsonValue } from './codex/protocol';
import type { PermissionAnswer } from './prompts';
import type { StreamEvent } from './stream';

export interface GateLaunch {
  settingsPath: string;
  appendSystemPrompt: string;
}

/** A call that may write, in claude's PreToolUse hook input shape, for the gate to decide. */
export interface GateCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  cwd: string;
}

/** What every engine starts a chat's agent with. */
export interface LaunchBase {
  engine: EngineId;
  cwd: string;
  engineSessionId: string;
  resume: boolean;
  model: string | null;
  effort: string | null;
  killGraceMs?: number;
  pidDir?: string;
  /** The gate, for engines whose writes reach it as requests rather than through claude's hook; null when the call went away first. */
  decide?: (call: GateCall, signal: AbortSignal) => Promise<HookAnswer | null>;
}

/** Claude's launch: the MCP config and the gate's settings AgentSession writes for it, and claude's own flags. */
export interface ClaudeLaunch extends LaunchBase {
  effort: EffortLevel | null;
  claude: ClaudeCommand;
  mcpConfigPath: string;
  disallowedTools: string[];
  gate: GateLaunch | null;
}

/** Codex's launch: its command under the chat's account, the thread config and instructions AgentSession prepares for it. */
export interface CodexLaunch extends LaunchBase {
  engine: 'codex';
  codex: CodexCommand;
  /** The MCP servers CodeRay defines (idecore first among them). */
  servers: string[];
  /** Thread config: CodeRay's MCP servers, features off. */
  config: Record<string, JsonValue>;
  /** The secrets `config` names by variable. */
  env: Record<string, string>;
  developerInstructions: string;
  signedOutHint: string;
}

export type Launch = ClaudeLaunch | CodexLaunch;

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } };
type TextBlock = { type: 'text'; text: string };

export interface UserMessage {
  type: 'user';
  message: { role: 'user'; content: string | (ImageBlock | TextBlock)[] };
  parent_tool_use_id: null;
}

export type ControlResponse =
  | { subtype: 'success'; request_id: string; response: PermissionAnswer }
  | { subtype: 'error'; request_id: string; error: string };

export interface TransportSink {
  event(event: StreamEvent): void;
}

export interface AgentTransport {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessExit>;
  send(message: UserMessage): void;
  interrupt(): void;
  stopTask(taskId: string): void;
  respond(response: ControlResponse): void;
  setModel(model: string | null): Promise<void>;
  skills(): Promise<string[]>;
  kill(): Promise<ProcessExit>;
}

export function gateArgs(gate: GateLaunch | null): string[] {
  return gate ? ['--settings', gate.settingsPath, '--append-system-prompt', gate.appendSystemPrompt, '--system-prompt-snapshot', 'off'] : [];
}

export function userMessage(text: string, images: ChatImage[]): UserMessage {
  if (images.length === 0) return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
  const blocks: (ImageBlock | TextBlock)[] = images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }));
  return { type: 'user', message: { role: 'user', content: text === '' ? blocks : [...blocks, { type: 'text', text }] }, parent_tool_use_id: null };
}
