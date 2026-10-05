import { describe, expect, it } from 'vitest';
import type { HubProject, RecentProject } from '@ide/protocol';
import { initialRow, matches, paletteGroups, type PaletteGroup, type PaletteInput, type PaletteRow } from '../src/project/palette-model';

const project = (id: string, name: string, root: string): HubProject => ({ id, root, name, state: 'running', port: 4100, token: 't', error: null });
const recent = (name: string, path: string): RecentProject => ({ name, path, openedAt: 1 });

const shop = project('p1', 'Shop', '/code/storefront');
const docs = project('p2', 'Docs', '/code/handbook');
const api = project('p3', 'Api', '/srv/backend');
const history = [
  recent('Shop', '/code/storefront'),
  recent('one', '/old/one'),
  recent('two', '/old/two'),
  recent('three', '/old/three'),
  recent('four', '/old/four'),
  recent('five', '/old/five'),
  recent('six', '/old/six'),
  recent('seven', '/old/seven'),
];

const groups = (over: Partial<PaletteInput> = {}) =>
  paletteGroups({ projects: [shop, docs, api], labels: { p2: 'team/Docs' }, recent: history, query: '', mac: true, ...over });
const titles = (list: PaletteGroup[]) => list.map((group) => group.title);
const rowsOf = (list: PaletteGroup[], title: string): PaletteRow[] => list.find((group) => group.title === title)?.rows ?? [];
const openIds = (list: PaletteGroup[]) => rowsOf(list, 'Open projects').map((row) => (row.kind === 'open' ? row.project.id : row.kind));
const recentNames = (list: PaletteGroup[]) => rowsOf(list, 'Recent').map((row) => (row.kind === 'recent' ? row.recent.name : row.kind));
const actionIds = (list: PaletteGroup[]) => rowsOf(list, 'Actions').map((row) => (row.kind === 'action' ? row.action : row.kind));

describe('matches', () => {
  it('matches everything with an empty query', () => {
    expect([matches('Shop', ''), matches('', '')]).toEqual([true, true]);
  });

  it('matches a substring, ignoring case', () => {
    expect([matches('Storefront', 'FRONT'), matches('storefront', 'Store'), matches('Shop', 'hop')]).toEqual([true, true, true]);
  });

  it('does not match a missing substring', () => {
    expect([matches('Shop', 'shops'), matches('Shop', 'x')]).toEqual([false, false]);
  });
});

describe('paletteGroups with no query', () => {
  it('lists open projects, recent projects and actions in that order', () => {
    expect(titles(groups())).toEqual(['Open projects', 'Recent', 'Actions']);
  });

  it('lists every open project in tab order with its label, or its name when it has none', () => {
    expect(rowsOf(groups(), 'Open projects')).toEqual([
      { kind: 'open', project: shop, label: 'Shop' },
      { kind: 'open', project: docs, label: 'team/Docs' },
      { kind: 'open', project: api, label: 'Api' },
    ]);
  });

  it('lists the first three recent projects that are not open', () => {
    expect(rowsOf(groups(), 'Recent')).toEqual([{ kind: 'recent', recent: history[1] }, { kind: 'recent', recent: history[2] }, { kind: 'recent', recent: history[3] }]);
  });

  it('lists the actions with mac shortcuts', () => {
    expect(rowsOf(groups(), 'Actions')).toEqual([
      { kind: 'action', action: 'open-folder', label: 'Open folder…', keys: '⌘O' },
      { kind: 'action', action: 'clone', label: 'Clone repository…', keys: '' },
      { kind: 'action', action: 'new', label: 'New project…', keys: '' },
      { kind: 'action', action: 'close', label: 'Close this project', keys: '⌘W' },
    ]);
  });

  it('shows Ctrl shortcuts on other platforms', () => {
    const keys = rowsOf(groups({ mac: false }), 'Actions').map((row) => (row.kind === 'action' ? row.keys : ''));
    expect(keys).toEqual(['Ctrl+O', '', '', 'Ctrl+W']);
  });

  it('omits the open projects group and the close action when nothing is open', () => {
    const list = groups({ projects: [], labels: {} });
    expect(titles(list)).toEqual(['Recent', 'Actions']);
    expect(actionIds(list)).toEqual(['open-folder', 'clone', 'new']);
  });

  it('shows the recent project of a closed project again', () => {
    expect(recentNames(groups({ projects: [], labels: {} }))).toEqual(['Shop', 'one', 'two']);
  });

  it('omits the recent group when there is no history', () => {
    expect(titles(groups({ recent: [] }))).toEqual(['Open projects', 'Actions']);
  });

  it('treats a blank query as no query', () => {
    expect(groups({ query: '   ' })).toEqual(groups());
  });
});

