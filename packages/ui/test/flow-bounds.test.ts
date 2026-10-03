import { describe, expect, it } from 'vitest';
import { boundsOf, FLOW_NODE_SIZE, type Positions } from '../src/plan-flow/flow-layout';

const positions: Positions = new Map([
  ['a', { x: 0, y: 0 }],
  ['b', { x: 300, y: 200 }],
  ['far', { x: 5000, y: 5000 }],
]);

describe('boundsOf', () => {
  it('spans the listed nodes including their size and ignores the others', () => {
    expect(boundsOf(positions, ['a', 'b'])).toEqual({ x: 0, y: 0, width: 300 + FLOW_NODE_SIZE.width, height: 200 + FLOW_NODE_SIZE.height });
  });

  it('starts at the top left of the listed nodes', () => {
    expect(boundsOf(positions, ['b', 'far'])).toEqual({ x: 300, y: 200, width: 4700 + FLOW_NODE_SIZE.width, height: 4800 + FLOW_NODE_SIZE.height });
  });

  it('is the size of one node for one node', () => {
    expect(boundsOf(positions, ['b'])).toEqual({ x: 300, y: 200, ...FLOW_NODE_SIZE });
  });

  it('skips ids without a position and gives null when none is left', () => {
    expect(boundsOf(positions, ['a', 'missing'])).toEqual({ x: 0, y: 0, ...FLOW_NODE_SIZE });
    expect(boundsOf(positions, ['missing'])).toBeNull();
    expect(boundsOf(positions, [])).toBeNull();
  });
});
