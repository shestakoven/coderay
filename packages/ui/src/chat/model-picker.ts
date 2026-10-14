import {
  EFFORT_LEVELS, ENGINE_IDS, ENGINE_NAMES, parseModelId, type ChatPick, type ClientMessage, type EngineId, type EngineStatus, type ModelInfo,
} from '@ide/protocol';

const claudeEfforts = (): string[] => [...EFFORT_LEVELS];
const FIRST_EFFORT = 'medium';

// Offered when claude cannot list its models.
const FALLBACK_MODELS: readonly Omit<ModelInfo, 'efforts'>[] = [
  { value: 'fable', name: 'Fable 5.1', engine: 'claude' },
  { value: 'opus', name: 'Opus 5.5', engine: 'claude' },
  { value: 'sonnet', name: 'Sonnet 5.5', engine: 'claude' },
  { value: 'haiku', name: 'Haiku 4.5', engine: 'claude' },
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

export type MenuAction = { move: number } | 'choose' | 'close' | null;

export type KeyPress = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

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
  const known = models.map((model) => ({ ...model, engine: model.engine ?? 'claude', efforts: model.efforts ?? claudeEfforts() }));
  return known.some((model) => model.engine === 'claude') ? known : [...FALLBACK_MODELS.map((model) => ({ ...model, efforts: claudeEfforts() })), ...known];
}

const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter((word) => word !== '');

// Every word of the query must occur somewhere, in any order: "gpt 6" finds "GPT-6", "claude sonnet" finds Claude's Sonnet.
const matchesAll = (words: string[], texts: string[]): boolean => words.every((word) => texts.some((text) => text.toLowerCase().includes(word)));

export function pickerGroups({ models, engines, engine, current, started, query, recent }: PickerInput): PickerGroup[] {
  const words = queryWords(query);
  // The chat's own model stays choosable when no engine lists it any more, as the old select kept it.
  const listed = current === null || models.some((model) => model.value === current)
    ? models
    : [...models, { value: current, name: current, engine: parseModelId(current)?.engine ?? engine ?? 'claude', efforts: [] }];
  const row = (model: ModelInfo): PickerRow => ({ model, locked: started && engine !== null && model.engine !== engine });
  const hit = (model: ModelInfo): boolean => matchesAll(words, [model.name, model.value, ENGINE_NAMES[model.engine]]);
  const byValue = new Map(listed.map((model) => [model.value, model]));
  const recentRows = words.length === 0 ? recent.flatMap((value) => byValue.get(value) ?? []).slice(0, RECENT_SHOWN).map(row) : [];
  const groups = ENGINE_IDS.map((id): PickerGroup => ({
    id, title: ENGINE_NAMES[id], status: engines.find((status) => status.engine === id) ?? null,
    rows: listed.filter((model) => model.engine === id && hit(model)).map(row),
  }));
  return [
    ...(recentRows.length > 0 ? [{ id: 'recent' as const, title: 'Recent', status: null, rows: recentRows }] : []),
    // An engine that cannot run keeps its header, while nothing is typed or its name is, so the user sees why its models are missing.
    ...groups.filter((group) => group.rows.length > 0 || (group.status !== null && group.status.state !== 'ready' && matchesAll(words, [group.title]))),
  ];
}

/** The model's id as its engine names it, beside its name in the menu; null when it would only repeat the name. */
export function shownId(model: ModelInfo): string | null {
  const id = parseModelId(model.value)?.model ?? model.value;
  return id === model.name ? null : id;
}

/** The text split where the query's words first occur in it, for underlining; touching or overlapping matches merge. */
export function matchSpans(text: string, query: string): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const ranges = queryWords(query)
    .flatMap((word) => {
      const at = lower.indexOf(word);
      return at < 0 ? [] : [[at, at + word.length] as const];
    })
    .sort((a, b) => a[0] - b[0]);
  const spans: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) spans.push({ text: text.slice(from, start), hit: false });
    if (end > from) {
      const last = spans.at(-1);
      if (last?.hit && start <= from) last.text += text.slice(from, end);
      else spans.push({ text: text.slice(Math.max(start, from), end), hit: true });
      from = end;
    }
  }
  if (from < text.length) spans.push({ text: text.slice(from), hit: false });
  return spans;
}

/** Each row's key, in menu order: its group and model, as a model can show both among the recent ones and in its engine. */
export const rowKeys = (groups: PickerGroup[]): string[] => groups.flatMap((group) => group.rows.map((row) => `${group.id}:${row.model.value}`));

/** Where the active row is now: the row with its key, else, once that row is gone or before any, the first. */
export const indexOfKey = (keys: string[], key: string | null): number => (key === null ? 0 : Math.max(0, keys.indexOf(key)));

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

/** What a key does in the search box: move the active row, choose it, close the menu, or nothing, leaving it to the box. */
export function menuKey(press: KeyPress, active: number, count: number, query: string): MenuAction {
  if (press.key === 'Tab') return 'close';
  if (press.altKey || press.ctrlKey || press.metaKey) return null;
  if (press.key === 'Enter') return 'choose';
  // Once something is typed, Home and End move the caret, as in any text box.
  if (press.shiftKey || ((press.key === 'Home' || press.key === 'End') && query !== '')) return null;
  const to = moveActive(active, count, press.key);
  return to === null ? null : { move: to };
}

export const rememberModel = (recent: string[], value: string): string[] => [value, ...recent.filter((item) => item !== value)].slice(0, RECENT_KEPT);

export function loadRecent(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(0, RECENT_KEPT) : [];
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
  const efforts: readonly string[] = model?.efforts ?? (engine === null || engine === 'claude' ? EFFORT_LEVELS : []);
  return current !== null && !efforts.includes(current) ? [...efforts, current] : [...efforts];
}

/** The effort a project's first chat starts with, as a later chat would inherit it: medium when the model has it, else its first. */
export const firstEffort = (model: ModelInfo): string | null => (model.efforts.includes(FIRST_EFFORT) ? FIRST_EFFORT : (model.efforts[0] ?? null));

/** The effort a new chat on this model starts with: the current one when the model has it, else the engine's own default. */
export const newChatEffort = (model: ModelInfo, current: string | null): string | null => (current !== null && model.efforts.includes(current) ? current : null);

/** What choosing a row sends: a new chat for another engine's model, a project's first pick on the effort a later chat would inherit, the chat's new model with its effort, or nothing for the model it has. */
export function chooseMessage(row: PickerRow, current: ChatPick | null): ClientMessage | null {
  if (row.locked) return { type: 'session.new', modelChoice: row.model.value, effort: newChatEffort(row.model, current?.effort ?? null) };
  if (current === null) return { type: 'session.configure', modelChoice: row.model.value, effort: firstEffort(row.model) };
  return row.model.value === current.modelChoice ? null : { type: 'session.configure', modelChoice: row.model.value, effort: current.effort };
}
