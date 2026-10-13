import type { EngineId } from './engines';
import type { ToolDecision } from './plans';

export const MAX_CLIENT_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 20;
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
// Largest image the core sends to the UI: the base64 frame must stay under the 8 MB per-client backlog.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ChatImage {
  mediaType: ImageMediaType;
  data: string;
}

// An image the chat shows; its bytes live in the core's blob store and travel on request (`image.get`).
export interface ImageRef {
  id: string;
  mediaType: ImageMediaType;
  bytes: number;
  width?: number;
  height?: number;
}

export type ImageFailure = 'missing' | 'too-large' | 'not-image' | 'unreadable';

export type SessionStatus = 'running' | 'stopped' | 'crashed' | 'ended' | 'refused';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelInfo {
  value: string;
  name: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  startedAt: number;
  lastActivityAt: number;
  status: SessionStatus;
  engine: EngineId;
  modelChoice: string | null;
  effort: EffortLevel | null;
  messages: number;
}

export interface SessionView {
  id: string;
  engine: EngineId;
  engineSessionId: string;
  status: SessionStatus;
  model: string | null;
  modelChoice: string | null;
  effort: EffortLevel | null;
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
  recovered?: boolean;
  images?: ImageRef[];
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
  recovered?: boolean;
  images?: ImageRef[];
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

export interface LimitWindow {
  /** Share of the window already used, 0 to 1. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
}

export interface UsageView {
  contextTokens: number | null;
  contextWindow: number | null;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
}

export const EMPTY_USAGE: UsageView = { contextTokens: null, contextWindow: null, fiveHour: null, sevenDay: null };

export interface SessionState {
  session: SessionView | null;
  turns: TurnView[];
  items: ChatItem[];
  tasks: TaskView[];
  mcpServers: McpServerState[];
  skills: string[];
  /** The chat's agent has said which skills it has (the list may be empty); false until it has, and in a chat whose agent has not run. */
  skillsKnown?: boolean;
  usage: UsageView;
}

export interface SessionPatch {
  session?: SessionView;
  turns?: TurnView[];
  items?: ChatItem[];
  tasks?: TaskView[];
  mcpServers?: McpServerState[];
  skills?: string[];
  skillsKnown?: boolean;
  usage?: UsageView;
}

export type SessionServerMessage =
  | { type: 'session.snapshot'; state: SessionState }
  | { type: 'session.patch'; patch: SessionPatch }
  | { type: 'session.delta'; text: string }
  | { type: 'sessions.snapshot'; activeId: string | null; sessions: ChatSummary[] }
  | { type: 'models.snapshot'; models: ModelInfo[] }
  | { type: 'image.data'; key: string; image: ImageRef; data: string }
  | { type: 'image.failed'; key: string; reason: ImageFailure }
  | { type: 'error'; message: string };

export type ChatClientMessage =
  | { type: 'chat.send'; text: string; images?: ChatImage[] }
  | { type: 'chat.stop' }
  | { type: 'task.stop'; id: string }
  | { type: 'session.rename'; id: string; title: string }
  | { type: 'session.restart' }
  | { type: 'session.new' }
  | { type: 'session.list' }
  | { type: 'models.list' }
  | { type: 'session.switch'; id: string }
  | { type: 'session.delete'; id: string }
  | { type: 'session.delete-all' }
  | { type: 'session.configure'; modelChoice: string | null; effort: EffortLevel | null }
  | { type: 'prompt.answer'; requestId: string; answer: PromptAnswer }
  // Exactly one of `id` (a blob the core stores) or `path` (a file as the agent wrote it, relative to the project root or absolute); `key` comes back on the answer.
  | { type: 'image.get'; key: string; id?: string; path?: string };
