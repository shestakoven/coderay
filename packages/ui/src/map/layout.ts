import { MarkerType, type Node } from '@xyflow/react';
import type { MapEdge } from './edge-focus';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import type { VisibleEdge, VisibleGraph, VisibleNode } from './visible-graph';

export type MapNodeData = {
  label: string;
  kind: 'component' | 'file';
  summary?: string;
  stale?: boolean;
  fileCount?: number;
  parseError?: boolean;
  ghost?: boolean;
  expanded: boolean;
};

export type MapFlowNode = Node<MapNodeData, 'component' | 'file'>;

export const NODE_SIZE = {
  component: { width: 240, height: 72 },
  file: { width: 170, height: 34 },
};

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Only top-level nodes carry absolute positions; children lie inside their parents.
export function layoutBounds(nodes: MapFlowNode[]): Bounds | null {
  const top = nodes.filter((node) => !node.parentId);
  if (top.length === 0) return null;
  const left = Math.min(...top.map((node) => node.position.x));
  const upper = Math.min(...top.map((node) => node.position.y));
  const right = Math.max(...top.map((node) => node.position.x + (node.width ?? 0)));
  const lower = Math.max(...top.map((node) => node.position.y + (node.height ?? 0)));
  return { x: left, y: upper, width: right - left, height: lower - upper };
}

export function fitKey(nodes: MapFlowNode[]): string {
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => node.id)
    .sort()
    .join('\n');
}

const ROOT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.considerModelOrder.strategy': 'NONE',
};

export async function layoutGraph(
  graph: VisibleGraph,
  expanded: ReadonlySet<string>,
  elk: ELK,
): Promise<{ nodes: MapFlowNode[]; edges: MapEdge[] }> {
  const childrenOf = new Map<string, VisibleNode[]>();
  for (const node of graph.nodes) {
    if (node.parentId) childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node]);
  }
  const toElk = (node: VisibleNode): ElkNode => {
    const children = childrenOf.get(node.id);
    if (children?.length) {
      return { id: node.id, layoutOptions: { 'elk.padding': '[top=64,left=12,bottom=12,right=12]' }, children: children.map(toElk) };
    }
    return { id: node.id, ...NODE_SIZE[node.kind] };
  };

  const laidOut = await elk.layout({
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children: graph.nodes.filter((n) => !n.parentId).map(toElk),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.to], targets: [e.from] })),
  });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: MapFlowNode[] = [];
  const visit = (elkNode: ElkNode, parentId?: string) => {
    const node = byId.get(elkNode.id);
    if (!node) return;
    nodes.push({
      id: node.id,
      type: node.kind,
      position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
      width: elkNode.width,
      height: elkNode.height,
      ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      data: {
        label: node.label,
        kind: node.kind,
        summary: node.summary,
        stale: node.stale,
        fileCount: node.fileCount,
        parseError: node.parseError,
        ghost: node.ghost,
        expanded: expanded.has(node.id),
      },
    });
    for (const child of elkNode.children ?? []) visit(child, node.id);
  };
  for (const child of laidOut.children ?? []) visit(child);

  return {
    nodes,
    edges: mergeOpposite(graph.edges),
  };
}

const ARROW = { type: MarkerType.ArrowClosed, width: 12, height: 12 };

function mergeOpposite(edges: VisibleEdge[]): MapEdge[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const merged: MapEdge[] = [];
  for (const e of edges) {
    const back = byId.get(`${e.to}->${e.from}`);
    if (back && e.from > e.to) continue;
    merged.push({
      id: e.id,
      source: e.from,
      target: e.to,
      data: { weight: e.weight + (back?.weight ?? 0) },
      markerEnd: ARROW,
      ...(back ? { markerStart: ARROW } : {}),
    });
  }
  return merged;
}
