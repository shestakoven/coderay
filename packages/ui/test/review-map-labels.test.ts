import { Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { placeLabels, pointAt } from '../src/history/review-map/review-map-labels';

const SIZE = { width: 200, height: 60 };
const at = (entries: [string, number, number][]) => new Map(entries.map(([id, x, y]) => [id, { x, y }]));

describe('placeLabels', () => {
  it('keeps the middle when nothing else is there', () => {
    const t = placeLabels([{ index: 0, from: 'a', to: 'b', text: 'users', rank: 0 }], at([['a', 0, 0], ['b', 400, 0]]), SIZE, 'RIGHT');
    expect(t.get(0)).toBe(0.5);
  });

  it('moves the second of two labels that would meet in the middle, the flagged one keeps it', () => {
    const positions = at([['a', 0, 0], ['b', 360, 0], ['c', 360, 10]]);
    const t = placeLabels([
      { index: 0, from: 'a', to: 'b', text: 'create_user', rank: 2 },
      { index: 1, from: 'a', to: 'c', text: 'validate_email', rank: 0 },
    ], positions, SIZE, 'RIGHT');
    expect(t.get(1)).toBe(0.5);
    expect(t.get(0)).not.toBe(0.5);
  });

  it('takes a label off a card the link passes behind', () => {
    const positions = at([['a', 0, 0], ['mid', 350, 0], ['b', 700, 0]]);
    const t = placeLabels([{ index: 0, from: 'a', to: 'b', text: 'helper', rank: 0 }], positions, SIZE, 'RIGHT').get(0) ?? 0.5;
    const [x] = pointAt({ sx: 200, sy: 30, tx: 700, ty: 30, sp: Position.Right, tp: Position.Left }, t);
    expect(x < 350 || x > 550).toBe(true);
  });

  it('skips a link whose end has no place yet', () => {
    expect(placeLabels([{ index: 3, from: 'a', to: 'gone', text: 'x', rank: 0 }], at([['a', 0, 0]]), SIZE, 'DOWN').size).toBe(0);
  });
});
