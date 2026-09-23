import type { MapSnapshot } from '@ide/protocol';

export interface VisibleNode {
  id: string;
  kind: 'component' | 'file';
  label: string;
  parentId?: string;
  fileCount?: number;
  parseError?: boolean;
}

export interface VisibleEdge {
  id: string;
  from: string;
  to: string;
  weight: number;
}

export interface VisibleGraph {
  nodes: VisibleNode[];
  edges: VisibleEdge[];
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function visibleGraph(snapshot: MapSnapshot, expanded: ReadonlySet<string>): VisibleGraph {
  const parseErrors = new Map(snapshot.files.map((f) => [f.path, f.parseError]));
  const nodes: VisibleNode[] = [];
  const visibleOf = new Map<string, string>();

  for (const component of snapshot.components) {
    nodes.push({ id: component.id, kind: 'component', label: component.name, fileCount: component.files.length });
    const open = expanded.has(component.id);
    for (const path of component.files) {
      if (open) {
        nodes.push({ id: path, kind: 'file', label: fileName(path), parentId: component.id, parseError: parseErrors.get(path) ?? false });
      }
      visibleOf.set(path, open ? path : component.id);
    }
  }
  for (const file of snapshot.files.filter((f) => f.componentId === null)) {
    nodes.push({ id: file.path, kind: 'file', label: fileName(file.path), parseError: file.parseError });
    visibleOf.set(file.path, file.path);
  }

  const weights = new Map<string, VisibleEdge>();
  for (const edge of snapshot.fileEdges) {
    const from = visibleOf.get(edge.from);
    const to = visibleOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const id = `${from}->${to}`;
    const existing = weights.get(id);
    weights.set(id, { id, from, to, weight: (existing?.weight ?? 0) + 1 });
  }
  return { nodes, edges: [...weights.values()] };
}
