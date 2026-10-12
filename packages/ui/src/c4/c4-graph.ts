import type { Edge, Node } from '@xyflow/react';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import type { C4Container, C4Model, ExternalKind, MapSnapshot } from '@ide/protocol';
import type { Direction } from '../map/layout-settings';
import { c4Spacing, DEFAULT_C4_LAYOUT, type C4Layout } from './c4-layout';

export const OWN_COMPONENT_CARDS = 14;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export type C4Kind = 'person' | 'container' | 'group' | 'external' | 'component' | 'shared';

export type C4NodeData = {
  kind: C4Kind;
  title: string;
  subtitle: string;
  detail?: string;
  accent: string;
  icon: string;
  expanded?: boolean;
  warn?: boolean;
  slim?: boolean;
  external?: boolean;
  dim?: boolean;
  root?: boolean;
  direction?: Direction;
};

export type C4FlowNode = Node<C4NodeData, Exclude<C4Kind, 'group'> | 'c4group'>;

// plain: between top-level nodes; summary/detail: an opened container's outside link, whole or per child.
export type EdgeKind = 'plain' | 'summary' | 'detail';

export type C4EdgeData = { protocols: string[]; strength: number; linkIds: string[]; kind: EdgeKind };

interface VisibleNode {
  id: string;
  kind: C4Kind;
  parentId?: string;
  column: number;
  data: C4NodeData;
}

interface VisibleEdge {
  id: string;
  from: string;
  to: string;
  protocols: string[];
  strength: number;
  linkIds: string[];
  kind: EdgeKind;
}

const SIZE: Record<C4Kind, { width: number; height: number }> = {
  person: { width: 150, height: 58 },
  container: { width: 230, height: 82 },
  group: { width: 230, height: 90 },
  external: { width: 200, height: 58 },
  component: { width: 210, height: 52 },
  shared: { width: 210, height: 52 },
};
const SLIM = { width: 210, height: 64 };
const COLUMNS = 2;
const GAP = 12;
const HEADER = 80;

const ROLE_COLUMN = { ui: 1, api: 2, worker: 3, service: 3 } as const;
const ROLE_ACCENT = { ui: 'var(--c4-ui)', api: 'var(--c4-api)', worker: 'var(--c4-worker)', service: 'var(--c4-api)' } as const;
const ROLE_ICON = { ui: 'web', api: 'api', worker: 'worker', service: 'api' } as const;
const KIND_ICON: Record<ExternalKind, string> = {
  database: 'db',
  broker: 'queue',
  storage: 'bucket',
  ai: 'ai',
  search: 'globe',
  documents: 'doc',
  email: 'mail',
  cache: 'db',
  ml: 'ai',
  source: 'plug',
  other: 'box',
};
const KIND_LABEL: Record<ExternalKind, string> = {
  database: 'Database',
  broker: 'Message broker',
  storage: 'Object storage',
  ai: 'AI API',
  search: 'Web search',
  documents: 'Documents',
  email: 'Email',
  cache: 'Cache',
  ml: 'ML tracking',
  source: 'Connector',
  other: 'External',
};

const groupName = (members: C4Container[]) => `${members[0]?.role === 'worker' ? 'Workers' : 'Services'} ×${members.length}`;

