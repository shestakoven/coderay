import { Position } from '@xyflow/react';
import { handlePositions, type Direction } from '../../map/layout-settings';
import type { Positions } from '../../plan-flow/flow-layout';

export interface Ends { sx: number; sy: number; tx: number; ty: number; sp: Position; tp: Position }
export interface LabelSpot { index: number; from: string; to: string; text: string; rank: number }
interface Box { x: number; y: number; w: number; h: number }

export const CURVATURE = 0.35;
const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
// Middle first, then outwards on both sides: a label leaves the middle only when something already sits there.
const TRIES = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.19, 0.81, 0.13, 0.87];
const LABEL_HEIGHT = 18;
const GAP = 3;

const offset = (distance: number): number => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));

// The control points React Flow's getBezierPath uses with the same curvature.
function control(position: Position, x: number, y: number, x2: number, y2: number): [number, number] {
  if (position === Position.Left) return [x - offset(x - x2), y];
  if (position === Position.Right) return [x + offset(x2 - x), y];
  if (position === Position.Top) return [x, y - offset(y - y2)];
  return [x, y + offset(y2 - y)];
}

export function pointAt({ sx, sy, tx, ty, sp, tp }: Ends, t: number): [number, number] {
  const [c1x, c1y] = control(sp, sx, sy, tx, ty);
  const [c2x, c2y] = control(tp, tx, ty, sx, sy);
  const u = 1 - t;
  return [
    u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
    u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty,
  ];
}

function handle(side: Position, at: { x: number; y: number }, size: { width: number; height: number }): [number, number] {
  if (side === Position.Left) return [at.x, at.y + size.height / 2];
  if (side === Position.Right) return [at.x + size.width, at.y + size.height / 2];
  if (side === Position.Top) return [at.x + size.width / 2, at.y];
  return [at.x + size.width / 2, at.y + size.height];
}

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Where along its curve each link's label sits (0 = source, 1 = target), so labels keep off each other and off the cards.
// Lower ranks are placed first and keep the better spots; the text length stands in for the label's width.
export function placeLabels(spots: LabelSpot[], positions: Positions, size: { width: number; height: number }, direction: Direction): Map<number, number> {
  const sides = handlePositions(direction);
  const cards: Box[] = [...positions.values()].map((at) => ({ x: at.x - GAP, y: at.y - GAP, w: size.width + 2 * GAP, h: size.height + 2 * GAP }));
  const placed: Box[] = [];
  const result = new Map<number, number>();
  const curves = spots.flatMap((spot) => {
    const from = positions.get(spot.from);
    const to = positions.get(spot.to);
    if (from === undefined || to === undefined) return [];
    const [sx, sy] = handle(POSITION[sides.source], from, size);
    const [tx, ty] = handle(POSITION[sides.target], to, size);
    return [{ spot, ends: { sx, sy, tx, ty, sp: POSITION[sides.source], tp: POSITION[sides.target] }, span: Math.hypot(tx - sx, ty - sy) }];
  });
  curves.sort((a, b) => a.spot.rank - b.spot.rank || a.span - b.span || a.spot.index - b.spot.index);
  for (const { spot, ends } of curves) {
    const w = spot.text.length * 5.8 + 34;
    let best = { t: 0.5, box: null as Box | null, cost: Infinity };
    for (const t of TRIES) {
      const [x, y] = pointAt(ends, t);
      const box = { x: x - w / 2 - GAP, y: y - LABEL_HEIGHT / 2 - GAP, w: w + 2 * GAP, h: LABEL_HEIGHT + 2 * GAP };
      // A label over a card's edge still reads; a label over another label hides both.
      const cost = cards.reduce((sum, card) => sum + overlap(box, card), 0) + 4 * placed.reduce((sum, other) => sum + overlap(box, other), 0);
      if (cost < best.cost) best = { t, box, cost };
      if (cost === 0) break;
    }
    result.set(spot.index, best.t);
    if (best.box !== null) placed.push(best.box);
  }
  return result;
}
