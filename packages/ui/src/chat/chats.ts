import { EFFORT_LEVELS, type ChatSummary, type ClientMessage, type EffortLevel, type SessionView } from '@ide/protocol';

export interface Choice<T> {
  value: T | null;
  label: string;
}

const KNOWN_MODELS: Choice<string>[] = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export const DEFAULT_MODEL_LABEL = 'Default model';
export const DEFAULT_EFFORT_LABEL = 'Default effort';

export function modelOptions(current: string | null): Choice<string>[] {
  const known = KNOWN_MODELS.some((option) => option.value === current);
  return [{ value: null, label: DEFAULT_MODEL_LABEL }, ...KNOWN_MODELS, ...(current && !known ? [{ value: current, label: current }] : [])];
}

export const effortOptions: Choice<EffortLevel>[] = [
  { value: null, label: DEFAULT_EFFORT_LABEL },
  ...EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
];

export const modelLabel = (choice: string | null): string => modelOptions(choice).find((option) => option.value === choice)?.label ?? DEFAULT_MODEL_LABEL;

export const effortLabel = (effort: EffortLevel | null): string => (effort === null ? DEFAULT_EFFORT_LABEL : effort);

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
  change: { modelChoice: string | null } | { effort: EffortLevel | null },
): ClientMessage {
  return {
    type: 'session.configure',
    modelChoice: 'modelChoice' in change ? change.modelChoice : (session?.modelChoice ?? null),
    effort: 'effort' in change ? change.effort : (session?.effort ?? null),
  };
}

export const isEffort = (value: string): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value);
