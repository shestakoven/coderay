import type { Positions } from './flow-layout';

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export function tweenPositions(from: Positions, to: Positions, t: number): Positions {
  const k = easeOutCubic(Math.min(1, Math.max(0, t)));
  return new Map([...to].map(([id, target]) => {
    const start = from.get(id) ?? target;
    return [id, { x: start.x + (target.x - start.x) * k, y: start.y + (target.y - start.y) * k }];
  }));
}