export function c4Graph(snapshot: MapSnapshot, model: C4Model, expanded: string | null): { nodes: VisibleNode[]; edges: VisibleEdge[] } {
  const componentName = new Map(snapshot.components.map((c) => [c.id, c.name]));
  const componentOf = new Map(snapshot.files.map((f) => [f.path, f.componentId ?? 'unassigned']));
  const groups = new Map<string, C4Container[]>();
  for (const c of model.containers) if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);

  const nodes: VisibleNode[] = [];
  const visibleOf = new Map<string, string>();
  const reattach = new Map<string, Map<string, string>>();

  if (model.links.some((l) => l.from === 'users')) {
    nodes.push({ id: 'users', kind: 'person', column: 0, data: { kind: 'person', title: 'Users', subtitle: 'Person', accent: 'var(--c4-person)', icon: 'person' } });
    visibleOf.set('users', 'users');
  }

  const containerNode = (c: C4Container, parentId?: string): VisibleNode => ({
    id: c.id,
    kind: 'container',
    parentId,
    column: ROLE_COLUMN[c.role],
    data: {
      kind: 'container',
      title: c.name,
      subtitle: `${c.role} · ${c.tech}`,
      detail: c.entryMissing.length > 0 ? `entry not found: ${c.entryMissing.join(', ')}` : `${plural(c.files, 'file')} · ${plural(c.components.length, 'component')}`,
      accent: ROLE_ACCENT[c.role],
      icon: ROLE_ICON[c.role],
      warn: c.entryMissing.length > 0,
      slim: Boolean(parentId),
      expanded: expanded === c.id,
    },
  });

  for (const [groupId, members] of groups) {
    const open = expanded === groupId;
    nodes.push({
      id: groupId,
      kind: 'group',
      column: ROLE_COLUMN[members[0]!.role],
      data: {
        kind: 'group',
        title: groupName(members.filter((m) => m.id !== expanded)),
        subtitle: `${members[0]!.role} · ${members[0]!.tech} · same build`,
        detail: open ? undefined : members.filter((m) => m.id !== expanded).map((m) => m.name.replace(/-worker$/, '')).join(', '),
        accent: 'var(--c4-group)',
        icon: ROLE_ICON[members[0]!.role],
        expanded: open,
        warn: members.some((m) => m.entryMissing.length > 0),
      },
    });
    for (const m of members) {
      if (open) {
        nodes.push(containerNode(m, groupId));
        visibleOf.set(m.id, m.id);
      } else {
        visibleOf.set(m.id, groupId);
      }
    }
  }

  // A group member that is opened leaves its group and opens beside it.
  for (const c of model.containers.filter((c) => !c.group || c.id === expanded)) {
    nodes.push(containerNode(c));
    visibleOf.set(c.id, c.id);
    if (expanded !== c.id) continue;
    const own = c.components.filter((p) => p.near > 0);
    const shared = c.components.filter((p) => !own.includes(p));
    const byComponent = new Map<string, string>();
    for (const p of own.slice(0, OWN_COMPONENT_CARDS)) {
      const id = `${c.id}/${p.id}`;
      nodes.push({
        id,
        kind: 'component',
        parentId: c.id,
        column: 0,
        data: {
          kind: 'component',
          title: componentName.get(p.id) ?? (p.id === 'unassigned' ? 'Unassigned files' : p.id),
          subtitle: `${p.near} near entry · ${plural(p.files, 'file')}${p.containers > 1 ? ` · in ${p.containers} containers` : ''}`,
          accent: ROLE_ACCENT[c.role],
          icon: 'box',
        },
      });
      byComponent.set(p.id, id);
    }
    const rest = [...own.slice(OWN_COMPONENT_CARDS), ...shared];
    if (rest.length > 0) {
      const id = `${c.id}/shared`;
      nodes.push({
        id,
        kind: 'shared',
        parentId: c.id,
        column: 0,
        data: {
          kind: 'shared',
          title: `Libraries · ${plural(rest.length, 'component')}`,
          subtitle: `${plural(rest.reduce((sum, p) => sum + p.files, 0), 'file')} deeper than 2 imports from the entry`,
          accent: 'var(--c4-muted)',
          icon: 'stack',
        },
      });
      for (const p of rest) byComponent.set(p.id, id);
    }
    reattach.set(c.id, byComponent);
  }

  const sources = model.externals.filter((e) => e.kind === 'source');
  const sourceGroup = sources.length >= 3 ? 'extgroup:source' : null;
  if (sourceGroup) {
    const open = expanded === sourceGroup;
    nodes.push({
      id: sourceGroup,
      kind: 'group',
      column: 4,
      data: {
        kind: 'group',
        title: `Connectors ×${sources.length}`,
        subtitle: 'External data sources',
        detail: open ? undefined : sources.map((e) => e.name).join(', '),
        accent: 'var(--c4-external)',
        icon: 'plug',
        expanded: open,
        external: true,
      },
    });
  }
  for (const e of model.externals) {
    const grouped = sourceGroup && e.kind === 'source';
    if (grouped && expanded !== sourceGroup) {
      visibleOf.set(e.id, sourceGroup);
      continue;
    }
    nodes.push({
      id: e.id,
      kind: 'external',
      parentId: grouped ? sourceGroup : undefined,
      column: 4,
      data: { kind: 'external', title: e.name, subtitle: KIND_LABEL[e.kind], accent: 'var(--c4-external)', icon: KIND_ICON[e.kind], slim: Boolean(grouped) },
    });
    visibleOf.set(e.id, e.id);
  }

  const edges = new Map<string, VisibleEdge>();
  const add = (from: string, to: string, protocol: string, strength: number, linkId: string, kind: EdgeKind = 'plain') => {
    if (from === to) return;
    const id = `${from}->${to}`;
    const edge = edges.get(id) ?? { id, from, to, protocols: [], strength: 0, linkIds: [], kind };
    if (!edge.protocols.includes(protocol)) edge.protocols.push(protocol);
    edge.strength += strength;
    if (!edge.linkIds.includes(linkId)) edge.linkIds.push(linkId);
    edges.set(id, edge);
  };
  for (const link of model.links) {
    const from = visibleOf.get(link.from);
    const to = visibleOf.get(link.to);
    if (!from || !to) continue;
    const inner = reattach.get(link.from);
    const openGroup = sourceGroup && expanded === sourceGroup && sources.some((e) => e.id === link.to) ? sourceGroup : null;
    if (!inner && !openGroup) {
      add(from, to, link.protocol, link.strength, link.id);
      continue;
    }
    add(from, openGroup ?? to, link.protocol, link.strength, link.id, 'summary');
    if (openGroup) add(from, to, link.protocol, link.strength, link.id, 'detail');
    for (const e of inner ? link.evidence : []) {
      const child = inner!.get(componentOf.get(e.path) ?? '');
      if (child) add(child, to, link.protocol, 1, link.id, 'detail');
    }
  }
  return { nodes, edges: [...edges.values()] };
}

