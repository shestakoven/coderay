import { EFFORT_LEVELS, ENGINE_IDS, ENGINE_NAMES, parseModelId, type EngineId, type EngineStatus, type ModelInfo } from '@ide/protocol';

const CLAUDE_EFFORTS: string[] = [...EFFORT_LEVELS];
const FIRST_EFFORT = 'medium';

// Offered when claude cannot list its models.
const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'fable', name: 'Fable 5.1', engine: 'claude', efforts: CLAUDE_EFFORTS },
  { value: 'opus', name: 'Opus 5.5', engine: 'claude', efforts: CLAUDE_EFFORTS },
  { value: 'sonnet', name: 'Sonnet 5.5', engine: 'claude', efforts: CLAUDE_EFFORTS },
  { value: 'haiku', name: 'Haiku 4.5', engine: 'claude', efforts: CLAUDE_EFFORTS },
];

const RECENT_KEY = 'ide.recentModels';
const RECENT_KEPT = 5;
const RECENT_SHOWN = 3;
const PAGE = 8;

export interface PickerRow {
  model: ModelInfo;
  /** A model of another engine on a chat in use: choosing it opens a new chat. */
  locked: boolean;
}

export interface PickerGroup {
  id: EngineId | 'recent';
  title: string;
  status: EngineStatus | null;
  rows: PickerRow[];
}

export interface PickerInput {
  models: ModelInfo[];
  engines: EngineStatus[];
  /** The chat's engine; null before any chat. */
  engine: EngineId | null;
  /** The chat's model id; null before any chat or on claude's own default. */
  current: string | null;
  /** The chat is in use, so its engine is fixed. */
  started: boolean;
  query: string;
  recent: string[];
}

/** The models to offer, each with its engine and efforts (a core older than the engines sends neither), with Claude's built-in list when claude listed none. */
export function catalogOf(models: ModelInfo[]): ModelInfo[] {
  const known = models.map((model) => ({ ...model, engine: model.engine ?? 'claude', efforts: model.efforts ?? CLAUDE_EFFORTS }));
  return known.some((model) => model.engine === 'claude') ? known : [...FALLBACK_MODELS, ...known];
}

export function pickerGroups({ models, engines, engine, current, started, query, recent }: PickerInput): PickerGroup[] {
  const q = query.trim().toLowerCase();
  // The chat's own model stays choosable when no engine lists it any more, as the old select kept it.
  const listed = current === null || models.some((model) => model.value === current)
    ? models
    : [...models, { value: current, name: current, engine: parseModelId(current)?.engine ?? engine ?? 'claude', efforts: [] }];
  const row = (model: ModelInfo): PickerRow => ({ model, locked: started && engine !== null && model.engine !== engine });
  const hit = (model: ModelInfo): boolean => [model.name, model.value, ENGINE_NAMES[model.engine]].some((text) => text.toLowerCase().includes(q));
  const byValue = new Map(listed.map((model) => [model.value, model]));
  const recentRows = q === '' ? recent.flatMap((value) => byValue.get(value) ?? []).slice(0, RECENT_SHOWN).map(row) : [];
  const groups = ENGINE_IDS.map((id): PickerGroup => ({
    id, title: ENGINE_NAMES[id], status: engines.find((status) => status.engine === id) ?? null,
    rows: listed.filter((model) => model.engine === id && hit(model)).map(row),
  }));
  return [
    ...(recentRows.length > 0 ? [{ id: 'recent' as const, title: 'Recent', status: null, rows: recentRows }] : []),
    // An engine that cannot run keeps its header, so the user sees why its models are missing.
    ...groups.filter((group) => group.rows.length > 0 || (q === '' && group.status !== null && group.status.state !== 'ready')),
  ];
}

/** Where the keyboard starts: the current model in its engine's list, else the first row. */
export function initialActive(groups: PickerGroup[], current: string | null): number {
  return Math.max(0, groups.flatMap((group) => group.rows).findLastIndex((row) => row.model.value === current));
}

/** The active row after a key; null for a key that does not move it. */
export function moveActive(active: number, count: number, key: string): number | null {
  const last = Math.max(0, count - 1);
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, active + 1);
    case 'ArrowUp':
      return Math.max(0, active - 1);
    case 'PageDown':
      return Math.min(last, active + PAGE);
    case 'PageUp':
      return Math.max(0, active - PAGE);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

export const rememberModel = (recent: string[], value: string): string[] => [value, ...recent.filter((item) => item !== value)].slice(0, RECENT_KEPT);

export function loadRecent(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

export function saveRecent(storage: Pick<Storage, 'setItem'> | undefined, recent: string[]): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // storage can be blocked; the recent models are then forgotten on reload
  }
}

/** The efforts to offer for a model, always with the chat's own: claude is still sent it when the model lists none. */
export function effortChoices(model: ModelInfo | undefined, engine: EngineId | null, current: string | null): string[] {
  const efforts = model?.efforts ?? (engine === null || engine === 'claude' ? CLAUDE_EFFORTS : []);
  return current !== null && !efforts.includes(current) ? [...efforts, current] : efforts;
}

/** The effort a project's first chat starts with, as a later chat would inherit it: medium when the model has it, else its first. */
export const firstEffort = (model: ModelInfo): string | null => (model.efforts.includes(FIRST_EFFORT) ? FIRST_EFFORT : (model.efforts[0] ?? null));

/** The effort a new chat on this model starts with: the current one when the model has it, else the engine's own default. */
export const newChatEffort = (model: ModelInfo, current: string | null): string | null => (current !== null && model.efforts.includes(current) ? current : null);
