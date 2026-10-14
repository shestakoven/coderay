import { EFFORT_LEVELS, type ChatSummary, type ClientMessage, type EffortLevel, type ModelInfo, type SessionView } from '@ide/protocol';

export interface Choice<T> {
  value: T | null;
  label: string;
}

const FALLBACK_MODELS: Choice<string>[] = [
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const catalog = (models: ModelInfo[]): Choice<string>[] => (models.length === 0 ? FALLBACK_MODELS : models.map((model) => ({ value: model.value, label: model.name })));

export function modelOptions(current: string | null, models: ModelInfo[] = []): Choice<string>[] {
  const options = catalog(models);
  return [...options, ...(current && !options.some((option) => option.value === current) ? [{ value: current, label: current }] : [])];
}

export const effortOptions: Choice<EffortLevel>[] = EFFORT_LEVELS.map((level) => ({ value: level, label: level }));

export const modelLabel = (choice: string | null, models: ModelInfo[] = []): string => catalog(models).find((option) => option.value === choice)?.label ?? choice ?? '—';

export const effortLabel = (effort: string | null): string => effort ?? '—';

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

export const isEffort = (value: string): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value);
