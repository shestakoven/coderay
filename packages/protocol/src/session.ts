import type { ToolDecision } from './plans';

export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

export type SessionStatus = 'running' | 'stopped' | 'crashed' | 'ended' | 'refused';

export interface SessionView {
  id: string;
  claudeSessionId: string;
  status: SessionStatus;
  model: string | null;
  cliVersion: string | null;
  permissionMode: string | null;
  startedAt: number;
}

export type TurnKind = 'user' | 'agent-initiated';

export interface TurnView {
  id: string;
  kind: TurnKind;
  openedAt: number;
  startedAt: number | null;
  closedAt: number | null;
  resultSubtype: string | null;
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'rejected' | 'unfinished';

interface ItemBase {
  id: string;
  seq: number;
  turnId: string | null;
  parentToolUseId: string | null;
}

export interface MessageItem extends ItemBase {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface NoticeItem extends ItemBase {
  kind: 'notice';
  text: string;
  ts: number;
}

export interface ToolItem extends ItemBase {
  kind: 'tool';
  tool: string;
  summary: string;
  status: ToolStatus;
  startedAt: number;
  endedAt: number | null;
  decision: ToolDecision | null;
  targets: string[];
}

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

export type PromptBody =
  | { tool: 'AskUserQuestion'; questions: AskQuestion[] }
  | { tool: 'ExitPlanMode'; plan: string };

export type PromptAnswer =
  | { kind: 'answers'; answers: Record<string, string> }
  | { kind: 'allow' }
  | { kind: 'deny'; feedback: string };

export type PromptStatus = 'pending' | 'answered' | 'dropped';

export interface PromptItem extends ItemBase {
  kind: 'prompt';
  body: PromptBody;
  status: PromptStatus;
  answer: PromptAnswer | null;
  ts: number;
}

export type ChatItem = MessageItem | NoticeItem | ToolItem | PromptItem;

export type TaskKind = 'subagent' | 'shell' | 'monitor' | 'other';

export interface TaskView {
  id: string;
  toolUseId: string | null;
  kind: TaskKind;
  description: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
}

export interface McpServerState {
  name: string;
  status: string;
}

export interface SessionState {
  session: SessionView | null;
  turns: TurnView[];
  items: ChatItem[];
  tasks: TaskView[];
  mcpServers: McpServerState[];
}

export interface SessionPatch {
  session?: SessionView;
  turns?: TurnView[];
  items?: ChatItem[];
  tasks?: TaskView[];
  mcpServers?: McpServerState[];
}

export type SessionServerMessage =
  | { type: 'session.snapshot'; state: SessionState }
  | { type: 'session.patch'; patch: SessionPatch }
  | { type: 'error'; message: string };

export type ChatClientMessage =
  | { type: 'chat.send'; text: string }
  | { type: 'chat.stop' }
  | { type: 'session.restart' }
  | { type: 'session.new' }
  | { type: 'prompt.answer'; requestId: string; answer: PromptAnswer };
