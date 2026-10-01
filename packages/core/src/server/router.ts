import type { ClientMessage, HistoryClientMessage } from '@ide/protocol';

export type MessageRoute = 'history' | 'settings' | 'unknown';
export type SettingsClientMessage = Extract<ClientMessage, { requestId: string; type: `mcp.${string}` | `policy.${string}` }>;

const HISTORY = new Set(['watchdog.answer', 'watchdog.stop-agent', 'history.diff', 'revert.undo', 'change.revert', 'step.rollback-preview', 'step.rollback']);
const SETTINGS = new Set(['mcp.save', 'mcp.remove', 'mcp.approve', 'mcp.confirm-external-edits', 'policy.save', 'policy.confirm-external-edits']);

export function routeOf(type: string): MessageRoute {
  if (HISTORY.has(type)) return 'history';
  if (SETTINGS.has(type)) return 'settings';
  return 'unknown';
}

export interface RouteHandlers {
  history(message: HistoryClientMessage): Promise<void>;
  settings(message: SettingsClientMessage): Promise<void> | void;
  unknown(type: string): void;
}

export async function routeClientMessage(message: { type: string }, handlers: RouteHandlers): Promise<void> {
  switch (routeOf(message.type)) {
    case 'history':
      return handlers.history(message as HistoryClientMessage);
    case 'settings':
      return handlers.settings(message as SettingsClientMessage);
    case 'unknown':
      return handlers.unknown(message.type);
  }
}
