import type { ChatItem, GatePromptView, PlanView } from '@ide/protocol';
import { canSend, type ChatState } from '../chat/chat-state';
import type { ConnectionStatus } from '../net/socket';
import { planTitle, waitsForUser } from '../plan/plan-state';

export type StatusKind = 'working' | 'attention' | 'idle' | 'error';

export interface ProjectStatus {
  kind: StatusKind;
  line: string;
}

export interface StatusInput {
  connection: ConnectionStatus;
  chat: ChatState;
  plan: PlanView | null;
  prompts: GatePromptView[];
  watchdog: boolean;
}

export const STATUS_LABEL: Record<StatusKind, string> = { working: 'Working', attention: 'Needs your answer', idle: 'Idle', error: 'Stopped' };
export const STARTING: ProjectStatus = { kind: 'working', line: 'Starting the core…' };
export const IDLE: ProjectStatus = { kind: 'idle', line: 'Idle' };

const firstQuestion = (item: ChatItem): string | null => {
  if (item.kind !== 'prompt' || item.status !== 'pending') return null;
  return item.body.tool === 'AskUserQuestion' ? (item.body.questions[0]?.question ?? 'A question is waiting') : 'The plan is waiting for approval';
};

function pendingChatQuestion(chat: ChatState): string | null {
  for (const item of Object.values(chat.items)) {
    const text = firstQuestion(item);
    if (text !== null) return text;
  }
  return null;
}

function runningTool(chat: ChatState): string | null {
  let latest: { startedAt: number; summary: string } | null = null;
  for (const item of Object.values(chat.items)) {
    if (item.kind !== 'tool' || item.status !== 'running' || item.parentToolUseId !== null) continue;
    if (latest === null || item.startedAt > latest.startedAt) latest = { startedAt: item.startedAt, summary: item.summary };
  }
  return latest?.summary ?? null;
}

export function deriveStatus({ connection, chat, plan, prompts, watchdog }: StatusInput): ProjectStatus {
  if (connection === 'closed') return { kind: 'error', line: 'The CodeRay core is not reachable' };
  const status = chat.session?.status;
  if (status === 'crashed' || status === 'refused') return { kind: 'error', line: status === 'crashed' ? 'The agent stopped unexpectedly' : 'The agent refused to start' };
  const question = pendingChatQuestion(chat);
  if (question !== null) return { kind: 'attention', line: question };
  if (watchdog) return { kind: 'attention', line: 'The watchdog needs a decision' };
  const gate = prompts.find((prompt) => prompt.status === 'pending');
  if (gate) return { kind: 'attention', line: gate.summary };
  if (waitsForUser(plan) && plan) return { kind: 'attention', line: `Plan waiting for approval: ${planTitle(plan)}` };
  if (!canSend(chat)) {
    const tool = runningTool(chat);
    return { kind: 'working', line: tool ?? 'Working…' };
  }
  return IDLE;
}

export interface Notice {
  kind: 'attention' | 'done' | 'error';
  title: string;
  body: string;
}

// A background project tells the user only about changes they can act on, once per change.
export function noticeFor(previous: ProjectStatus | undefined, next: ProjectStatus, name: string): Notice | null {
  if (previous === undefined || previous.kind === next.kind) return null;
  if (next.kind === 'attention') return { kind: 'attention', title: `${name} needs your answer`, body: next.line };
  if (next.kind === 'error') return { kind: 'error', title: `${name} stopped`, body: next.line };
  if (next.kind === 'idle' && previous.kind === 'working') return { kind: 'done', title: `${name} finished`, body: 'The agent is done.' };
  return null;
}