describe('paletteGroups with a query', () => {
  it('finds an open project by name, ignoring case', () => {
    expect(openIds(groups({ query: 'SHOP' }))).toEqual(['p1']);
  });

  it('finds an open project by its root', () => {
    expect(openIds(groups({ query: 'storefront' }))).toEqual(['p1']);
  });

  it('finds an open project by its label', () => {
    expect(openIds(groups({ query: 'team' }))).toEqual(['p2']);
  });

  it('trims the query', () => {
    expect(openIds(groups({ query: '  backend  ' }))).toEqual(['p3']);
  });

  it('keeps tab order among matching projects', () => {
    expect(openIds(groups({ query: '/code/' }))).toEqual(['p1', 'p2']);
  });

  it('finds recent projects by name or path, ignoring case', () => {
    expect(recentNames(groups({ query: 'TWO' }))).toEqual(['two']);
    expect(recentNames(groups({ query: '/old/f' }))).toEqual(['four', 'five']);
  });

  it('never lists an open project under recent, even when it matches', () => {
    const list = groups({ query: 'storefront' });
    expect([openIds(list), recentNames(list)]).toEqual([['p1'], []]);
  });

  it('lists up to six matching recent projects', () => {
    expect(recentNames(groups({ query: 'old' }))).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
  });

  it('filters the actions by their label', () => {
    expect(actionIds(groups({ query: 'clone' }))).toEqual(['clone']);
    expect(actionIds(groups({ query: 'PROJECT' }))).toEqual(['new', 'close']);
    expect(actionIds(groups({ query: 'folder' }))).toEqual(['open-folder']);
  });

  it('does not match an action by its shortcut', () => {
    expect(actionIds(groups({ query: '⌘O' }))).toEqual([]);
  });

  it('omits every empty group', () => {
    expect(titles(groups({ query: 'clone' }))).toEqual(['Actions']);
    expect(titles(groups({ query: 'seven' }))).toEqual(['Recent']);
    expect(groups({ query: 'zzz-nothing' })).toEqual([]);
  });
});

describe('initialRow', () => {
  const list = groups();

  it('selects the project used before the current one', () => {
    expect(initialRow(list, ['p1', 'p3', 'p2'], '')).toBe(2);
    expect(initialRow(list, ['p3', 'p2', 'p1'], '')).toBe(1);
  });

  it('selects the first row while searching', () => {
    expect(initialRow(list, ['p1', 'p3', 'p2'], 'sh')).toBe(0);
  });

  it('treats a blank query as no search', () => {
    expect(initialRow(list, ['p1', 'p3', 'p2'], '   ')).toBe(2);
  });

  it('selects the first row with no previous project', () => {
    expect([initialRow(list, ['p2'], ''), initialRow(list, [], '')]).toEqual([0, 0]);
  });

  it('selects the first row when the previous project is not listed', () => {
    expect(initialRow(list, ['p1', 'gone'], '')).toBe(0);
  });

  it('selects the first row of an empty palette', () => {
    expect(initialRow([], ['p1', 'p2'], '')).toBe(0);
  });
});
