import { describe, expect, it } from 'vitest';
import type { MapOverview, OverviewComponent, OverviewGroup, OverviewLane, OverviewPart } from '@ide/protocol';
import { allGroupsOpen, focusOf, overviewGraph, ownership, pruneView, revealCenter, toggleAllGroups, type Expansion, type Selection } from '../src/overview/overview-graph';

const part = (id: string, files: number): OverviewPart => ({ id, name: id, summary: '', files, dirs: [`${id}/`], noise: false });
const component = (id: string, parts: OverviewPart[]): OverviewComponent => ({
  id, name: id, role: '', files: parts.reduce((sum, p) => sum + p.files, 0), langs: [], noise: false, parts,
});
const group = (id: string, lane: OverviewLane, components: OverviewComponent[]): OverviewGroup => ({
  id, name: id, summary: '', lane, noise: lane === 'noise', files: components.reduce((sum, c) => sum + c.files, 0), components,
});

// G1 (interface) holds W; G2 (core) holds A and D; G3 is the vendored group holding V.
const OVERVIEW: MapOverview = {
  state: 'ready',
  error: null,
  basedOnCurrentMap: true,
  groups: [
    group('G1', 'interface', [component('W', [part('W#1', 10), part('W#2', 6)])]),
    group('G2', 'core', [component('A', [part('A#1', 8), part('A#2', 4)]), component('D', [part('D#1', 5)])]),
    group('G3', 'noise', [component('V', [part('V#1', 40)])]),
  ],
  links: [
    { from: 'W#1', to: 'A#1', count: 3 },
    { from: 'W#2', to: 'A#2', count: 2 },
    { from: 'W#1', to: 'W#2', count: 5 },
    { from: 'A#1', to: 'D#1', count: 4 },
    { from: 'A#2', to: 'A#1', count: 1 },
    { from: 'A#1', to: 'V#1', count: 7 },
    { from: 'W#2', to: 'D#1', count: 1 },
  ],
  labels: [
    { from: 'W', to: 'A', label: 'places orders via' },
    { from: 'W', to: 'D', label: 'reads stock from' },
  ],
};

const open = (groups: string[], components: string[] = []): Expansion => ({ groups: new Set(groups), components: new Set(components) });
const graph = (expansion: Expansion) => overviewGraph(OVERVIEW, expansion);

