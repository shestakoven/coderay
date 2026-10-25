import type { ClientMessage, GitClientMessage, HistoryClientMessage } from '@ide/protocol';

export type MessageRoute = 'history' | 'git' | 'settings' | 'unknown';
export type SettingsClientMessage = Extract<ClientMessage, { requestId: string; type: `mcp.${string}` | `policy.${string}` | `account.${string}` | `background-ai.${string}` }>;

const HISTORY = new Set(['watchdog.answer', 'watchdog.stop-agent', 'history.diff', 'review.graph', 'revert.undo', 'change.revert', 'step.rollback-preview', 'step.rollback']);
const GIT = new Set([
  'git.refresh', 'git.init', 'git.diff', 'git.stage', 'git.unstage', 'git.discard', 'git.commit', 'git.branches',
  'git.branch-create', 'git.branch-switch', 'git.branch-delete',
]);
const SETTINGS = new Set([
  'mcp.save', 'mcp.remove', 'mcp.approve', 'mcp.confirm-external-edits', 'policy.save', 'policy.confirm-external-edits',
  'account.login.start', 'account.login.code', 'account.login.cancel', 'account.select', 'account.remove',
  'background-ai.save', 'background-ai.onboarded',
]);

export function routeOf(type: string): MessageRoute {
  if (HISTORY.has(type)) return 'history';
  if (GIT.has(type)) return 'git';
  if (SETTINGS.has(type)) return 'settings';
  return 'unknown';
}

export interface RouteHandlers {
  history(message: HistoryClientMessage): Promise<void>;
  git(message: GitClientMessage): Promise<void>;
  settings(message: SettingsClientMessage): Promise<void> | void;
  unknown(type: string): void;
}

export async function routeClientMessage(message: { type: string }, handlers: RouteHandlers): Promise<void> {
  switch (routeOf(message.type)) {
    case 'history':
      return handlers.history(message as HistoryClientMessage);
    case 'git':
      return handlers.git(message as GitClientMessage);
    case 'settings':
      return handlers.settings(message as SettingsClientMessage);
    case 'unknown':
      return handlers.unknown(message.type);
  }
}
