import type { Edge } from '@xyflow/react';

export interface EdgeData extends Record<string, unknown> {
  weight: number;
}

export type MapEdge = Edge<EdgeData>;

export const QUIET_EDGE_LIMIT = 12;
export const QUIET_MIN_WEIGHT = 5;

export interface FocusedEdges {
  edges: MapEdge[];
  neighbors: ReadonlySet<string> | null;
}

const weightOf = (edge: MapEdge): number => edge.data?.weight ?? 1;

export function focusEdges(edges: MapEdge[], focus: string | null): FocusedEdges {
  if (focus === null) {
    const crowded = edges.length > QUIET_EDGE_LIMIT;
    return {
      edges: edges.map((edge) => ({
        ...edge,
        label: undefined,
        className: 'edge-quiet',
        hidden: crowded && weightOf(edge) < QUIET_MIN_WEIGHT,
        style: { strokeWidth: strokeFor(weightOf(edge)) },
      })),
      neighbors: null,
    };
  }
  const neighbors = new Set<string>([focus]);
  const styled = edges.map((edge) => {
    const related = edge.source === focus || edge.target === focus;
    if (related) {
      neighbors.add(edge.source);
      neighbors.add(edge.target);
    }
    return {
      ...edge,
      label: related && weightOf(edge) > 1 ? String(weightOf(edge)) : undefined,
      className: related ? 'edge-focus' : 'edge-faint',
      hidden: false,
      style: { strokeWidth: related ? Math.max(2, strokeFor(weightOf(edge))) : 1 },
    };
  });
  return { edges: styled, neighbors };
}

export const strokeFor = (weight: number): number => Math.min(4, 1 + Math.log2(Math.max(1, weight)) * 0.6);