const ROOT_COMPONENT = { width: 250, height: 74 };
const EXTRA_LINE = 15;
const sizeOf = (node: VisibleNode, extraLines: ReadonlyMap<string, number> = new Map()) => {
  const base = node.data.slim ? SLIM : node.kind === 'component' && node.data.detail ? ROOT_COMPONENT : SIZE[node.kind];
  const lines = extraLines.get(node.id) ?? 0;
  return lines > 0 ? { ...base, height: base.height + EXTRA_LINE * lines } : base;
};

export async function layoutC4(
  graph: { nodes: VisibleNode[]; edges: VisibleEdge[] },
  elk: ELK,
  layout: C4Layout = DEFAULT_C4_LAYOUT,
  taller: ReadonlyMap<string, number> = new Map(),
): Promise<{ nodes: C4FlowNode[]; edges: Edge<C4EdgeData>[] }> {
  const children = new Map<string, VisibleNode[]>();
  for (const n of graph.nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  const inner = new Map<string, { x: number; y: number; width: number; height: number }>();
  const boxes = new Map<string, { width: number; height: number }>();
  for (const [parentId, kids] of children) {
    const rows: VisibleNode[][] = [];
    kids.forEach((kid, i) => (i % COLUMNS === 0 ? rows.push([kid]) : rows[rows.length - 1]!.push(kid)));
    let y = HEADER;
    for (const row of rows) {
      const rowHeight = Math.max(...row.map((kid) => sizeOf(kid, taller).height));
      row.forEach((kid, col) => {
        const { width } = sizeOf(kid);
        inner.set(kid.id, { x: GAP + col * (width + GAP), y, width, height: rowHeight });
      });
      y += rowHeight + GAP;
    }
    boxes.set(parentId, { width: GAP + COLUMNS * (SIZE.component.width + GAP), height: y });
  }

  const top = graph.nodes.filter((n) => !n.parentId);
  const parentOf = new Map(graph.nodes.filter((n) => n.parentId).map((n) => [n.id, n.parentId!]));
  const topOf = (id: string) => parentOf.get(id) ?? id;
  const seen = new Set<string>();
  const elkEdges = graph.edges.filter((e) => e.kind !== 'detail').flatMap((e) => {
    const from = topOf(e.from);
    const to = topOf(e.to);
    const key = `${from}->${to}`;
    if (from === to || seen.has(key)) return [];
    seen.add(key);
    return [{ id: key, sources: [from], targets: [to] }];
  });

  const laid: ElkNode = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': layout.direction,
      'elk.partitioning.activate': 'true',
      'elk.spacing.nodeNode': String(c4Spacing(layout.density).node),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(c4Spacing(layout.density).layer),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: top.map((n) => ({
      id: n.id,
      ...(boxes.get(n.id) ?? sizeOf(n, taller)),
      layoutOptions: { 'elk.partitioning.partition': String(n.column) },
    })),
    edges: elkEdges,
  });

  const position = new Map((laid.children ?? []).map((c) => [c.id, c]));
  const nodes: C4FlowNode[] = [];
  for (const n of top) {
    const p = position.get(n.id);
    const box = boxes.get(n.id) ?? sizeOf(n, taller);
    nodes.push({ id: n.id, type: n.kind === 'group' ? 'c4group' : n.kind, position: { x: p?.x ?? 0, y: p?.y ?? 0 }, width: box.width, height: box.height, data: { ...n.data, direction: layout.direction } });
    for (const kid of children.get(n.id) ?? []) {
      const r = inner.get(kid.id)!;
      nodes.push({ id: kid.id, type: kid.kind === 'group' ? 'c4group' : kid.kind, parentId: n.id, extent: 'parent', position: { x: r.x, y: r.y }, width: r.width, height: r.height, data: kid.data });
    }
  }
  return {
    nodes,
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: layout.edgeStyle,
      label: e.protocols.join(' · '),
      className: e.protocols.includes('imports') || e.protocols.includes('starts') ? 'c4-import' : '',
      animated: true,
      data: { protocols: e.protocols, strength: e.strength, linkIds: e.linkIds, kind: e.kind },
      style: { strokeWidth: 1 + Math.min(4, Math.log2(1 + e.strength)) },
    })),
  };
}

