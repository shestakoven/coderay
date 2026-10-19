import type { Edge, Node } from '@xyflow/react';
import type { MapOverview, OverviewComponent, OverviewGroup, OverviewLane, OverviewPart } from '@ide/protocol';

export const LANES: OverviewLane[] = ['interface', 'core', 'integrations', 'platform', 'noise'];
export const LANE_LABEL: Record<OverviewLane, string> = {
  interface: 'Interface',
  core: 'Core',
  integrations: 'Integrations & data',
  platform: 'Platform & ops',
  noise: 'Vendored & generated',
};
const LANE_ACCENT: Record<OverviewLane, string> = {
  interface: 'var(--ov-interface)',
  core: 'var(--ov-core)',
  integrations: 'var(--ov-integrations)',
  platform: 'var(--ov-platform)',
  noise: 'var(--ov-noise)',
};

export type OvKind = 'lane' | 'group' | 'component' | 'part';

export type OvData = {
  kind: OvKind;
  title: string;
  subtitle: string;
  summary: string;
  files: number;
  share: number;
  accent: string;
  open: boolean;
  noise: boolean;
  chips: { name: string; noise: boolean }[];
  more: number;
  meta: string;
  parent?: string;
};

export type OvNode = Node<OvData, `ov${OvKind}`>;
export type Side = 'l' | 'r' | 't' | 'b';
export type OvEdgeData = { count: number; label: string; short?: boolean };
export type OvEdge = Edge<OvEdgeData>;

export interface Ownership {
  componentOfPart: Map<string, string>;
  groupOfComponent: Map<string, string>;
  groupById: Map<string, OverviewGroup>;
  componentById: Map<string, OverviewComponent>;
  partById: Map<string, OverviewPart>;
}

export function ownership(overview: MapOverview): Ownership {
  const result: Ownership = { componentOfPart: new Map(), groupOfComponent: new Map(), groupById: new Map(), componentById: new Map(), partById: new Map() };
  for (const group of overview.groups) {
    result.groupById.set(group.id, group);
    for (const component of group.components) {
      result.groupOfComponent.set(component.id, group.id);
      result.componentById.set(component.id, component);
      for (const part of component.parts) {
        result.componentOfPart.set(part.id, component.id);
        result.partById.set(part.id, part);
      }
    }
  }
  return result;
}

const COLUMN_GAP = 84;
const STRIP_GAP = 28;
const LANE_PAD = 14;
const LANE_HEAD = 44;
const GROUP_GAP = 22;
const GROUP_W = 272;
const GROUP_PAD = 12;
const GROUP_HEAD = 92;
const COMPONENT_W = GROUP_W - 2 * GROUP_PAD;
const COMPONENT_H = 68;
const COMPONENT_GAP = 8;
const COMPONENT_HEAD = 66;
const PART_W = 206;
const PART_H = 56;
const PART_GAP = 8;
const PART_COLUMNS = 2;
const CHIP_ROW = 24;
const CHIP_ROWS = 3;
const CHIP_AREA = GROUP_W - 28;

const chipWidth = (name: string): number => 18 + name.length * 6.4;

function chipRows(names: string[]): { rows: number; shown: number } {
  let rows = 1;
  let x = 0;
  for (let i = 0; i < names.length; i += 1) {
    const width = chipWidth(names[i]!) + 6;
    if (x + width > CHIP_AREA && x > 0) {
      if (rows === CHIP_ROWS) return { rows, shown: i };
      rows += 1;
      x = 0;
    }
    x += width;
  }
  return { rows, shown: names.length };
}

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

interface Box {
  width: number;
  height: number;
}

function componentBox(component: OverviewComponent, open: boolean): Box {
  if (!open) return { width: COMPONENT_W, height: COMPONENT_H };
  const rows = Math.ceil(component.parts.length / PART_COLUMNS);
  return { width: PART_COLUMNS * PART_W + (PART_COLUMNS - 1) * PART_GAP + 2 * 10, height: COMPONENT_HEAD + rows * (PART_H + PART_GAP) + 4 };
}

export interface Expansion {
  groups: ReadonlySet<string>;
  components: ReadonlySet<string>;
}

