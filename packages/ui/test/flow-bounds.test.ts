import { describe, expect, it } from 'vitest';
import { boundsOf, FLOW_NODE_SIZE, type Positions } from '../src/plan-flow/flow-layout';

const { width: W, height: H } = FLOW_NODE_SIZE;

const at = (entries: [string, number, number][]): Positions => new Map(entries.map(([id, x, y]) => [id, { x, y }]));

describe('boundsOf', () => {
  it('is exactly one node box for a single node', () => {
    expect(boundsOf(at([['a', 300, 200]]), ['a'])).toEqual({ x: 300, y: 200, width: W, height: H });
  });

  it('spans from the top left of the first node to the bottom right of the last for nodes on a diagonal', () => {
    expect(boundsOf(at([['a', 0, 0], ['b', 300, 200]]), ['a', 'b'])).toEqual({ x: 0, y: 0, width: 300 + W, height: 200 + H });
  });

  it('takes x from one node and y from another for nodes on the other diagonal', () => {
    expect(boundsOf(at([['a', 400, 0], ['b', 0, 300]]), ['a', 'b'])).toEqual({ x: 0, y: 0, width: 400 + W, height: 300 + H });
  });

  it('takes every edge from a different node when the extremes are spread over four nodes', () => {
    const positions = at([['left', 10, 120], ['right', 510, 90], ['top', 260, 20], ['bottom', 240, 420]]);
    expect(boundsOf(positions, ['left', 'right', 'top', 'bottom'])).toEqual({ x: 10, y: 20, width: 500 + W, height: 400 + H });
  });

  it('adds the node height but not the width to a vertical stack', () => {
    expect(boundsOf(at([['a', 50, 0], ['b', 50, 300]]), ['a', 'b'])).toEqual({ x: 50, y: 0, width: W, height: 300 + H });
  });

  it('adds the node width but not the height to a horizontal row', () => {
    expect(boundsOf(at([['a', 0, 70], ['b', 400, 70]]), ['a', 'b'])).toEqual({ x: 0, y: 70, width: 400 + W, height: H });
  });

  it('is one node box for several nodes at the same position', () => {
    expect(boundsOf(at([['a', 40, 60], ['b', 40, 60]]), ['a', 'b'])).toEqual({ x: 40, y: 60, width: W, height: H });
  });

  it('gives the same box whatever the order of the ids', () => {
    const positions = at([['a', 0, 0], ['b', 300, 200], ['c', 120, 500]]);
    const expected = { x: 0, y: 0, width: 300 + W, height: 500 + H };
    expect(boundsOf(positions, ['a', 'b', 'c'])).toEqual(expected);
    expect(boundsOf(positions, ['c', 'b', 'a'])).toEqual(expected);
    expect(boundsOf(positions, ['b', 'c', 'a'])).toEqual(expected);
  });

  it('gives the same box when an id is listed twice', () => {
    const positions = at([['a', 0, 0], ['b', 300, 200]]);
    expect(boundsOf(positions, ['a', 'b', 'b', 'a'])).toEqual(boundsOf(positions, ['a', 'b']));
  });

  it('handles negative coordinates', () => {
    const positions = at([['a', -500, -300], ['b', -100, 50]]);
    expect(boundsOf(positions, ['a', 'b'])).toEqual({ x: -500, y: -300, width: 400 + W, height: 350 + H });
  });

  it('handles nodes entirely at negative coordinates', () => {
    expect(boundsOf(at([['a', -700, -400]]), ['a'])).toEqual({ x: -700, y: -400, width: W, height: H });
  });

  it('handles fractional coordinates from the layout', () => {
    const positions = at([['a', 10.5, 20.25], ['b', 110.5, 70.75]]);
    expect(boundsOf(positions, ['a', 'b'])).toEqual({ x: 10.5, y: 20.25, width: 100 + W, height: 50.5 + H });
  });

  describe('which nodes count', () => {
    const positions = at([['a', 0, 0], ['b', 300, 200], ['farAfter', 5000, 5000], ['farBefore', -5000, -5000]]);

    it('ignores nodes that are not listed, however far out they sit', () => {
      expect(boundsOf(positions, ['a', 'b'])).toEqual({ x: 0, y: 0, width: 300 + W, height: 200 + H });
    });

    it('ignores far unlisted nodes at the top left as well as at the bottom right', () => {
      expect(boundsOf(positions, ['b'])).toEqual({ x: 300, y: 200, width: W, height: H });
    });

    it('counts a far node once it is listed', () => {
      expect(boundsOf(positions, ['b', 'farAfter'])).toEqual({ x: 300, y: 200, width: 4700 + W, height: 4800 + H });
      expect(boundsOf(positions, ['farBefore', 'a'])).toEqual({ x: -5000, y: -5000, width: 5000 + W, height: 5000 + H });
    });

    it('skips listed ids that have no position', () => {
      expect(boundsOf(positions, ['a', 'missing'])).toEqual({ x: 0, y: 0, width: W, height: H });
      expect(boundsOf(positions, ['missing', 'b', 'also-missing'])).toEqual({ x: 300, y: 200, width: W, height: H });
    });
  });

  describe('with nothing to bound', () => {
    it('is null for no ids', () => {
      expect(boundsOf(at([['a', 0, 0]]), [])).toBeNull();
    });

    it('is null when no listed id has a position', () => {
      expect(boundsOf(at([['a', 0, 0]]), ['missing', 'also-missing'])).toBeNull();
    });

    it('is null for an empty positions map', () => {
      expect(boundsOf(at([]), ['a'])).toBeNull();
    });
  });

  it('does not change the positions it reads', () => {
    const positions = at([['a', 0, 0], ['b', 300, 200]]);
    boundsOf(positions, ['a', 'b']);
    expect([...positions]).toEqual([['a', { x: 0, y: 0 }], ['b', { x: 300, y: 200 }]]);
  });
});
