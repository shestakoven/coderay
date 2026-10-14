import { ENGINE_CAPABILITIES, type ChatSummary, type ClientMessage, type EngineId, type ModelInfo, type SessionView } from '@ide/protocol';
import { catalogOf } from './model-picker';

export const modelLabel = (choice: string | null, models: ModelInfo[] = []): string => catalogOf(models).find((model) => model.value === choice)?.name ?? choice ?? '—';

export const effortLabel = (effort: string | null): string => effort ?? '—';

export const canOpenTerminal = (engine: EngineId): boolean => ENGINE_CAPABILITIES[engine].terminalView;

export const chatTitle = (chat: Pick<ChatSummary, 'title'>): string => (chat.title.trim() === '' ? 'New chat' : chat.title);

export function relativeTime(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export function configureMessage(
  session: Pick<SessionView, 'modelChoice' | 'effort'> | null,
  change: { modelChoice: string | null } | { effort: string | null },
): ClientMessage {
  return {
    type: 'session.configure',
    modelChoice: 'modelChoice' in change ? change.modelChoice : (session?.modelChoice ?? null),
    effort: 'effort' in change ? change.effort : (session?.effort ?? null),
  };
}
