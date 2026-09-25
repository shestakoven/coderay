import type { Edge } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { C4EdgeData, C4FlowNode, EdgeKind } from '../src/c4/c4-graph';
import { focusOf } from '../src/c4/focus';

const node = (id: string, parentId?: string): C4FlowNode => ({
  id,
  type: parentId ? 'component' : 'container',
  position: { x: 0, y: 0 },
  data: { kind: parentId ? 'component' : 'container', title: id, subtitle: '', accent: '', icon: '' },
  ...(parentId ? { parentId } : {}),
});
const edge = (source: string, target: string, kind: EdgeKind = 'plain'): Edge<C4EdgeData> => ({
  id: `${source}->${target}`,
  source,
  target,
  data: { protocols: [], strength: 1, linkIds: [], kind },
});
const sorted = (ids: Set<string> | undefined) => [...(ids ?? [])].sort();

// An opened container P with components K1 and K2, calling X and Y.
const openedNodes = [node('P'), node('K1', 'P'), node('K2', 'P'), node('X'), node('Y')];
const openedEdges = [edge('P', 'X', 'summary'), edge('K1', 'X', 'detail'), edge('K2', 'Y', 'detail'), edge('P', 'Y', 'summary')];

describe('focusOf', () => {
  it('returns no focus when nothing is selected', () => {
    expect(focusOf(null, [node('a')], [])).toBeNull();
  });

  describe('a selected node', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
    const edges = [edge('a', 'b'), edge('c', 'a'), edge('b', 'd')];

    it('shows its own edges only', () => {
      expect(sorted(focusOf({ type: 'node', id: 'a' }, nodes, edges)?.edges)).toEqual(['a->b', 'c->a']);
    });

    it('focuses itself and the nodes at the other end of its edges', () => {
      expect(sorted(focusOf({ type: 'node', id: 'a' }, nodes, edges)?.nodes)).toEqual(['a', 'b', 'c']);
    });
  });

  it('shows the summary edges of a selected opened container, not the detail edges of its components', () => {
    expect(sorted(focusOf({ type: 'node', id: 'P' }, openedNodes, openedEdges)?.edges)).toEqual(['P->X', 'P->Y']);
  });

  it('shows the edges of the members of a selected group', () => {
    const nodes = [node('G'), node('M1', 'G'), node('M2', 'G'), node('X'), node('Y'), node('Z'), node('W')];
    const edges = [edge('M1', 'X'), edge('M2', 'Y'), edge('Z', 'W')];
    expect(sorted(focusOf({ type: 'node', id: 'G' }, nodes, edges)?.edges)).toEqual(['M1->X', 'M2->Y']);
  });

  it('shows only its own edges for a selected component', () => {
    expect(sorted(focusOf({ type: 'node', id: 'K1' }, openedNodes, openedEdges)?.edges)).toEqual(['K1->X']);
  });

  describe('a selected edge', () => {
    it('shows only that edge', () => {
      expect(sorted(focusOf({ type: 'edge', id: 'P->X', ids: [] }, openedNodes, openedEdges)?.edges)).toEqual(['P->X']);
    });

    it('focuses its two ends', () => {
      expect(sorted(focusOf({ type: 'edge', id: 'P->X', ids: [] }, openedNodes, openedEdges)?.nodes)).toEqual(['P', 'X']);
    });

    it('marks the parent of an end inside an opened container as context', () => {
      expect(sorted(focusOf({ type: 'edge', id: 'K1->X', ids: [] }, openedNodes, openedEdges)?.context)).toEqual(['P']);
    });
  });

  it('marks every ancestor of a focused node as context', () => {
    const nodes = [node('G'), node('P', 'G'), node('K', 'P'), node('X')];
    expect(sorted(focusOf({ type: 'node', id: 'X' }, nodes, [edge('K', 'X', 'detail')])?.context)).toEqual(['G', 'P']);
  });
});