function placeGroup(group: OverviewGroup, open: Expansion, total: number): { nodes: OvNode[]; width: number; height: number } {
  const accent = LANE_ACCENT[group.lane];
  const isOpen = open.groups.has(group.id);
  const names = group.components.map((component) => component.name);
  const chips = chipRows(names);
  const base: OvData = {
    kind: 'group',
    title: group.name,
    subtitle: `${plural(group.components.length, 'component')} · ${plural(group.files, 'file')}`,
    summary: group.summary,
    files: group.files,
    share: group.files / total,
    accent,
    open: isOpen,
    noise: group.noise,
    chips: group.components.slice(0, chips.shown).map((component) => ({ name: component.name, noise: component.noise })),
    more: names.length - chips.shown,
    meta: '',
  };
  if (!isOpen) {
    const height = GROUP_HEAD + chips.rows * CHIP_ROW + 8;
    return { nodes: [{ id: group.id, type: 'ovgroup', position: { x: 0, y: 0 }, width: GROUP_W, height, data: base }], width: GROUP_W, height };
  }
  const children: OvNode[] = [];
  let innerY = GROUP_HEAD;
  let innerWidth = COMPONENT_W;
  for (const component of group.components) {
    const componentOpen = open.components.has(component.id);
    const box = componentBox(component, componentOpen);
    innerWidth = Math.max(innerWidth, box.width);
    children.push({
      id: component.id,
      type: 'ovcomponent',
      parentId: group.id,
      position: { x: GROUP_PAD, y: innerY },
      width: box.width,
      height: box.height,
      data: {
        kind: 'component',
        title: component.name,
        subtitle: component.role,
        summary: '',
        files: component.files,
        share: component.files / Math.max(1, group.files),
        accent,
        open: componentOpen,
        noise: component.noise || group.noise,
        chips: [],
        more: 0,
        meta: `${plural(component.files, 'file')}${component.langs.length > 0 ? ` · ${component.langs.slice(0, 2).join(', ')}` : ''}`,
      },
    });
    if (componentOpen) {
      component.parts.forEach((part, i) => {
        children.push({
          id: part.id,
          type: 'ovpart',
          parentId: component.id,
          position: { x: 10 + (i % PART_COLUMNS) * (PART_W + PART_GAP), y: COMPONENT_HEAD + Math.floor(i / PART_COLUMNS) * (PART_H + PART_GAP) },
          width: PART_W,
          height: PART_H,
          data: {
            kind: 'part',
            title: part.name,
            subtitle: part.summary,
            summary: '',
            files: part.files,
            share: part.files / Math.max(1, component.files),
            accent,
            open: false,
            noise: part.noise || component.noise || group.noise,
            chips: [],
            more: 0,
            meta: `${plural(part.files, 'file')} · ${part.dirs.map(shortDir).join(', ')}`,
          },
        });
      });
    }
    innerY += box.height + COMPONENT_GAP;
  }
  const width = innerWidth + 2 * GROUP_PAD;
  const height = innerY + GROUP_PAD - COMPONENT_GAP + 2;
  return { nodes: [{ id: group.id, type: 'ovgroup', position: { x: 0, y: 0 }, width, height, data: base }, ...children], width, height };
}

function laneNode(lane: OverviewLane, groups: OverviewGroup[], total: number, box: { x: number; y: number; width: number; height: number }): OvNode {
  const files = groups.reduce((sum, group) => sum + group.files, 0);
  return {
    id: `lane:${lane}`,
    type: 'ovlane',
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    selectable: false,
    draggable: false,
    zIndex: -1,
    data: { kind: 'lane', title: LANE_LABEL[lane], subtitle: `${Math.round((files / total) * 100)}% of files`, summary: '', files, share: files / total, accent: LANE_ACCENT[lane], open: false, noise: lane === 'noise', chips: [], more: 0, meta: '' },
  };
}

// Lanes are columns from users to infrastructure; vendored and generated code is a strip underneath.
export function overviewGraph(overview: MapOverview, open: Expansion): { nodes: OvNode[]; edges: OvEdge[] } {
  const total = overview.groups.reduce((sum, group) => sum + group.files, 0) || 1;
  const lanes = LANES.filter((lane) => lane !== 'noise' && overview.groups.some((group) => group.lane === lane));
  const nodes: OvNode[] = [];
  const laneNodes: OvNode[] = [];
  const at = (placed: OvNode[], x: number, y: number) => {
    for (const node of placed) {
      if (!node.parentId) node.position = { x, y };
      nodes.push(node);
    }
  };
  let x = 0;
  let bottom = 0;
  const columns = lanes.map((lane) => {
    const groups = overview.groups.filter((group) => group.lane === lane);
    let y = LANE_HEAD;
    let width = GROUP_W;
    for (const group of groups) {
      const placed = placeGroup(group, open, total);
      at(placed.nodes, x + LANE_PAD, y);
      width = Math.max(width, placed.width);
      y += placed.height + GROUP_GAP;
    }
    bottom = Math.max(bottom, y - GROUP_GAP + LANE_PAD);
    const column = { lane, groups, x, width: width + 2 * LANE_PAD };
    x += column.width + COLUMN_GAP;
    return column;
  });
  for (const column of columns) laneNodes.push(laneNode(column.lane, column.groups, total, { x: column.x, y: 0, width: column.width, height: bottom }));
  const noise = overview.groups.filter((group) => group.lane === 'noise');
  if (noise.length > 0) {
    const top = bottom + STRIP_GAP;
    let stripX = LANE_PAD;
    let stripHeight = 0;
    for (const group of noise) {
      const placed = placeGroup(group, open, total);
      at(placed.nodes, stripX, top + LANE_HEAD);
      stripX += placed.width + GROUP_GAP;
      stripHeight = Math.max(stripHeight, placed.height);
    }
    const width = Math.max(stripX - GROUP_GAP + LANE_PAD, x - COLUMN_GAP);
    laneNodes.push(laneNode('noise', noise, total, { x: 0, y: top, width, height: LANE_HEAD + stripHeight + LANE_PAD }));
  }
  return { nodes: [...laneNodes, ...flatten(nodes)], edges: overviewEdges(overview, open, nodes) };
}

