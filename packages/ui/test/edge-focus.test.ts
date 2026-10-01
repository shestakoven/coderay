import { describe, expect, it } from 'vitest';
import { focusEdges, strokeFor, type MapEdge } from '../src/map/edge-focus';

const edge = (source: string, target: string, weight?: number, id = `${source}->${target}`): MapEdge => ({
  id,
  source,
  target,
  ...(weight === undefined ? {} : { data: { weight } }),
});

const chain = (count: number, weight: number): MapEdge[] =>
  Array.from({ length: count }, (_, i) => edge(`a${i}`, `b${i}`, weight));

describe('focusEdges without focus', () => {
  it('shows every edge as quiet without labels when there are few edges', () => {
    const edges = [edge('a', 'b', 1), edge('b', 'c', 2), edge('c', 'd', 9)];
    const { edges: out, neighbors } = focusEdges(edges, null);
    expect(neighbors).toBeNull();
    expect(out.map((e) => e.hidden)).toEqual([false, false, false]);
    expect(out.every((e) => e.className === 'edge-quiet')).toBe(true);
    expect(out.every((e) => e.label === undefined)).toBe(true);
  });

  it('keeps a light edge visible at exactly the quiet edge limit', () => {
    const out = focusEdges(chain(12, 1), null).edges;
    expect(out).toHaveLength(12);
    expect(out.every((e) => e.hidden === false)).toBe(true);
  });

  it('hides light edges as soon as there is one edge over the limit', () => {
    const out = focusEdges(chain(13, 1), null).edges;
    expect(out).toHaveLength(13);
    expect(out.every((e) => e.hidden === true)).toBe(true);
  });

  it('hides edges lighter than the minimum weight and keeps the rest when crowded', () => {
    const edges = [...chain(12, 1), edge('x', 'y', 4, 'light'), edge('x', 'z', 5, 'edge'), edge('x', 'w', 12, 'heavy')];
    const byId = new Map(focusEdges(edges, null).edges.map((e) => [e.id, e]));
    expect(byId.get('light')!.hidden).toBe(true);
    expect(byId.get('edge')!.hidden).toBe(false);
    expect(byId.get('heavy')!.hidden).toBe(false);
  });

  it('treats a missing weight as 1 when deciding what to hide', () => {
    const edges = [...chain(12, 5), edge('x', 'y', undefined, 'bare')];
    const byId = new Map(focusEdges(edges, null).edges.map((e) => [e.id, e]));
    expect(byId.get('bare')!.hidden).toBe(true);
    expect(byId.get('bare')!.style).toEqual({ strokeWidth: 1 });
  });

  it('strokes quiet edges by weight', () => {
    const out = focusEdges([edge('a', 'b', 1), edge('c', 'd', 8)], null).edges;
    expect(out[0]!.style).toEqual({ strokeWidth: strokeFor(1) });
    expect(out[1]!.style).toEqual({ strokeWidth: strokeFor(8) });
  });

  it('strips a label that was set before', () => {
    const labelled: MapEdge = { ...edge('a', 'b', 3), label: '3' };
    expect(focusEdges([labelled], null).edges[0]!.label).toBeUndefined();
  });

  it('returns an empty list for no edges', () => {
    expect(focusEdges([], null)).toEqual({ edges: [], neighbors: null });
  });
});

