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

  it('drops edges whose either end is a test file', () => {
    const snapshot = demoSnapshot();
    snapshot.files.push({ ...snapshot.files[0]!, path: 'src/api/a.test.ts' });
    snapshot.components[0] = { ...snapshot.components[0]!, files: [...snapshot.components[0]!.files, 'src/api/a.test.ts'] };
    snapshot.fileEdges.push({ from: 'src/api/a.test.ts', to: 'src/db/c.ts', kind: 'import' }, { from: 'src/db/c.ts', to: 'test/helpers.ts', kind: 'import' });
    const graph = visibleGraph(snapshot, new Set());
    expect(graph.edges).toEqual([{ id: 'folder:src/api->folder:src/db', from: 'folder:src/api', to: 'folder:src/db', weight: 2 }]);
  });

  it('hides components made only of test files on request', () => {
    const snapshot = demoSnapshot();
    snapshot.components.push({ ...snapshot.components[0]!, id: 'folder:test', name: 'Tests', files: ['test/a.test.ts'] });
    expect(visibleGraph(snapshot, new Set()).nodes.map((n) => n.id)).toContain('folder:test');
    expect(visibleGraph(snapshot, new Set(), [], true).nodes.map((n) => n.id)).not.toContain('folder:test');
    expect(visibleGraph(snapshot, new Set(), [], true).nodes.map((n) => n.id)).toContain('folder:src/api');
  });

  it('carries component summaries and staleness onto component nodes', () => {
    const snapshot = demoSnapshot();
    snapshot.components[0] = { ...snapshot.components[0]!, summary: 'Serves the HTTP API', stale: true };
    const node = visibleGraph(snapshot, new Set()).nodes.find((n) => n.id === 'folder:src/api');
    expect(node).toMatchObject({ summary: 'Serves the HTTP API', stale: true });
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

  it('adds planned new files as ghost nodes, only inside expanded components', () => {
    const ghosts = [{ path: 'src/api/new.ts', componentId: 'folder:src/api' }, { path: 'src/db/new.ts', componentId: 'folder:src/db' }];
    const graph = visibleGraph(demoSnapshot(), new Set(['folder:src/api']), ghosts);
    expect(graph.nodes.filter((node) => node.ghost).map((node) => [node.id, node.parentId, node.label])).toEqual([
      ['new:src/api/new.ts', 'folder:src/api', 'new.ts'],
    ]);
  });
});
