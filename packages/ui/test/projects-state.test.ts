import { describe, expect, it } from 'vitest';
import type { HubProject, HubSnapshot, RecentProject } from '@ide/protocol';
import {
  activeProject, afterClose, cycleTarget, initialProjects, jumpTarget, LEGACY_ID, projectHue, projectLetter, projectsReducer, statusOf, tabLabels,
  type ProjectsState,
} from '../src/project/projects-state';

const project = (id: string, over: Partial<HubProject> = {}): HubProject =>
  ({ id, root: `/home/u/${id}`, name: id, state: 'running', port: 4100, token: `tok-${id}`, error: null, ...over });
const recentItem = (name: string): RecentProject => ({ path: `/old/${name}`, name, openedAt: 1 });
const snapshot = (projects: HubProject[], activeId: string | null, over: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({ projects, activeId, home: '/home/u', recent: [], ...over });
const hub = (state: ProjectsState, ids: string[], activeId: string | null, over: Partial<HubSnapshot> = {}) =>
  projectsReducer(state, { type: 'hub', hub: snapshot(ids.map((id) => project(id)), activeId, over) });
const activate = (state: ProjectsState, id: string) => projectsReducer(state, { type: 'activate', id });
const ids = (state: ProjectsState) => state.projects.map((p) => p.id);
const working = { kind: 'working', line: 'npm test' } as const;

describe('initialProjects', () => {
  it('waits for the control socket with nothing open', () => {
    expect(initialProjects).toMatchObject({ mode: 'pending', projects: [], activeId: null, recency: [], recent: [], status: {}, closing: [] });
    expect(activeProject(initialProjects)).toBeNull();
  });
});

describe('projectsReducer hub snapshot', () => {
  it('switches to hub mode and takes projects in order, recent projects and home from the snapshot', () => {
    const recent = [recentItem('one')];
    const s = projectsReducer(initialProjects, { type: 'hub', hub: snapshot([project('b'), project('a')], 'a', { recent, home: '/Users/me' }) });
    expect(s.mode).toBe('hub');
    expect(s.projects).toEqual([project('b'), project('a')]);
    expect([s.recent, s.home]).toEqual([recent, '/Users/me']);
  });

  it('activates the snapshot active id when it is in the list', () => {
    expect(hub(initialProjects, ['a', 'b', 'c'], 'b').activeId).toBe('b');
  });

  it('falls back to the most recently shown project still present when the snapshot active id is unknown', () => {
    const shown = activate(activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c'), 'b');
    expect(shown.recency).toEqual(['b', 'c', 'a']);
    expect(hub(shown, ['a', 'c'], 'zzz').activeId).toBe('c');
  });

  it('falls back along the old recency when the snapshot names no active project', () => {
    const shown = activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c');
    expect(hub(shown, ['b', 'a'], null).activeId).toBe('a');
  });

  it('falls back to the first project when none of the previously shown ones is left', () => {
    const shown = hub(initialProjects, ['a', 'b'], 'a');
    expect(hub(shown, ['x', 'y'], null).activeId).toBe('x');
  });

  it('has no active project when the snapshot has no projects', () => {
    const s = hub(hub(initialProjects, ['a'], 'a'), [], 'a');
    expect([s.activeId, s.projects, activeProject(s)]).toEqual([null, [], null]);
  });

  it('builds the first recency from the active project and then list order', () => {
    expect(hub(initialProjects, ['a', 'b', 'c'], 'b').recency).toEqual(['b', 'a', 'c']);
  });

  it('orders recency: active first, then known ids in old recency order, then new ids in list order', () => {
    const shown = activate(activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'b'), 'c');
    expect(shown.recency).toEqual(['c', 'b', 'a']);
    expect(hub(shown, ['d', 'a', 'e', 'b'], 'a').recency).toEqual(['a', 'b', 'd', 'e']);
  });

  it('puts a new active project first and keeps the known ones after it', () => {
    const shown = activate(hub(initialProjects, ['a', 'b'], 'a'), 'b');
    expect(hub(shown, ['a', 'b', 'n'], 'n').recency).toEqual(['n', 'b', 'a']);
  });

  it('drops the status of projects that are gone and keeps the others', () => {
    let s = hub(initialProjects, ['a', 'b'], 'a');
    s = projectsReducer(s, { type: 'status', id: 'a', status: working });
    s = projectsReducer(s, { type: 'status', id: 'b', status: { kind: 'error', line: 'boom' } });
    const next = hub(s, ['a', 'c'], 'a');
    expect(next.status).toEqual({ a: working });
  });

  it('does not change the previous state', () => {
    const before = hub(initialProjects, ['a', 'b'], 'a');
    const copy = structuredClone(before);
    hub(before, ['b', 'c'], 'c');
    expect(before).toEqual(copy);
  });
});

describe('projectsReducer legacy', () => {
  const info = { root: '/w/shop', name: 'shop', home: '/w', recent: [recentItem('one')] };

  it('shows the single legacy project as running and active', () => {
    const s = projectsReducer(initialProjects, { type: 'legacy', info });
    expect(s.mode).toBe('legacy');
    expect(s.projects).toEqual([{ id: LEGACY_ID, root: '/w/shop', name: 'shop', state: 'running', port: null, token: null, error: null }]);
    expect(s.activeId).toBe(LEGACY_ID);
    expect(LEGACY_ID).toBe('legacy');
    expect(activeProject(s)?.root).toBe('/w/shop');
  });

  it('has no project and no active one when the core has no root', () => {
    const before = projectsReducer(initialProjects, { type: 'legacy', info });
    const s = projectsReducer(before, { type: 'legacy', info: { ...info, root: null } });
    expect([s.mode, s.projects, s.activeId]).toEqual(['legacy', [], null]);
  });
});

describe('projectsReducer activate', () => {
  const three = hub(initialProjects, ['a', 'b', 'c'], 'a');

  it('activates the project and moves it to the front of recency', () => {
    const s = activate(three, 'c');
    expect(s.activeId).toBe('c');
    expect(s.recency).toEqual(['c', 'a', 'b']);
    expect(activeProject(s)?.id).toBe('c');
  });

  it('keeps tab order when activating', () => {
    expect(ids(activate(three, 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('leaves the previous recency untouched', () => {
    activate(three, 'b');
    expect(three.recency).toEqual(['a', 'b', 'c']);
  });

  it('returns the same state for an unknown id', () => {
    expect(activate(three, 'nope')).toBe(three);
  });

  it('returns the same state for the project already active', () => {
    expect(activate(three, 'a')).toBe(three);
  });
});

describe('projectsReducer order', () => {
  const four = hub(initialProjects, ['a', 'b', 'c', 'd'], 'a');
  const order = (list: string[]) => projectsReducer(four, { type: 'order', ids: list });

  it('reorders the tabs to follow the ids', () => {
    expect(ids(order(['d', 'c', 'b', 'a']))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('keeps projects that are not named after the named ones, in their relative order', () => {
    expect(ids(order(['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores unknown ids', () => {
    expect(ids(order(['x', 'd', 'y', 'b']))).toEqual(['d', 'b', 'a', 'c']);
  });

  it('does not change the active project or the recency', () => {
    const s = order(['d', 'c', 'b', 'a']);
    expect([s.activeId, s.recency]).toEqual([four.activeId, four.recency]);
  });

  it('leaves the previous project list untouched', () => {
    order(['d', 'c']);
    expect(ids(four)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('projectsReducer remove', () => {
  const remove = (state: ProjectsState, id: string) => projectsReducer(state, { type: 'remove', id });
  // Shown a, then c, then b: b is on screen, c was shown just before it.
  const shown = activate(activate(hub(initialProjects, ['a', 'b', 'c', 'd'], 'a'), 'c'), 'b');

  it('takes the project off the tabs at once and marks it closing', () => {
    const s = remove(shown, 'c');
    expect(ids(s)).toEqual(['a', 'b', 'd']);
    expect(s.closing).toEqual(['c']);
  });

  it('keeps the active project when another one is removed', () => {
    expect(remove(shown, 'd').activeId).toBe('b');
  });

  it('moves to the most recently shown other project when the active one is removed', () => {
    expect(shown.recency).toEqual(['b', 'c', 'a', 'd']);
    const s = remove(shown, 'b');
    expect(s.activeId).toBe('c');
    expect(activeProject(s)?.id).toBe('c');
  });

  it('picks by recency, not by the neighbouring tab', () => {
    const s = activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c');
    expect(remove(s, 'c').activeId).toBe('a');
  });

  it('leaves nothing active when the only project is removed', () => {
    const s = remove(hub(initialProjects, ['a'], 'a'), 'a');
    expect([s.activeId, s.projects, activeProject(s)]).toEqual([null, [], null]);
  });

  it('drops the status of the removed project and keeps the others', () => {
    let s = projectsReducer(shown, { type: 'status', id: 'c', status: working });
    s = projectsReducer(s, { type: 'status', id: 'a', status: { kind: 'error', line: 'boom' } });
    const next = remove(s, 'c');
    expect(next.status).toEqual({ a: { kind: 'error', line: 'boom' } });
    expect(statusOf(next, 'c')).toEqual({ kind: 'idle', line: 'Idle' });
  });

  it('never cycles or jumps to the removed project', () => {
    const s = remove(shown, 'c');
    expect([cycleTarget(s, 1), cycleTarget(s, -1)]).not.toContain('c');
    expect([1, 2, 3, 9].map((key) => jumpTarget(s, key))).toEqual(['a', 'b', 'd', 'd']);
  });

  it('collects every project closed in a row', () => {
    expect(remove(remove(shown, 'a'), 'd').closing).toEqual(['a', 'd']);
  });

  it('does not change the previous state', () => {
    const copy = structuredClone(shown);
    remove(shown, 'b');
    expect(shown).toEqual(copy);
  });

  it('keeps a closing project hidden while the hub still lists it', () => {
    const s = hub(remove(shown, 'c'), ['a', 'b', 'c', 'd'], 'b');
    expect(ids(s)).toEqual(['a', 'b', 'd']);
    expect(s.closing).toEqual(['c']);
  });

  it('does not activate a closing project the hub still names as active', () => {
    const s = hub(remove(shown, 'b'), ['a', 'b', 'c', 'd'], 'b');
    expect(ids(s)).toEqual(['a', 'c', 'd']);
    expect(s.activeId).toBe('c');
  });

  it('does not bring back the status of a closing project', () => {
    const s = hub(remove(projectsReducer(shown, { type: 'status', id: 'c', status: working }), 'c'), ['a', 'b', 'c', 'd'], 'b');
    expect(statusOf(s, 'c')).toEqual({ kind: 'idle', line: 'Idle' });
  });

  it('forgets a closing project once the hub no longer lists it', () => {
    const closing = remove(remove(shown, 'a'), 'c');
    const s = hub(closing, ['b', 'c', 'd'], 'b');
    expect(s.closing).toEqual(['c']);
    expect(ids(s)).toEqual(['b', 'd']);
    expect(hub(s, ['b', 'd'], 'b').closing).toEqual([]);
  });

  it('shows the project again when it is reopened after the hub dropped it', () => {
    const gone = hub(remove(shown, 'c'), ['a', 'b', 'd'], 'b');
    expect(ids(hub(gone, ['a', 'b', 'd', 'c'], 'c'))).toEqual(['a', 'b', 'd', 'c']);
  });
});

describe('projectsReducer status', () => {
  const two = hub(initialProjects, ['a', 'b'], 'a');
  const setStatus = (state: ProjectsState, id: string, kind: 'working' | 'idle' | 'error' | 'attention', line: string) =>
    projectsReducer(state, { type: 'status', id, status: { kind, line } });

  it('stores the status of a project', () => {
    const s = setStatus(two, 'b', 'working', 'npm test');
    expect([statusOf(s, 'b'), statusOf(s, 'a')]).toEqual([working, { kind: 'idle', line: 'Idle' }]);
  });

  it('returns the same state for an identical status', () => {
    const s = setStatus(two, 'b', 'working', 'npm test');
    expect(setStatus(s, 'b', 'working', 'npm test')).toBe(s);
  });

  it('updates the status when only the line changes', () => {
    const s = setStatus(two, 'b', 'working', 'npm test');
    const next = setStatus(s, 'b', 'working', 'git push');
    expect(next).not.toBe(s);
    expect(statusOf(next, 'b')).toEqual({ kind: 'working', line: 'git push' });
    expect(statusOf(s, 'b')).toEqual(working);
  });

  it('updates the status when only the kind changes', () => {
    const s = setStatus(two, 'b', 'working', 'same');
    expect(statusOf(setStatus(s, 'b', 'attention', 'same'), 'b')).toEqual({ kind: 'attention', line: 'same' });
  });
});

describe('statusOf', () => {
  it('is idle for a project with no report', () => {
    expect(statusOf(initialProjects, 'anything')).toEqual({ kind: 'idle', line: 'Idle' });
  });
});

describe('cycleTarget', () => {
  // Shown a, then b, then c, then d: d is on screen, c was shown just before it.
  const shown = activate(activate(activate(hub(initialProjects, ['a', 'b', 'c', 'd'], 'a'), 'b'), 'c'), 'd');

  it('goes forward to the project shown just before this one', () => {
    expect(shown.recency).toEqual(['d', 'c', 'b', 'a']);
    expect(cycleTarget(shown, 1)).toBe('c');
  });

  it('goes back to the least recently shown project', () => {
    expect(cycleTarget(shown, -1)).toBe('a');
  });

  it('walks recency, not tab order', () => {
    const s = activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c');
    expect([cycleTarget(s, 1), cycleTarget(s, -1)]).toEqual(['a', 'b']);
  });

  it('toggles between two projects in both directions', () => {
    const s = hub(initialProjects, ['a', 'b'], 'a');
    expect([cycleTarget(s, 1), cycleTarget(s, -1)]).toEqual(['b', 'b']);
  });

  it('has no target with a single project or none', () => {
    expect([cycleTarget(hub(initialProjects, ['a'], 'a'), 1), cycleTarget(initialProjects, 1), cycleTarget(initialProjects, -1)]).toEqual([null, null, null]);
  });

  it('has no target when nothing is active', () => {
    const s: ProjectsState = { ...hub(initialProjects, ['a', 'b'], 'a'), activeId: null };
    expect([cycleTarget(s, 1), cycleTarget(s, -1)]).toEqual([null, null]);
  });
});

describe('jumpTarget', () => {
  const tabs = (n: number) => hub(initialProjects, Array.from({ length: n }, (_, i) => `p${i + 1}`), 'p1');

  it('jumps to the tab at position key - 1', () => {
    const s = tabs(3);
    expect([jumpTarget(s, 1), jumpTarget(s, 2), jumpTarget(s, 3)]).toEqual(['p1', 'p2', 'p3']);
  });

  it('follows tab order, not recency', () => {
    const s = projectsReducer(activate(tabs(3), 'p3'), { type: 'order', ids: ['p2', 'p3', 'p1'] });
    expect([jumpTarget(s, 1), jumpTarget(s, 3)]).toEqual(['p2', 'p1']);
  });

  it('has no target past the last tab', () => {
    expect([jumpTarget(tabs(3), 4), jumpTarget(tabs(3), 8)]).toEqual([null, null]);
  });

  it('jumps to the eighth tab with key 8', () => {
    expect(jumpTarget(tabs(10), 8)).toBe('p8');
  });

  it('jumps to the last tab with key 9, however many there are', () => {
    expect([jumpTarget(tabs(3), 9), jumpTarget(tabs(9), 9), jumpTarget(tabs(12), 9), jumpTarget(tabs(1), 9)]).toEqual(['p3', 'p9', 'p12', 'p1']);
  });

  it.each([0, 10, -1, 1.5, Number.NaN])('has no target for key %s', (key) => {
    expect(jumpTarget(tabs(12), key)).toBeNull();
  });

  it('has no target when no project is open', () => {
    expect([jumpTarget(initialProjects, 1), jumpTarget(initialProjects, 9)]).toEqual([null, null]);
  });
});

describe('afterClose', () => {
  it('keeps the active project when another one closes', () => {
    const s = activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'b');
    expect([afterClose(s, 'a'), afterClose(s, 'c')]).toEqual(['b', 'b']);
  });

  it('moves to the most recently shown other project when the active one closes', () => {
    const s = activate(activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c'), 'b');
    expect(s.recency).toEqual(['b', 'c', 'a']);
    expect(afterClose(s, 'b')).toBe('c');
  });

  it('picks by recency, not by the neighbouring tab', () => {
    const s = activate(hub(initialProjects, ['a', 'b', 'c'], 'a'), 'c');
    expect(afterClose(s, 'c')).toBe('a');
  });

  it('has nothing left when the only project closes', () => {
    expect(afterClose(hub(initialProjects, ['a'], 'a'), 'a')).toBeNull();
  });

  it('stays without an active project when nothing was active', () => {
    expect(afterClose(initialProjects, 'a')).toBeNull();
    const none: ProjectsState = { ...hub(initialProjects, ['a', 'b'], 'a'), activeId: null };
    expect([afterClose(none, 'a'), afterClose(none, 'b')]).toEqual([null, null]);
  });
});

describe('tabLabels', () => {
  const at = (id: string, root: string, name: string) => project(id, { root, name });

  it('labels a project with a unique name by its name', () => {
    expect(tabLabels([at('a', '/w/alpha/web', 'web'), at('b', '/w/beta/api', 'api')])).toEqual({ a: 'web', b: 'api' });
  });

  it('prefixes projects sharing a name with their parent folder', () => {
    const labels = tabLabels([at('a', '/w/alpha/web', 'web'), at('b', '/w/beta/web', 'web'), at('c', '/w/gamma/api', 'api')]);
    expect(labels).toEqual({ a: 'alpha/web', b: 'beta/web', c: 'api' });
  });

  it('uses the project name, not the folder name, after the parent folder', () => {
    expect(tabLabels([at('a', '/w/alpha/repo-1', 'Shop'), at('b', '/w/beta/repo-2', 'Shop')])).toEqual({ a: 'alpha/Shop', b: 'beta/Shop' });
  });

  it('prefixes every project of a name shared by three', () => {
    const labels = tabLabels([at('a', '/x/one/app', 'app'), at('b', '/x/two/app', 'app'), at('c', '/x/three/app', 'app')]);
    expect(labels).toEqual({ a: 'one/app', b: 'two/app', c: 'three/app' });
  });

  it('keeps the bare name for a root with no parent folder', () => {
    expect(tabLabels([at('a', '/app', 'app'), at('b', '/w/beta/app', 'app')])).toEqual({ a: 'app', b: 'beta/app' });
  });

  it('is empty for no projects', () => {
    expect(tabLabels([])).toEqual({});
  });
});

describe('projectLetter', () => {
  it.each([
    ['web', 'W'],
    ['  ide', 'I'],
    ['Shop', 'S'],
    ['1app', '1'],
    ['ёлка', 'Ё'],
    ['', '?'],
    ['   ', '?'],
  ])('%j gives %j', (name, letter) => {
    expect(projectLetter(name)).toBe(letter);
  });
});

describe('projectHue', () => {
  const roots = ['/home/u/web', '/home/u/api', '/srv/shop', '/w/alpha/web', '/w/beta/web', '/a', '/b', '/', '', '/Users/евгений/проект',
    '/very/long/path/'.repeat(40), 'C:\\code\\app', '/x/1', '/x/2', '/x/3', '/x/4', '/x/5', '/x/6', '/x/7', '/x/8'];

  it('is an integer hue from 0 to 359', () => {
    for (const root of roots) {
      const hue = projectHue(root);
      expect(Number.isInteger(hue), root).toBe(true);
      expect(hue, root).toBeGreaterThanOrEqual(0);
      expect(hue, root).toBeLessThan(360);
    }
  });

  it('gives the same root the same hue every time', () => {
    expect(roots.map(projectHue)).toEqual(roots.map(projectHue));
  });

  it('spreads different roots over different hues', () => {
    expect(new Set(roots.map(projectHue)).size).toBeGreaterThanOrEqual(12);
  });
});

describe('activeProject', () => {
  it('is the active project object', () => {
    const s = activate(hub(initialProjects, ['a', 'b'], 'a'), 'b');
    expect(activeProject(s)).toEqual(project('b'));
  });
});
