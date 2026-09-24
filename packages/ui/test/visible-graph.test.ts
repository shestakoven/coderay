import { describe, expect, it } from 'vitest';
import { graphSignature, visibleGraph } from '../src/map/visible-graph';
import { demoSnapshot } from './snapshot';

describe('visibleGraph', () => {
  it('shows collapsed components with weighted edges and hides edges inside a component', () => {
    const graph = visibleGraph(demoSnapshot(), new Set());
    expect(graph.nodes.map((n) => [n.id, n.kind, n.fileCount])).toEqual([
      ['folder:src/api', 'component', 2],
      ['folder:src/db', 'component', 1],
    ]);
    expect(graph.edges).toEqual([{ id: 'folder:src/api->folder:src/db', from: 'folder:src/api', to: 'folder:src/db', weight: 2 }]);
  });

  it('shows the files of an expanded component as its children and routes edges to them', () => {
    const graph = visibleGraph(demoSnapshot(), new Set(['folder:src/api']));
    expect(graph.nodes.filter((n) => n.kind === 'file').map((n) => [n.id, n.parentId, n.label])).toEqual([
      ['src/api/a.ts', 'folder:src/api', 'a.ts'],
      ['src/api/b.ts', 'folder:src/api', 'b.ts'],
    ]);
    expect(graph.edges.map((e) => `${e.from}->${e.to}:${e.weight}`).sort()).toEqual([
      'src/api/a.ts->folder:src/db:1',
      'src/api/a.ts->src/api/b.ts:1',
      'src/api/b.ts->folder:src/db:1',
    ]);
  });

  it('marks files with parse errors', () => {
    const graph = visibleGraph(demoSnapshot(), new Set(['folder:src/db']));
    expect(graph.nodes.find((n) => n.id === 'src/db/c.ts')?.parseError).toBe(true);
  });

  it('keeps the signature for a snapshot whose visible nodes and edges are unchanged', () => {
    const before = demoSnapshot(1);
    const symbol = { name: 'x', kind: 'variable' as const, startLine: 1, endLine: 1, exported: true };
    const after = { ...demoSnapshot(2), files: before.files.map((f) => ({ ...f, symbols: [symbol] })) };

    expect(graphSignature(visibleGraph(after, new Set()))).toBe(graphSignature(visibleGraph(before, new Set())));
  });

  it('changes the signature when an edge appears', () => {
    const before = demoSnapshot();
    const after = { ...before, fileEdges: [...before.fileEdges, { from: 'src/db/c.ts', to: 'src/api/a.ts', kind: 'import' as const }] };

    expect(graphSignature(visibleGraph(after, new Set()))).not.toBe(graphSignature(visibleGraph(before, new Set())));
  });
});