describe('focusEdges with a focused node', () => {
  const edges = [edge('a', 'b', 3), edge('c', 'a', 1), edge('b', 'c', 6), edge('d', 'e', 9)];

  it('marks edges touching the focus as focus edges and the others as faint', () => {
    const byId = new Map(focusEdges(edges, 'a').edges.map((e) => [e.id, e]));
    expect(byId.get('a->b')!.className).toBe('edge-focus');
    expect(byId.get('c->a')!.className).toBe('edge-focus');
    expect(byId.get('b->c')!.className).toBe('edge-faint');
    expect(byId.get('d->e')!.className).toBe('edge-faint');
  });

  it('matches the focus as source and as target alike', () => {
    expect(focusEdges([edge('a', 'z', 1)], 'a').edges[0]!.className).toBe('edge-focus');
    expect(focusEdges([edge('z', 'a', 1)], 'a').edges[0]!.className).toBe('edge-focus');
    expect(focusEdges([edge('z', 'y', 1)], 'a').edges[0]!.className).toBe('edge-faint');
  });

  it('labels a related edge with its weight only when the weight is above 1', () => {
    const byId = new Map(focusEdges(edges, 'a').edges.map((e) => [e.id, e]));
    expect(byId.get('a->b')!.label).toBe('3');
    expect(byId.get('c->a')!.label).toBeUndefined();
  });

  it('never labels an unrelated edge, whatever its weight', () => {
    const byId = new Map(focusEdges(edges, 'a').edges.map((e) => [e.id, e]));
    expect(byId.get('b->c')!.label).toBeUndefined();
    expect(byId.get('d->e')!.label).toBeUndefined();
  });

  it('draws related edges at width 2 or more and unrelated ones at 1', () => {
    const byId = new Map(focusEdges(edges, 'a').edges.map((e) => [e.id, e]));
    expect(byId.get('c->a')!.style).toEqual({ strokeWidth: 2 });
    expect(byId.get('a->b')!.style).toEqual({ strokeWidth: Math.max(2, strokeFor(3)) });
    expect(byId.get('b->c')!.style).toEqual({ strokeWidth: 1 });
  });

  it('draws a heavy related edge at its own stroke when it exceeds 2', () => {
    const heavy = focusEdges([edge('a', 'b', 40)], 'a').edges[0]!;
    expect(heavy.style).toEqual({ strokeWidth: 4 });
  });

  it('never hides an edge while focused, even in a crowded graph', () => {
    const crowded = [...chain(17, 1), edge('a', 'b', 1)];
    expect(focusEdges(crowded, 'a').edges.every((e) => e.hidden === false)).toBe(true);
  });

  it('collects the focus and both ends of every related edge and nothing else', () => {
    expect([...focusEdges(edges, 'a').neighbors!].sort()).toEqual(['a', 'b', 'c']);
    expect([...focusEdges(edges, 'd').neighbors!].sort()).toEqual(['d', 'e']);
  });

  it('collects neighbours on a target-side focus too', () => {
    expect([...focusEdges([edge('x', 'f', 1), edge('y', 'q', 1)], 'f').neighbors!].sort()).toEqual(['f', 'x']);
  });

  it('keeps only the focus when the focused node has no edges and fades every edge', () => {
    const { edges: out, neighbors } = focusEdges(edges, 'lonely');
    expect([...neighbors!]).toEqual(['lonely']);
    expect(out.every((e) => e.className === 'edge-faint' && e.label === undefined && e.hidden === false)).toBe(true);
  });

  it('treats a missing weight as 1 so the label stays off', () => {
    const out = focusEdges([edge('a', 'b')], 'a').edges[0]!;
    expect(out.className).toBe('edge-focus');
    expect(out.label).toBeUndefined();
    expect(out.style).toEqual({ strokeWidth: 2 });
  });

  it('goes back to the quiet view when the focus is cleared', () => {
    const crowded = chain(13, 1);
    focusEdges(crowded, 'a0');
    const cleared = focusEdges(crowded, null);
    expect(cleared.neighbors).toBeNull();
    expect(cleared.edges.every((e) => e.className === 'edge-quiet' && e.hidden === true)).toBe(true);
  });
});

describe('focusEdges purity', () => {
  it('does not mutate the input edges or the array', () => {
    const edges = [edge('a', 'b', 6), edge('b', 'c', 1)];
    const snapshot = JSON.stringify(edges);
    const refs = [...edges];
    focusEdges(edges, null);
    focusEdges(edges, 'a');
    expect(JSON.stringify(edges)).toBe(snapshot);
    expect(edges).toEqual(refs);
    expect(edges[0]).toBe(refs[0]);
  });

  it('returns new edge objects that keep id, source, target and data', () => {
    const input = edge('a', 'b', 6);
    const out = focusEdges([input], 'a').edges[0]!;
    expect(out).not.toBe(input);
    expect(out).toMatchObject({ id: 'a->b', source: 'a', target: 'b', data: { weight: 6 } });
  });

  it('keeps the edge order', () => {
    const edges = [edge('a', 'b', 1), edge('b', 'c', 1), edge('c', 'd', 1)];
    expect(focusEdges(edges, 'b').edges.map((e) => e.id)).toEqual(['a->b', 'b->c', 'c->d']);
  });
});

describe('strokeFor', () => {
  it('is 1 at weight 1', () => {
    expect(strokeFor(1)).toBe(1);
  });

  it('treats weights below 1 as 1', () => {
    expect(strokeFor(0)).toBe(1);
    expect(strokeFor(-5)).toBe(1);
  });

  it('grows with weight', () => {
    const widths = [1, 2, 3, 5, 8, 13, 21, 34].map(strokeFor);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it('never decreases and is capped at 4', () => {
    let previous = 0;
    for (const weight of [1, 2, 10, 50, 100, 1_000, 1_000_000]) {
      const width = strokeFor(weight);
      expect(width).toBeGreaterThanOrEqual(previous);
      expect(width).toBeLessThanOrEqual(4);
      previous = width;
    }
    expect(strokeFor(1_000_000)).toBe(4);
  });

  it('grows logarithmically, 0.6 per doubling', () => {
    expect(strokeFor(2)).toBeCloseTo(1.6, 10);
    expect(strokeFor(4)).toBeCloseTo(2.2, 10);
  });
});
