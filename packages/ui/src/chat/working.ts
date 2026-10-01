import type { ToolItem } from '@ide/protocol';
import type { ChatState } from './chat-state';

export interface Working {
  label: string;
  since: number;
}

const MAX_LABEL = 70;

const clip = (text: string): string => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text);

export function workingState(chat: ChatState, sentAt: number | null): Working | null {
  const open = Object.values(chat.turns).filter((turn) => turn.closedAt === null);
  if (open.length === 0) return sentAt === null ? null : { label: 'Starting the agent…', since: sentAt };
  const since = Math.min(...open.map((turn) => turn.startedAt ?? turn.openedAt));
  const items = Object.values(chat.items);
  if (items.some((item) => item.kind === 'prompt' && item.status === 'pending')) return { label: 'Waiting for your answer', since };
  const running = items
    .filter((item): item is ToolItem => item.kind === 'tool' && item.status === 'running')
    .sort((a, b) => b.seq - a.seq)[0];
  if (!running) return { label: 'Thinking…', since };
  const name = running.tool.replace(/^mcp__.*?__/, '');
  if (name === 'propose_plan') return { label: 'Waiting for you to approve the plan', since };
  return { label: clip(`${name} ${running.summary}`.trim()), since };
}

export function elapsedLabel(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