describe('overviewGraph', () => {
  it.each([
    ['nothing is open', open([]), [['G1', null], ['G2', null], ['G3', null]]],
    ['a group is open', open(['G2']), [['G1', null], ['G2', null], ['A', 'G2'], ['D', 'G2'], ['G3', null]]],
    ['a group and one of its components are open', open(['G2'], ['A']), [['G1', null], ['G2', null], ['A', 'G2'], ['A#1', 'A'], ['A#2', 'A'], ['D', 'G2'], ['G3', null]]],
    ['a component is open inside a closed group', open([], ['A']), [['G1', null], ['G2', null], ['G3', null]]],
  ])('shows groups, then components, then parts, each inside its parent, when %s', (_name, expansion, expected) => {
    expect(graph(expansion).nodes.filter((n) => n.type !== 'ovlane').map((n) => [n.id, n.data.parent ?? null])).toEqual(expected);
  });

  it.each([
    ['nothing is open', open([]), [['G1', 'G2', 6, 'places orders via'], ['G2', 'G3', 7, '']]],
    ['a component is open inside a closed group', open([], ['A']), [['G1', 'G2', 6, 'places orders via'], ['G2', 'G3', 7, '']]],
    ['a group is open', open(['G2']), [['A', 'D', 4, ''], ['A', 'G3', 7, ''], ['G1', 'A', 5, 'places orders via'], ['G1', 'D', 1, 'reads stock from']]],
    [
      'every non-vendored group and component is open',
      open(['G1', 'G2'], ['W', 'A']),
      [['A#1', 'D', 4, ''], ['A#1', 'G3', 7, ''], ['A#2', 'A#1', 1, ''], ['W#1', 'A#1', 3, 'places orders via'], ['W#1', 'W#2', 5, ''], ['W#2', 'A#2', 2, 'places orders via'], ['W#2', 'D', 1, 'reads stock from']],
    ],
  ])('sums part links up to the visible level and drops links inside one card when %s', (_name, expansion, expected) => {
    const edges = graph(expansion).edges.map((e) => [e.source, e.target, e.data!.count, e.data!.label]);
    expect(edges.sort((a, b) => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`))).toEqual(expected);
  });

  it('draws one column per lane in use and puts vendored groups, muted down to their parts, in a strip under every column', () => {
    const { nodes } = graph(open(['G3'], ['V']));
    const node = (id: string) => nodes.find((n) => n.id === id)!;
    const lanes = nodes.filter((n) => n.type === 'ovlane');
    const columnsBottom = Math.max(...lanes.filter((n) => n.id !== 'lane:noise').map((n) => n.position.y + (n.height ?? 0)));
    expect(lanes.map((n) => n.id)).toEqual(['lane:interface', 'lane:core', 'lane:noise']);
    expect(node('lane:noise').position.y).toBeGreaterThanOrEqual(columnsBottom);
    expect(node('G3').position.y).toBeGreaterThan(node('lane:noise').position.y);
    expect(['G3', 'V', 'V#1'].map((id) => node(id).data.noise)).toEqual([true, true, true]);
  });
});

describe('focusOf', () => {
  it.each([
    ['nothing is selected', null, null],
    ['the selected card is gone from the map', { type: 'node', id: 'Gone' }, null],
    ['a closed card keeps only its own links', { type: 'node', id: 'D' }, { edges: ['e:A->D', 'e:G1->D'], nodes: ['A', 'D', 'G1'], context: ['G2'], extra: [] }],
    [
      'an open group shows its inside links and sums its outside links per neighbour',
      { type: 'node', id: 'G2' },
      { edges: ['e:A->D', 'w:G1->G2', 'w:G2->G3'], nodes: ['A', 'D', 'G1', 'G2', 'G3'], context: ['G2'], extra: [['G1', 'G2', 6], ['G2', 'G3', 7]] },
    ],
    ['a link keeps only itself and its ends', { type: 'edge', id: 'e:A->G3' }, { edges: ['e:A->G3'], nodes: ['A', 'G3'], context: ['G2'], extra: [] }],
  ] as [string, Selection, unknown][])('when %s', (_name, selection, expected) => {
    const { nodes, edges } = graph(open(['G2']));
    const focus = focusOf(selection, nodes, edges);
    expect(
      focus && {
        edges: [...focus.edges].sort(),
        nodes: [...focus.nodes].sort(),
        context: [...focus.context].sort(),
        extra: focus.extra.map((e) => [e.source, e.target, e.data!.count]),
      },
    ).toEqual(expected);
  });
});

describe('revealCenter', () => {
  const PANE = { width: 1000, height: 800 };
  it.each([
    ['stays put when the node fits', { x: 100, y: 100, width: 200, height: 100 }, { x: 0, y: 0, zoom: 1 }, null],
    ['stays put when the node fits only at the current zoom', { x: 1200, y: 100, width: 200, height: 100 }, { x: 0, y: 0, zoom: 0.5 }, null],
    ['centers a node that sticks out on the right', { x: 900, y: 100, width: 200, height: 100 }, { x: 0, y: 0, zoom: 1 }, { x: 1000, y: 150 }],
    ['centers a node the viewport has scrolled away', { x: 100, y: 100, width: 200, height: 100 }, { x: -300, y: 0, zoom: 1 }, { x: 200, y: 150 }],
    ['shows the top of a node taller than the pane', { x: 100, y: 100, width: 200, height: 2000 }, { x: 0, y: 0, zoom: 0.5 }, { x: 200, y: 870 }],
  ])('%s, without a zoom of its own', (_name, node, viewport, expected) => {
    expect(revealCenter(node, viewport, PANE)).toEqual(expected);
  });
});

describe('Expand all', () => {
  it.each([
    ['nothing is open', [], false, ['G1', 'G2']],
    ['some groups are open', ['G1'], false, ['G1', 'G2']],
    ['every group but the vendored one is open', ['G1', 'G2'], true, []],
  ])('when %s, opens every group but the vendored one, or closes all once they are open', (_name, opened, all, next) => {
    const set = new Set(opened);
    expect([allGroupsOpen(OVERVIEW, set), [...toggleAllGroups(OVERVIEW, set)].sort()]).toEqual([all, next]);
  });
});

describe('pruneView', () => {
  // The next answer keeps G1 and G2 without D, and drops the vendored G3.
  const NEXT: MapOverview = {
    ...OVERVIEW,
    groups: [OVERVIEW.groups[0]!, { ...OVERVIEW.groups[1]!, components: [OVERVIEW.groups[1]!.components[0]!] }],
  };
  const EMPTY: MapOverview = { ...OVERVIEW, groups: [], links: [], labels: [] };
  it.each([
    ['nothing is gone, keeping the same sets and the selected part', NEXT, ['G1', 'G2'], ['A'], { type: 'node', id: 'A#1' }, [['G1', 'G2'], ['A'], { type: 'node', id: 'A#1' }, true, true]],
    ['the selected component is still there', NEXT, [], [], { type: 'node', id: 'W' }, [[], [], { type: 'node', id: 'W' }, true, true]],
    ['the selected group is still there', NEXT, [], [], { type: 'node', id: 'G2' }, [[], [], { type: 'node', id: 'G2' }, true, true]],
    ['the selected part is gone', NEXT, ['G1'], ['W'], { type: 'node', id: 'D#1' }, [['G1'], ['W'], null, true, true]],
    ['an open group and an open component are gone, a selected link stays', NEXT, ['G1', 'G3'], ['A', 'V'], { type: 'edge', id: 'e:G1->G2' }, [['G1'], ['A'], { type: 'edge', id: 'e:G1->G2' }, false, false]],
    ['the new answer is empty', EMPTY, ['G1'], ['W'], { type: 'node', id: 'G1' }, [[], [], null, false, false]],
  ] as [string, MapOverview, string[], string[], Selection, unknown][])('forgets what a new answer no longer has when %s', (_name, next, groups, components, selection, expected) => {
    const open = { groups: new Set(groups), components: new Set(components) };
    const view = pruneView(ownership(next), open.groups, open.components, selection);
    expect([[...view.groups].sort(), [...view.components].sort(), view.selection, view.groups === open.groups, view.components === open.components]).toEqual(expected);
  });
});
