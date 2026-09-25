import type { Edge, Node } from '@xyflow/react';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import type { C4Container, C4Model, ExternalKind, MapSnapshot } from '@ide/protocol';

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
const HEADER = 64;

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
      detail: c.entryMissing.length > 0 ? `entry not found: ${c.entryMissing.join(', ')}` : `${c.files} files · ${c.components.length} components`,
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
    for (const p of own.slice(0, 14)) {
      const id = `${c.id}/${p.id}`;
      nodes.push({
        id,
        kind: 'component',
        parentId: c.id,
        column: 0,
        data: {
          kind: 'component',
          title: componentName.get(p.id) ?? (p.id === 'unassigned' ? 'Unassigned files' : p.id),
          subtitle: `${p.near} near entry · ${p.files} files${p.containers > 1 ? ` · in ${p.containers} containers` : ''}`,
          accent: ROLE_ACCENT[c.role],
          icon: 'box',
        },
      });
      byComponent.set(p.id, id);
    }
    const rest = [...own.slice(14), ...shared];
    if (rest.length > 0) {
      const id = `${c.id}/shared`;
      nodes.push({
        id,
        kind: 'shared',
        parentId: c.id,
        column: 0,
        data: {
          kind: 'shared',
          title: `Libraries · ${rest.length} components`,
          subtitle: `${rest.reduce((sum, p) => sum + p.files, 0)} files deeper than 2 imports from the entry`,
          accent: 'var(--c4-muted)',
          icon: 'stack',
        },
      });
      for (const p of rest) byComponent.set(p.id, id);
    }
    reattach.set(c.id, byComponent);
  }

  for (const e of model.externals) {
    nodes.push({
      id: e.id,
      kind: 'external',
      column: 4,
      data: { kind: 'external', title: e.name, subtitle: KIND_LABEL[e.kind], accent: 'var(--c4-external)', icon: KIND_ICON[e.kind] },
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
    if (!inner) {
      add(from, to, link.protocol, link.strength, link.id);
      continue;
    }
    add(from, to, link.protocol, link.strength, link.id, 'summary');
    for (const e of link.evidence) {
      const child = inner.get(componentOf.get(e.path) ?? '');
      if (child) add(child, to, link.protocol, 1, link.id, 'detail');
    }
  }
  return { nodes, edges: [...edges.values()] };
}

const sizeOf = (node: VisibleNode) => (node.data.slim ? SLIM : SIZE[node.kind]);

export async function layoutC4(
  graph: { nodes: VisibleNode[]; edges: VisibleEdge[] },
  elk: ELK,
): Promise<{ nodes: C4FlowNode[]; edges: Edge<C4EdgeData>[] }> {
  const children = new Map<string, VisibleNode[]>();
  for (const n of graph.nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  const inner = new Map<string, { x: number; y: number; width: number; height: number }>();
  const boxes = new Map<string, { width: number; height: number }>();
  for (const [parentId, kids] of children) {
    let y = HEADER;
    let rowHeight = 0;
    kids.forEach((kid, i) => {
      const size = sizeOf(kid);
      const col = i % COLUMNS;
      if (col === 0 && i > 0) {
        y += rowHeight + GAP;
        rowHeight = 0;
      }
      inner.set(kid.id, { x: GAP + col * (size.width + GAP), y, ...size });
      rowHeight = Math.max(rowHeight, size.height);
    });
    const width = GAP + COLUMNS * (SIZE.component.width + GAP);
    boxes.set(parentId, { width, height: y + rowHeight + GAP });
  }

  const top = graph.nodes.filter((n) => !n.parentId);
  const parentOf = new Map(graph.nodes.filter((n) => n.parentId).map((n) => [n.id, n.parentId!]));
  const topOf = (id: string) => parentOf.get(id) ?? id;
  const seen = new Set<string>();
  const elkEdges = graph.edges.flatMap((e) => {
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
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.spacing.nodeNode': '26',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: top.map((n) => ({
      id: n.id,
      ...(boxes.get(n.id) ?? sizeOf(n)),
      layoutOptions: { 'elk.partitioning.partition': String(n.column) },
    })),
    edges: elkEdges,
  });

  const position = new Map((laid.children ?? []).map((c) => [c.id, c]));
  const nodes: C4FlowNode[] = [];
  for (const n of top) {
    const p = position.get(n.id);
    const box = boxes.get(n.id) ?? sizeOf(n);
    nodes.push({ id: n.id, type: n.kind === 'group' ? 'c4group' : n.kind, position: { x: p?.x ?? 0, y: p?.y ?? 0 }, width: box.width, height: box.height, data: n.data });
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
      label: e.protocols.join(' · '),
      animated: true,
      data: { protocols: e.protocols, strength: e.strength, linkIds: e.linkIds, kind: e.kind },
      style: { strokeWidth: 1 + Math.min(4, Math.log2(1 + e.strength)) },
    })),
  };
}