// React Flow lifts edges of nested nodes above every top-level card, so the graph is drawn flat:
// open frames lie under the links, cards over them.
export const EDGE_Z = 2;
function flatten(nodes: OvNode[]): OvNode[] {
  const boxes = absoluteBoxes(nodes);
  return nodes.map((node) => {
    const box = boxes.get(node.id)!;
    const { parentId, ...rest } = node;
    return { ...rest, position: { x: box.x, y: box.y }, zIndex: node.data.open ? (node.type === 'ovgroup' ? 0 : 1) : 3, data: { ...node.data, parent: parentId } };
  });
}

// "web/src/components/cart/" → "components/cart"
export function shortDir(label: string): string {
  const parts = label.replace(/\/$/, '').split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/');
}

function absoluteBoxes(nodes: OvNode[]): Map<string, { x: number; y: number; width: number; height: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const node of nodes) {
    let x = node.position.x;
    let y = node.position.y;
    for (let parent = node.parentId ? byId.get(node.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
      x += parent.position.x;
      y += parent.position.y;
    }
    result.set(node.id, { x, y, width: node.width ?? 0, height: node.height ?? 0 });
  }
  return result;
}

// Sides that keep a link short: across columns left/right, inside one column top/bottom.
export function sides(from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }): [Side, Side] {
  const overlap = Math.min(from.x + from.width, to.x + to.width) - Math.max(from.x, to.x);
  if (overlap > 0) return to.y > from.y ? ['b', 't'] : ['t', 'b'];
  return to.x > from.x ? ['r', 'l'] : ['l', 'r'];
}

function overviewEdges(overview: MapOverview, open: Expansion, nodes: OvNode[]): OvEdge[] {
  const own = ownership(overview);
  const shown = (partId: string): string | undefined => {
    const componentId = own.componentOfPart.get(partId);
    if (!componentId) return undefined;
    if (open.components.has(componentId) && open.groups.has(own.groupOfComponent.get(componentId) ?? '')) return partId;
    const groupId = own.groupOfComponent.get(componentId)!;
    return open.groups.has(groupId) ? componentId : groupId;
  };
  const said = new Map(overview.labels.map((label) => [`${label.from}->${label.to}`, label.label]));
  const counts = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  for (const link of overview.links) {
    const from = shown(link.from);
    const to = shown(link.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    counts.set(key, (counts.get(key) ?? 0) + link.count);
    const pair = `${own.componentOfPart.get(link.from)}->${own.componentOfPart.get(link.to)}`;
    if (!said.has(pair)) continue;
    const byPair = pairs.get(key) ?? new Map<string, number>();
    byPair.set(pair, (byPair.get(pair) ?? 0) + link.count);
    pairs.set(key, byPair);
  }
  // A link between groups borrows the model's words for the strongest component link inside it.
  const labels = new Map([...pairs].map(([key, byPair]) => [key, said.get([...byPair].sort((a, b) => b[1] - a[1])[0]![0])!]));
  const boxes = absoluteBoxes(nodes);
  return [...counts].flatMap(([key, count]) => {
    const [source, target] = key.split('->') as [string, string];
    const a = boxes.get(source);
    const b = boxes.get(target);
    if (!a || !b) return [];
    const [out, into] = sides(a, b);
    const gap = out === 'b' ? b.y - (a.y + a.height) : out === 't' ? a.y - (b.y + b.height) : Infinity;
    return [
      {
        id: `e:${key}`,
        source,
        target,
        sourceHandle: `s-${out}`,
        targetHandle: `t-${into}`,
        data: { count, label: labels.get(key) ?? '', short: gap < 40 },
        zIndex: EDGE_Z,
        style: { strokeWidth: 1 + Math.min(4.5, Math.log2(1 + count) / 1.6) },
      },
    ];
  });
}

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

function descendants(nodes: OvNode[], id: string): Set<string> {
  const result = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (node.data.parent && result.has(node.data.parent) && !result.has(node.id)) {
        result.add(node.id);
        grew = true;
      }
    }
  }
  return result;
}

