import type { Edge } from '@xyflow/react';
import type { C4EdgeData, C4FlowNode } from './c4-graph';

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string; ids: string[] } | null;

// A selected node shows its own links and those of its children; a selected edge shows itself.
export function focusOf(
  selection: Selection,
  nodes: C4FlowNode[],
  edges: Edge<C4EdgeData>[],
): { nodes: Set<string>; context: Set<string>; edges: Set<string> } | null {
  if (!selection) return null;
  const parentOf = new Map(nodes.filter((n) => n.parentId).map((n) => [n.id, n.parentId!]));
  const focusNodes = new Set<string>();
  const focusEdges = new Set<string>();
  if (selection.type === 'edge') {
    const edge = edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    focusEdges.add(edge.id);
    focusNodes.add(edge.source).add(edge.target);
  } else {
    const kids = nodes.filter((n) => n.parentId === selection.id).map((n) => n.id);
    const own = new Set([selection.id, ...kids]);
    for (const id of own) focusNodes.add(id);
    for (const e of edges) {
      const kind = e.data?.kind;
      // An opened container shows its links whole; a child shows its own.
      if (kids.length > 0 && kind === 'detail') continue;
      if (own.has(e.source) || own.has(e.target)) {
        focusEdges.add(e.id);
        focusNodes.add(e.source).add(e.target);
      }
    }
  }
  const context = new Set<string>();
  for (const id of focusNodes) for (let p = parentOf.get(id); p; p = parentOf.get(p)) context.add(p);
  return { nodes: focusNodes, context, edges: focusEdges };
}
