import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { fitKey, layoutBounds, layoutGraph, NODE_SIZE } from '../src/map/layout';
import { visibleGraph } from '../src/map/visible-graph';
import { demoSnapshot } from './snapshot';

const expanded = new Set(['folder:src/api']);
const elk = new ELK();

describe('layoutGraph', () => {
  it('positions every visible node, lists parents before children and keeps every edge', async () => {
    const graph = visibleGraph(demoSnapshot(), expanded);
    const { nodes, edges } = await layoutGraph(graph, expanded, elk);

    expect(nodes.map((n) => n.id).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x) && Number.isFinite(node.position.y)).toBe(true);
    }
    const order = new Map(nodes.map((n, i) => [n.id, i]));
    for (const child of nodes.filter((n) => n.parentId)) {
      expect(order.get(child.parentId!)!).toBeLessThan(order.get(child.id)!);
      expect(child.extent).toBe('parent');
    }
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(graph.edges.map((e) => `${e.from}->${e.to}`).sort());
  });

  it('sizes an expanded component to contain its files', async () => {
    const { nodes } = await layoutGraph(visibleGraph(demoSnapshot(), expanded), expanded, elk);
    const container = nodes.find((n) => n.id === 'folder:src/api')!;
    expect(container.data.expanded).toBe(true);
    expect(container.width!).toBeGreaterThan(NODE_SIZE.file.width);
    expect(container.height!).toBeGreaterThan(NODE_SIZE.file.height * 2);
  });

  it('bounds the top-level nodes of a layout', async () => {
    const { nodes } = await layoutGraph(visibleGraph(demoSnapshot(), new Set()), new Set(), elk);
    const bounds = layoutBounds(nodes)!;
    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(bounds.x);
      expect(node.position.y).toBeGreaterThanOrEqual(bounds.y);
      expect(node.position.x + node.width!).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(node.position.y + node.height!).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(layoutBounds([])).toBeNull();
  });

  it('keys the fit on the top-level components, not on what is expanded', async () => {
    const collapsed = await layoutGraph(visibleGraph(demoSnapshot(), new Set()), new Set(), elk);
    const open = await layoutGraph(visibleGraph(demoSnapshot(), expanded), expanded, elk);
    expect(fitKey(open.nodes)).toBe(fitKey(collapsed.nodes));
    expect(fitKey(collapsed.nodes)).toBe('folder:src/api\nfolder:src/db');
  });
});
