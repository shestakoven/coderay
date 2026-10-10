import type { ChatImage, EffortLevel, ImageMediaType } from '@ide/protocol';
import type { ClaudeCommand, ProcessExit } from './claude-process';
import type { PermissionAnswer } from './prompts';

export interface GateLaunch {
  settingsPath: string;
  appendSystemPrompt: string;
}

// What a chat's claude starts with; each transport turns it into its own flags or options.
export interface Launch {
  claude: ClaudeCommand;
  cwd: string;
  claudeSessionId: string;
  resume: boolean;
  model: string | null;
  effort: EffortLevel | null;
  mcpConfigPath: string;
  disallowedTools: string[];
  gate: GateLaunch | null;
  killGraceMs?: number;
  pidDir?: string;
}

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
  message(value: unknown): void;
}

export interface AgentTransport {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessExit>;
  send(message: UserMessage): void;
  interrupt(): void;
  stopTask(taskId: string): void;
  respond(response: ControlResponse): void;
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
