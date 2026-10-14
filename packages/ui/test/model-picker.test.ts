import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, type ModelInfo } from '@ide/protocol';
import {
  catalogOf, effortChoices, firstEffort, initialActive, loadRecent, moveActive, newChatEffort, pickerGroups, rememberModel, saveRecent, type PickerInput,
} from '../src/chat/model-picker';
import { blockedStorage, memoryStorage } from './memory-storage';
import { ENGINE_STATES, THREE_ENGINES } from './model-fixtures';

const input = (overrides: Partial<PickerInput> = {}): PickerInput => ({ models: THREE_ENGINES, engines: ENGINE_STATES, engine: 'claude', current: null, started: false, query: '', recent: [], ...overrides });
const shown = (overrides: Partial<PickerInput> = {}) => pickerGroups(input(overrides)).map((group) => [group.title, group.rows.map((row) => row.model.value)]);
const [sonnet, haiku, luna, , openrouter] = THREE_ENGINES as [ModelInfo, ModelInfo, ModelInfo, ModelInfo, ModelInfo];

describe('catalogOf', () => {
  it("fills in the engine and efforts a core older than the engines leaves out, and adds Claude's built-in list only when no Claude model came", () => {
    const old = [{ value: 'claude-opus-4-6', name: 'Opus 4.6' }] as ModelInfo[];
    expect([catalogOf(old), catalogOf([luna]).map((model) => model.value)]).toEqual([
      [{ value: 'claude-opus-4-6', name: 'Opus 4.6', engine: 'claude', efforts: [...EFFORT_LEVELS] }],
      ['fable', 'opus', 'sonnet', 'haiku', 'codex:gpt-6-luna'],
    ]);
  });
});

describe('pickerGroups', () => {
  it('groups the models by engine, in engine order', () => {
    expect(shown()).toEqual([
      ['Claude', ['sonnet', 'haiku']],
      ['Codex', ['codex:gpt-6-luna']],
      ['opencode', ['opencode:opencode/nemotron-3.5-lightning-free', 'opencode:openrouter/anthropic/claude-3.5:beta']],
    ]);
  });

  it("filters by name, id or engine, ignoring case, and shows an engine with no models only while nothing is typed and only when it cannot run", () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    expect([
      shown({ query: 'LUNA' }), shown({ query: 'openrouter' }), shown({ query: 'codex' }),
      shown({ models: noCodex }).map(([title]) => title), shown({ models: noCodex, query: 'son' }).map(([title]) => title),
      shown({ models: noCodex, engines: [{ engine: 'codex', state: 'ready', hint: null }] }).map(([title]) => title),
    ]).toEqual([
      [['Codex', ['codex:gpt-6-luna']]],
      [['opencode', ['opencode:openrouter/anthropic/claude-3.5:beta']]],
      [['Codex', ['codex:gpt-6-luna']]],
      ['Claude', 'Codex', 'opencode'],
      ['Claude'],
      ['Claude', 'opencode'],
    ]);
  });

  it('locks the models of other engines only on a chat in use, and none before any chat', () => {
    const locked = (overrides: Partial<PickerInput>) => pickerGroups(input(overrides)).flatMap((group) => group.rows.filter((row) => row.locked).map((row) => row.model.engine));
    expect([locked({ started: true }), locked({ started: false }), locked({ started: true, engine: null })]).toEqual([['codex', 'opencode', 'opencode'], [], []]);
  });

  it('puts up to three recently used models first while nothing is typed, skipping ones no engine lists', () => {
    const recent = ['codex:gpt-6-luna', 'gone', 'haiku', 'sonnet', 'opencode:opencode/nemotron-3.5-lightning-free'];
    expect([shown({ recent })[0], shown({ recent, query: 'h' })[0]?.[0]]).toEqual([['Recent', ['codex:gpt-6-luna', 'haiku', 'sonnet']], 'Claude']);
  });

  it("lists the chat's own model in its engine when no engine lists it, as the old select kept it, and only then", () => {
    expect([shown({ current: 'claude-opus-4-6' })[0], shown({ current: 'sonnet' })[0], shown({ current: 'codex:gpt-5', engine: 'codex' })[1]]).toEqual([
      ['Claude', ['sonnet', 'haiku', 'claude-opus-4-6']],
      ['Claude', ['sonnet', 'haiku']],
      ['Codex', ['codex:gpt-6-luna', 'codex:gpt-5']],
    ]);
  });
});

describe('keyboard', () => {
  it("starts on the current model in its engine's list, not among the recent ones, and on the first row otherwise", () => {
    const groups = pickerGroups(input({ recent: ['haiku'] }));
    expect([initialActive(groups, 'haiku'), initialActive(groups, 'gone'), initialActive(groups, null)]).toEqual([2, 0, 0]);
  });

  it('moves one row with the arrows, eight with the page keys and to either end with Home and End, never past an end, and ignores other keys', () => {
    expect([
      moveActive(0, 5, 'ArrowUp'), moveActive(3, 5, 'ArrowDown'), moveActive(4, 5, 'ArrowDown'), moveActive(1, 20, 'PageDown'),
      moveActive(18, 20, 'PageDown'), moveActive(5, 20, 'PageUp'), moveActive(3, 5, 'Home'), moveActive(1, 5, 'End'), moveActive(2, 5, 'a'), moveActive(0, 0, 'ArrowDown'),
    ]).toEqual([0, 4, 4, 9, 19, 0, 0, 4, null, 0]);
  });
});

describe('recent models', () => {
  it('keeps the five most recent, newest first, each once, and survives a store the browser blocks', () => {
    const storage = memoryStorage();
    let recent: string[] = [];
    for (const value of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) recent = rememberModel(recent, value);
    saveRecent(storage, recent);
    saveRecent(blockedStorage(), recent);
    expect([loadRecent(storage), loadRecent(blockedStorage()), loadRecent(memoryStorage({ 'ide.recentModels': '{"not":"a list"}' })), loadRecent(undefined)])
      .toEqual([['f', 'e', 'd', 'a', 'c'], [], [], []]);
  });
});

describe('efforts', () => {
  it("offers the model's efforts, always keeps the chat's own (it is still sent), and offers Claude's five for a Claude model nobody listed", () => {
    expect([
      effortChoices(luna, 'codex', 'high'), effortChoices(luna, 'codex', 'ultra'), effortChoices(haiku, 'claude', 'medium'), effortChoices(haiku, 'claude', null),
      effortChoices(undefined, 'claude', null), effortChoices(undefined, 'codex', null), effortChoices(sonnet, 'claude', 'max'),
    ]).toEqual([
      ['minimal', 'low', 'medium', 'high'], ['minimal', 'low', 'medium', 'high', 'ultra'], ['medium'], [], [...EFFORT_LEVELS], [], [...EFFORT_LEVELS],
    ]);
  });

  it("starts a new chat on the chat's effort when the model has it, else on the engine's default, and a first chat on medium or the model's first effort", () => {
    expect([newChatEffort(luna, 'high'), newChatEffort(luna, 'max'), newChatEffort(luna, null), firstEffort(sonnet), firstEffort(openrouter), firstEffort(haiku)])
      .toEqual(['high', null, null, 'medium', 'high', null]);
  });
});