export function focusOf(selection: Selection, nodes: OvNode[], edges: OvEdge[]) {
  if (!selection || (selection.type === 'node' && !nodes.some((n) => n.id === selection.id))) return null;
  const parentOf = new Map(nodes.filter((n) => n.data.parent).map((n) => [n.id, n.data.parent!]));
  const focusNodes = new Set<string>();
  const focusEdges = new Set<string>();
  const extra: OvEdge[] = [];
  if (selection.type === 'edge') {
    const edge = edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    focusEdges.add(edge.id);
    focusNodes.add(edge.source).add(edge.target);
  } else {
    const own = descendants(nodes, selection.id);
    for (const id of own) focusNodes.add(id);
    // An open frame shows its outside links whole, one per neighbour, and its inside links as they are.
    const whole = new Map<string, { source: string; target: string; count: number }>();
    for (const e of edges) {
      const from = own.has(e.source);
      const to = own.has(e.target);
      if (!from && !to) continue;
      focusNodes.add(e.source).add(e.target);
      if ((from && to) || own.size === 1) {
        focusEdges.add(e.id);
        continue;
      }
      const source = from ? selection.id : e.source;
      const target = to ? selection.id : e.target;
      const key = `${source}->${target}`;
      const seen = whole.get(key);
      whole.set(key, { source, target, count: (seen?.count ?? 0) + (e.data?.count ?? 0) });
    }
    const boxOf = new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }]));
    for (const [key, link] of whole) {
      const a = boxOf.get(link.source)!;
      const b = boxOf.get(link.target)!;
      const [out, into] = sides(a, b);
      const gap = out === 'b' ? b.y - (a.y + a.height) : out === 't' ? a.y - (b.y + b.height) : Infinity;
      extra.push({ id: `w:${key}`, source: link.source, target: link.target, sourceHandle: `s-${out}`, targetHandle: `t-${into}`, zIndex: EDGE_Z, data: { count: link.count, label: '', short: gap < 40 }, style: { strokeWidth: 1 + Math.min(4.5, Math.log2(1 + link.count) / 1.6) } });
      focusEdges.add(`w:${key}`);
    }
  }
  const context = new Set<string>();
  for (const id of focusNodes) for (let p = parentOf.get(id); p; p = parentOf.get(p)) context.add(p);
  return { nodes: focusNodes, context, edges: focusEdges, extra };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Where to center the camera after a node opens, or null to stay put: it moves only when the node no longer fits, and never zooms.
export function revealCenter(node: Rect, viewport: { x: number; y: number; zoom: number }, pane: { width: number; height: number }, margin = 24): { x: number; y: number } | null {
  const { zoom } = viewport;
  const left = node.x * zoom + viewport.x;
  const top = node.y * zoom + viewport.y;
  if (left >= margin && top >= margin && left + node.width * zoom <= pane.width - margin && top + node.height * zoom <= pane.height - margin) return null;
  const visibleHeight = pane.height / zoom;
  return { x: node.x + node.width / 2, y: node.height > visibleHeight - 60 ? node.y + visibleHeight / 2 - 30 : node.y + node.height / 2 };
}

export const allGroupsOpen = (overview: MapOverview, open: ReadonlySet<string>): boolean => overview.groups.every((group) => group.noise || open.has(group.id));

// Expand all opens every group but the vendored ones; once they are all open it closes everything.
export function toggleAllGroups(overview: MapOverview, open: ReadonlySet<string>): Set<string> {
  return allGroupsOpen(overview, open) ? new Set() : new Set(overview.groups.filter((group) => !group.noise).map((group) => group.id));
}

// Drops the open groups and components and the selected node that a new answer no longer has; unchanged values keep their identity.
export function pruneView(own: Ownership, groups: Set<string>, components: Set<string>, selection: Selection): { groups: Set<string>; components: Set<string>; selection: Selection } {
  const keep = (open: Set<string>, has: (id: string) => boolean) => ([...open].every(has) ? open : new Set([...open].filter(has)));
  const known = (id: string) => own.groupById.has(id) || own.componentById.has(id) || own.partById.has(id);
  return {
    groups: keep(groups, (id) => own.groupById.has(id)),
    components: keep(components, (id) => own.componentById.has(id)),
    selection: selection?.type === 'node' && !known(selection.id) ? null : selection,
  };
}
