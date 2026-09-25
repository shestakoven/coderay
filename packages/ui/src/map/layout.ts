import type { Edge, Node } from '@xyflow/react';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api.js';
import type { VisibleGraph, VisibleNode } from './visible-graph';

export type MapNodeData = {
  label: string;
  kind: 'component' | 'file';
  summary?: string;
  stale?: boolean;
  fileCount?: number;
  parseError?: boolean;
  expanded: boolean;
};

export type MapFlowNode = Node<MapNodeData, 'component' | 'file'>;

export const NODE_SIZE = {
  component: { width: 240, height: 72 },
  file: { width: 170, height: 34 },
};

const ROOT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
};

export async function layoutGraph(
  graph: VisibleGraph,
  expanded: ReadonlySet<string>,
  elk: ELK,
): Promise<{ nodes: MapFlowNode[]; edges: Edge[] }> {
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
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
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
        expanded: expanded.has(node.id),
      },
    });
    for (const child of elkNode.children ?? []) visit(child, node.id);
  };
  for (const child of laidOut.children ?? []) visit(child);

  return {
    nodes,
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.weight > 1 ? String(e.weight) : undefined,
    })),
  };
}
