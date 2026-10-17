import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, type ChatPick, type ModelInfo } from '@ide/protocol';
import {
  catalogOf, chooseMessage, effortChoices, indexOfKey, initialActive, loadRecent, matchSpans, menuKey, moveActive, pickerGroups, rememberModel, rowKeys, saveRecent, shownId,
  type KeyPress, type MenuAction, type PickerInput,
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

  it('keeps the first of two models one engine lists under the same id, so no two rows share a key', () => {
    const models = [
      { value: 'codex:x', name: 'X', engine: 'codex' as const, efforts: [] },
      { value: 'codex:x', name: 'X again', engine: 'codex' as const, efforts: ['low'] },
      { value: 'sonnet', name: 'Sonnet', engine: 'claude' as const, efforts: [] },
    ];
    expect(catalogOf(models).map((model) => model.name)).toEqual(['X', 'Sonnet']);
  });
});

describe('pickerGroups', () => {
  it("filters by name, id or engine, ignoring case, and shows an engine with no models only when it cannot run, while nothing is typed or its name is", () => {
    const noCodex = THREE_ENGINES.filter((model) => model.engine !== 'codex');
    const titles = (overrides: Partial<PickerInput>) => shown(overrides).map(([title]) => title);
    expect([
      shown({ query: 'LUNA' }), shown({ query: '5.5' }), shown({ query: 'openrouter' }), shown({ query: 'codex' }),
      titles({ models: noCodex }), titles({ models: noCodex, query: 'son' }), shown({ models: noCodex, query: 'Codex ' }),
      titles({ models: noCodex, engines: [{ engine: 'codex', state: 'ready', hint: null }] }),
      titles({ models: noCodex, engines: [{ engine: 'codex', state: 'ready', hint: null }], query: 'codex' }),
    ]).toEqual([
      [['Codex', ['codex:gpt-6-luna']]],
      [['Claude', ['sonnet']]],
      [['opencode', ['opencode:openrouter/anthropic/claude-3.5:beta']]],
      [['Codex', ['codex:gpt-6-luna']]],
      ['Claude', 'Codex', 'opencode'],
      ['Claude'],
      [['Codex', []]],
      ['Claude', 'opencode'],
      [],
    ]);
  });

  it('matches a query of several words when every word occurs, in any order, in the name, id or engine', () => {
    expect([shown({ query: 'gpt 6' }), shown({ query: '  luna   GPT ' }), shown({ query: 'claude sonnet' }), shown({ query: 'claude beta' }), shown({ query: 'sonnet luna' })]).toEqual([
      [['Codex', ['codex:gpt-6-luna']]],
      [['Codex', ['codex:gpt-6-luna']]],
      [['Claude', ['sonnet']]],
      [['opencode', ['opencode:openrouter/anthropic/claude-3.5:beta']]],
      [],
    ]);
  });

  it('shows only Claude when only Claude lists models, whether the core sent no engine status or only its own', () => {
    const claudeOnly = THREE_ENGINES.filter((model) => model.engine === 'claude');
    expect([shown({ models: claudeOnly, engines: [] }), shown({ models: claudeOnly, engines: [{ engine: 'claude', state: 'ready', hint: null }] })]).toEqual([
      [['Claude', ['sonnet', 'haiku']]],
      [['Claude', ['sonnet', 'haiku']]],
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
  it("starts on the current model in its engine's list, not among the recent ones, and on the first row otherwise; keeps a row by its group and model, falling back to the first once it is gone", () => {
    const groups = pickerGroups(input({ recent: ['haiku'] }));
    const keys = rowKeys(groups);
    expect([
      initialActive(groups, 'haiku'), initialActive(groups, 'gone'), initialActive(groups, null),
      keys.slice(0, 3), indexOfKey(keys, 'claude:haiku'), indexOfKey(keys, 'recent:haiku'), indexOfKey(keys, 'claude:gone'), indexOfKey(keys, null), indexOfKey([], 'claude:haiku'),
    ]).toEqual([2, 0, 0, ['recent:haiku', 'claude:sonnet', 'claude:haiku'], 2, 0, 0, 0, 0]);
  });

  it('moves one row with the arrows, eight with the page keys and to either end with Home and End, never past an end, and ignores other keys', () => {
    expect([
      moveActive(0, 5, 'ArrowUp'), moveActive(3, 5, 'ArrowDown'), moveActive(4, 5, 'ArrowDown'), moveActive(1, 20, 'PageDown'),
      moveActive(18, 20, 'PageDown'), moveActive(5, 20, 'PageUp'), moveActive(3, 5, 'Home'), moveActive(1, 5, 'End'), moveActive(2, 5, 'a'), moveActive(0, 0, 'ArrowDown'),
    ]).toEqual([0, 4, 4, 9, 19, 0, 0, 4, null, 0]);
  });

  it('in the search box moves with the arrows and page keys, chooses with Enter, closes with Tab either way, and leaves the rest to the box', () => {
    const press = (key: string, modifiers: Partial<KeyPress> = {}, query = 'son'): MenuAction => menuKey({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers }, 3, 20, query);
    expect([
      press('ArrowDown'), press('ArrowUp'), press('PageDown'), press('PageUp'), press('Enter'), press('Tab'), press('Tab', { shiftKey: true }),
      press('a'), press('Escape'), press('ArrowLeft'), press('Enter', { metaKey: true }), press('ArrowDown', { altKey: true }), press('ArrowUp', { metaKey: true }),
    ]).toEqual([{ move: 4 }, { move: 2 }, { move: 11 }, { move: 0 }, 'choose', 'close', 'close', null, null, null, null, null, null]);
  });

  it('moves to either end with Home and End only while nothing is typed: then they move the caret, and Shift with them selects', () => {
    const press = (key: string, query: string, shiftKey = false): MenuAction => menuKey({ key, shiftKey, altKey: false, ctrlKey: false, metaKey: false }, 3, 20, query);
    expect([press('Home', ''), press('End', ''), press('Home', 'son'), press('End', ' '), press('Home', '', true), press('ArrowDown', 'son', true)])
      .toEqual([{ move: 0 }, { move: 19 }, null, null, null, null]);
  });
});

describe('shownId', () => {
  it("shows a model's id as its engine names it, and none when the id is its name", () => {
    const named = (value: string, name: string) => shownId({ value, name, engine: 'claude', efforts: [] });
    expect([shownId(sonnet), shownId(luna), shownId(openrouter), named('claude-opus-4-6', 'claude-opus-4-6'), named('codex:gpt-5', 'gpt-5')])
      .toEqual(['sonnet', 'gpt-6-luna', 'openrouter/anthropic/claude-3.5:beta', null, null]);
  });
});

describe('matchSpans', () => {
  it("underlines the first place each word of the query occurs, ignoring case, merging words that touch or overlap", () => {
    const underlined = (text: string, query: string) => matchSpans(text, query).map((span) => (span.hit ? `[${span.text}]` : span.text)).join('');
    expect([
      underlined('GPT-6 Luna', 'gpt 6'), underlined('GPT-6 Luna', 'luna  gpt'), underlined('Sonnet 5.5', 'NET son'), underlined('Sonnet 5.5', ''),
      underlined('Sonnet 5.5', 'zzz son'), underlined('opencode:openrouter/anthropic/claude-3.5:beta', 'open'),
    ]).toEqual(['[GPT]-[6] Luna', '[GPT]-6 [Luna]', '[Sonnet] 5.5', 'Sonnet 5.5', '[Son]net 5.5', '[open]code:openrouter/anthropic/claude-3.5:beta']);
  });
});

describe('recent models', () => {
  it('keeps the five most recent, newest first, each once, also from a store written by hand or by an older build, and survives a store the browser blocks', () => {
    const storage = memoryStorage();
    let recent: string[] = [];
    for (const value of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'e']) recent = rememberModel(recent, value);
    saveRecent(storage, recent);
    saveRecent(blockedStorage(), recent);
    expect([
      loadRecent(storage), loadRecent(memoryStorage({ 'ide.recentModels': '["a","b","a",3,"c","b","d","e","f"]' })),
      loadRecent(blockedStorage()), loadRecent(memoryStorage({ 'ide.recentModels': '{"not":"a list"}' })), loadRecent(undefined),
    ]).toEqual([['e', 'f', 'd', 'a', 'c'], ['a', 'b', 'c', 'd', 'e'], [], [], []]);
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

  it("sends a new chat for another engine's model, a project's first pick with its first effort, the chat's new model with its effort, and nothing for the model it has", () => {
    const choose = (model: ModelInfo, locked: boolean, current: ChatPick | null) => chooseMessage({ model, locked }, current);
    const chat: ChatPick = { engine: 'claude', modelChoice: 'sonnet', effort: 'medium' };
    expect([
      choose(luna, true, chat), choose(openrouter, true, chat), choose(sonnet, false, null), choose(haiku, false, null), choose(openrouter, false, null),
      choose(haiku, false, chat), choose(sonnet, false, chat), choose(sonnet, false, { engine: 'claude', modelChoice: null, effort: null }),
    ]).toEqual([
      { type: 'session.new', modelChoice: 'codex:gpt-6-luna', effort: 'medium' },
      { type: 'session.new', modelChoice: 'opencode:openrouter/anthropic/claude-3.5:beta', effort: null },
      { type: 'session.configure', modelChoice: 'sonnet', effort: 'medium' },
      { type: 'session.configure', modelChoice: 'haiku', effort: null },
      { type: 'session.configure', modelChoice: 'opencode:openrouter/anthropic/claude-3.5:beta', effort: 'high' },
      { type: 'session.configure', modelChoice: 'haiku', effort: 'medium' },
      null,
      { type: 'session.configure', modelChoice: 'sonnet', effort: null },
    ]);
  });
});