// A container opened as root: who calls it, the container, its components with their imports, and what it uses.
export function c4RootGraph(snapshot: MapSnapshot, model: C4Model, rootId: string, expanded: string | null): { nodes: VisibleNode[]; edges: VisibleEdge[] } {
  const root = model.containers.find((c) => c.id === rootId);
  if (!root) return { nodes: [], edges: [] };
  const component = new Map(snapshot.components.map((c) => [c.id, c]));
  const componentOf = new Map(snapshot.files.map((f) => [f.path, f.componentId ?? 'unassigned']));
  // A start script is an entry file of no component: it is not indexed.
  const entryComponents = new Set(root.entryFiles.flatMap((p) => componentOf.get(p) ?? []));
  const nodes: VisibleNode[] = [];
  const edges = new Map<string, VisibleEdge>();
  const add = (from: string, to: string, protocol: string, strength: number, linkId: string, kind: EdgeKind = 'plain') => {
    if (from === to) return;
    const id = `${from}->${to}`;
    const edge = edges.get(id) ?? { id, from, to, protocols: [], strength: 0, linkIds: [], kind };
    if (!edge.protocols.includes(protocol)) edge.protocols.push(protocol);
    edge.strength += strength;
    if (!edge.linkIds.includes(linkId)) edge.linkIds.push(linkId);
    edges.set(id, edge);
  };
  const sources = model.externals.filter((e) => e.kind === 'source');
  const sourceIds = new Set(sources.map((e) => e.id));
  const groupSources = sources.length >= 3;
  const sourceGroup = 'extgroup:source';
  const openGroup = groupSources && expanded === sourceGroup;
  const visible = (id: string) => (groupSources && !openGroup && sourceIds.has(id) ? sourceGroup : id);
  const nodeFor = (id: string, column: number) => {
    if (nodes.some((n) => n.id === id)) return;
    if (groupSources && sourceIds.has(id)) {
      if (!nodes.some((n) => n.id === sourceGroup)) {
        nodes.push({
          id: sourceGroup,
          kind: 'group',
          column,
          data: {
            kind: 'group',
            title: `Connectors ×${sources.filter((e) => model.links.some((l) => l.from === root.id && l.to === e.id)).length}`,
            subtitle: 'External data sources',
            accent: 'var(--c4-external)',
            icon: 'plug',
            expanded: openGroup,
            external: true,
          },
        });
      }
      if (!openGroup) return;
      const e = sources.find((x) => x.id === id)!;
      nodes.push({ id, kind: 'external', parentId: sourceGroup, column, data: { kind: 'external', title: e.name, subtitle: KIND_LABEL[e.kind], accent: 'var(--c4-external)', icon: KIND_ICON[e.kind], slim: true } });
      return;
    }
    if (id === 'users') {
      nodes.push({ id, kind: 'person', column, data: { kind: 'person', title: 'Users', subtitle: 'Person', accent: 'var(--c4-person)', icon: 'person' } });
      return;
    }
    const c = model.containers.find((x) => x.id === id);
    if (c) {
      nodes.push({
        id,
        kind: 'container',
        column,
        data: { kind: 'container', title: c.name, subtitle: `${c.role} · ${c.tech}`, detail: 'context', accent: ROLE_ACCENT[c.role], icon: ROLE_ICON[c.role], dim: true },
      });
      return;
    }
    const e = model.externals.find((x) => x.id === id);
    if (e) nodes.push({ id, kind: 'external', column, data: { kind: 'external', title: e.name, subtitle: KIND_LABEL[e.kind], accent: 'var(--c4-external)', icon: KIND_ICON[e.kind] } });
  };

  nodes.push({
    id: root.id,
    kind: 'container',
    column: 1,
    data: {
      kind: 'container',
      title: root.name,
      subtitle: `${root.role} · ${root.tech}`,
      detail: root.launch.find((l) => /uvicorn|python|node|npm|pnpm|nginx|celery/.test(l)) ?? root.launch[0],
      accent: ROLE_ACCENT[root.role],
      icon: ROLE_ICON[root.role],
      root: true,
    },
  });
  for (const p of root.components) {
    const id = `root:${p.id}`;
    const entry = entryComponents.has(p.id);
    nodes.push({
      id,
      kind: 'component',
      column: 2,
      data: {
        kind: 'component',
        title: component.get(p.id)?.name ?? (p.id === 'unassigned' ? 'Unassigned files' : p.id),
        subtitle: `${p.near} near entry · ${plural(p.files, 'file')}`,
        detail: component.get(p.id)?.summary,
        accent: entry ? 'var(--c4-person)' : p.near > 0 ? ROLE_ACCENT[root.role] : 'var(--c4-muted)',
        icon: entry ? 'play' : 'box',
        dim: p.near === 0,
      },
    });
    if (entry) add(root.id, id, 'starts', 1, `entry:${p.id}`);
  }
  // The backbone drawn by default links each component to the one that imports it most; the others show on selection.
  const parent = new Map<string, { from: string; count: number }>();
  for (const l of root.componentLinks) {
    if (entryComponents.has(l.to)) continue;
    if ((parent.get(l.to)?.count ?? 0) < l.count) parent.set(l.to, { from: l.from, count: l.count });
  }
  for (const l of root.componentLinks) {
    const backbone = parent.get(l.to)?.from === l.from;
    add(`root:${l.from}`, `root:${l.to}`, 'imports', l.count, `imports:${l.from}->${l.to}`, backbone ? 'plain' : 'detail');
  }

  const incoming = model.links.filter((l) => l.to === root.id);
  for (const link of incoming) {
    nodeFor(link.from, 0);
    add(link.from, root.id, link.protocol, link.strength, link.id);
  }
  for (const link of model.links.filter((l) => l.from === root.id)) {
    nodeFor(link.to, 4);
    const target = visible(link.to);
    add(root.id, openGroup && sourceIds.has(link.to) ? sourceGroup : target, link.protocol, link.strength, link.id, 'summary');
    if (openGroup && sourceIds.has(link.to)) add(root.id, target, link.protocol, link.strength, link.id, 'detail');
    for (const e of link.evidence) {
      const owner = componentOf.get(e.path);
      if (owner && root.components.some((p) => p.id === owner)) add(`root:${owner}`, target, link.protocol, 1, link.id, 'detail');
    }
  }
  return { nodes, edges: [...edges.values()] };
}
