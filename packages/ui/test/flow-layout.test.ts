import ELK from 'elkjs/lib/elk.bundled.js';
import type { PlanFlow, PlanFlowEdge, PlanFlowNode, PlanView } from '@ide/protocol';
import { describe, expect, it } from 'vitest';
import type { Direction } from '../src/map/layout-settings';
import { FLOW_NODE_SIZE, layoutFlow, positionsFor } from '../src/plan-flow/flow-layout';
import type { FlowView } from '../src/plan-flow/flow-model';
import { easeOutCubic, tweenPositions } from '../src/plan-flow/tween';
import { limitPlan, userPlan } from './flow-fixtures';

type Point = { x: number; y: number };
type Positions = Map<string, Point>;

const flowIn = (plan: PlanView): PlanFlow => {
  if (plan.flow === null) throw new Error('fixture plan has no flow');
  return plan.flow;
};
const userFlow = () => flowIn(userPlan());
const limitFlow = () => flowIn(limitPlan());

const elk = new ELK();
const DIRECTIONS: readonly Direction[] = ['RIGHT', 'DOWN', 'LEFT', 'UP'];
const FIXTURES: [string, () => PlanFlow][] = [
  ['userPlan', () => userFlow()],
  ['limitPlan', () => limitFlow()],
];

const at = (positions: Positions, id: string): Point => {
  const found = positions.get(id);
  if (found === undefined) throw new Error(`no position for ${id}`);
  return found;
};
const points = (entries: Record<string, [number, number]>): Positions =>
  new Map(Object.entries(entries).map(([id, [x, y]]) => [id, { x, y }]));
const sorted = (values: Iterable<string>) => [...values].sort();
const ids = (flow: PlanFlow) => flow.nodes.map((n) => n.id);
const existingIds = (flow: PlanFlow) => flow.nodes.filter((n) => n.state !== 'create').map((n) => n.id);

const node = (id: string, state: PlanFlowNode['state'] = 'existing'): PlanFlowNode =>
  ({ id, title: id, sub: `${id} sub`, kind: 'module', state, steps: [], files: [] });
const edge = (from: string, to: string, state: PlanFlowEdge['state'] = 'existing'): PlanFlowEdge =>
  ({ from, to, label: `${from} to ${to}`, state });

const isFinitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);
const overlaps = (a: Point, b: Point) =>
  a.x < b.x + FLOW_NODE_SIZE.width && b.x < a.x + FLOW_NODE_SIZE.width && a.y < b.y + FLOW_NODE_SIZE.height && b.y < a.y + FLOW_NODE_SIZE.height;
const overlappingPairs = (positions: Positions): string[] => {
  const entries = [...positions];
  return entries.flatMap(([idA, a], i) => entries.slice(i + 1).flatMap(([idB, b]) => (overlaps(a, b) ? [`${idA} / ${idB}`] : [])));
};
const nonFinite = (positions: Positions): string[] => [...positions].filter(([, p]) => !isFinitePoint(p)).map(([id]) => id);

const onCycle = (flow: PlanFlow): Set<string> => {
  const next = new Map<string, string[]>();
  for (const e of flow.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(next.get(from) ?? [])];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return false;
  };
  return new Set(ids(flow).filter((id) => reaches(id, id)));
};

const flowsForward = (direction: Direction, source: Point, target: Point): boolean => {
  switch (direction) {
    case 'RIGHT': return source.x < target.x;
    case 'LEFT': return source.x > target.x;
    case 'DOWN': return source.y < target.y;
    case 'UP': return source.y > target.y;
  }
};
const directedEdges = (flow: PlanFlow): PlanFlowEdge[] => {
  const cyclic = onCycle(flow);
  return flow.edges.filter((e) => !cyclic.has(e.to));
};
const misordered = (flow: PlanFlow, positions: Positions, direction: Direction): string[] =>
  directedEdges(flow)
    .filter((e) => !flowsForward(direction, at(positions, e.from), at(positions, e.to)))
    .map((e) => `${e.from} -> ${e.to}`);

const separation = (a: Point, b: Point): number => {
  const gapX = Math.max(a.x - (b.x + FLOW_NODE_SIZE.width), b.x - (a.x + FLOW_NODE_SIZE.width));
  const gapY = Math.max(a.y - (b.y + FLOW_NODE_SIZE.height), b.y - (a.y + FLOW_NODE_SIZE.height));
  return Math.max(gapX, gapY);
};
const minSeparation = (positions: Positions): number => {
  const entries = [...positions.values()];
  return Math.min(...entries.flatMap((a, i) => entries.slice(i + 1).map((b) => separation(a, b))));
};
const linkGap = (direction: Direction, source: Point, target: Point): number => {
  switch (direction) {
    case 'RIGHT': return target.x - (source.x + FLOW_NODE_SIZE.width);
    case 'LEFT': return source.x - (target.x + FLOW_NODE_SIZE.width);
    case 'DOWN': return target.y - (source.y + FLOW_NODE_SIZE.height);
    case 'UP': return source.y - (target.y + FLOW_NODE_SIZE.height);
  }
};
const minLinkGap = (flow: PlanFlow, positions: Positions, direction: Direction): number =>
  Math.min(...directedEdges(flow).map((e) => linkGap(direction, at(positions, e.from), at(positions, e.to))));

const nowOf = (flow: PlanFlow): PlanFlow => {
  const kept = new Set(existingIds(flow));
  return { nodes: flow.nodes.filter((n) => kept.has(n.id)), edges: flow.edges.filter((e) => e.state !== 'new' && kept.has(e.from) && kept.has(e.to)) };
};

describe('test helpers', () => {
  it('see rectangles that share area but not ones that only touch', () => {
    const { width, height } = FLOW_NODE_SIZE;
    expect(overlappingPairs(points({ a: [0, 0], b: [width - 1, 0] }))).toEqual(['a / b']);
    expect(overlappingPairs(points({ a: [0, 0], b: [0, height - 1] }))).toEqual(['a / b']);
    expect(overlappingPairs(points({ a: [0, 0], b: [width, 0], c: [0, height] }))).toEqual([]);
  });

  it('find the nodes that sit on a cycle and none in an acyclic flow', () => {
    const cyclic: PlanFlow = { nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')] };
    expect(sorted(onCycle(cyclic))).toEqual(['a', 'b']);
    expect(onCycle(userFlow()).size).toBe(0);
    expect(onCycle(limitFlow()).size).toBe(0);
  });
});

describe('spacing helpers', () => {
  it('measure the clear space between cards, along the flow and in any direction', () => {
    const { width, height } = FLOW_NODE_SIZE;
    expect(minSeparation(points({ a: [0, 0], b: [width + 30, 0], c: [0, height + 50] }))).toBe(30);
    expect(minSeparation(points({ a: [0, 0], b: [width + 30, height + 50] }))).toBe(50);
    expect(linkGap('DOWN', { x: 0, y: 0 }, { x: 5, y: height + 70 })).toBe(70);
    expect(linkGap('UP', { x: 0, y: height + 70 }, { x: 5, y: 0 })).toBe(70);
    expect(linkGap('RIGHT', { x: 0, y: 0 }, { x: width + 90, y: 5 })).toBe(90);
    expect(linkGap('LEFT', { x: width + 90, y: 0 }, { x: 0, y: 5 })).toBe(90);
  });
});

describe('FLOW_NODE_SIZE', () => {
  it('is the size of a flow card', () => {
    expect(FLOW_NODE_SIZE).toEqual({ width: 216, height: 82 });
  });
});

describe.each(FIXTURES)('layoutFlow of %s', (_name, makeFlow) => {
  it('positions every node in the plan layout, in every direction', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const { plan } = await layoutFlow(elk, flow, direction);
      expect(sorted(plan.keys()), direction).toEqual(sorted(ids(flow)));
    }
  });

  it('positions exactly the nodes that exist today in the now layout, in every direction', async () => {
    const flow = makeFlow();
    expect(existingIds(flow).length).toBeGreaterThan(0);
    expect(existingIds(flow).length).toBeLessThan(flow.nodes.length);
    for (const direction of DIRECTIONS) {
      const { now } = await layoutFlow(elk, flow, direction);
      expect(sorted(now.keys()), direction).toEqual(sorted(existingIds(flow)));
    }
  });

  it('gives every node a finite x and y in both layouts, in every direction', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(nonFinite(plan), `plan ${direction}`).toEqual([]);
      expect(nonFinite(now), `now ${direction}`).toEqual([]);
    }
  });

  it('keeps node rectangles apart in the plan layout, in every direction', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const { plan } = await layoutFlow(elk, flow, direction);
      expect(overlappingPairs(plan), direction).toEqual([]);
    }
  });

  it('keeps node rectangles apart in the now layout, in every direction', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const { now } = await layoutFlow(elk, flow, direction);
      expect(overlappingPairs(now), direction).toEqual([]);
    }
  });

  it('lays the same flow out the same way every time', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const first = await layoutFlow(elk, flow, direction);
      const second = await layoutFlow(elk, makeFlow(), direction);
      expect(second.plan, `plan ${direction}`).toEqual(first.plan);
      expect(second.now, `now ${direction}`).toEqual(first.now);
    }
  });

  it('lays the now graph out on its own: the now layout is the plan layout of the flow without new nodes and links', async () => {
    const flow = makeFlow();
    for (const direction of DIRECTIONS) {
      const whole = await layoutFlow(elk, flow, direction);
      const today = await layoutFlow(elk, nowOf(flow), direction);
      expect(whole.now, direction).toEqual(today.plan);
    }
  });
});

describe('layoutFlow direction', () => {
  it.each(DIRECTIONS)('puts the source of every link before its target in the plan layout of userPlan, %s', async (direction) => {
    const flow = userFlow();
    expect(directedEdges(flow)).toHaveLength(flow.edges.length);
    const { plan } = await layoutFlow(elk, flow, direction);
    expect(misordered(flow, plan, direction)).toEqual([]);
  });

  it.each(DIRECTIONS)('puts the source of every link before its target in the plan layout of limitPlan, %s', async (direction) => {
    const flow = limitFlow();
    const { plan } = await layoutFlow(elk, flow, direction);
    expect(misordered(flow, plan, direction)).toEqual([]);
  });

  it.each(DIRECTIONS)('puts the source of every link before its target in the now layout, %s', async (direction) => {
    for (const [name, makeFlow] of FIXTURES) {
      const today = nowOf(makeFlow());
      expect(today.edges.length, name).toBeGreaterThan(0);
      const { now } = await layoutFlow(elk, makeFlow(), direction);
      expect(misordered(today, now, direction), name).toEqual([]);
    }
  });

  it('spreads the layers along y for DOWN and UP and along x for RIGHT and LEFT', async () => {
    const flow = userFlow();
    const span = (positions: Positions, axis: 'x' | 'y') => {
      const values = [...positions.values()].map((p) => p[axis]);
      return Math.max(...values) - Math.min(...values);
    };
    for (const direction of ['DOWN', 'UP'] as const) {
      const { plan } = await layoutFlow(elk, flow, direction);
      expect(span(plan, 'y'), direction).toBeGreaterThanOrEqual(3 * FLOW_NODE_SIZE.height);
    }
    for (const direction of ['RIGHT', 'LEFT'] as const) {
      const { plan } = await layoutFlow(elk, flow, direction);
      expect(span(plan, 'x'), direction).toBeGreaterThanOrEqual(3 * FLOW_NODE_SIZE.width);
    }
  });
});

describe('layoutFlow spacing', () => {
  const MIN_CARD_GAP = 16;
  const MIN_LINK_ROOM = 48;

  it('leaves a visible gap between cards in both layouts, in every direction', async () => {
    for (const [name, makeFlow] of FIXTURES) {
      for (const direction of DIRECTIONS) {
        const { plan, now } = await layoutFlow(elk, makeFlow(), direction);
        expect(minSeparation(plan), `${name} plan ${direction}`).toBeGreaterThanOrEqual(MIN_CARD_GAP);
        expect(minSeparation(now), `${name} now ${direction}`).toBeGreaterThanOrEqual(MIN_CARD_GAP);
      }
    }
  });

  it('leaves room for the link label between a source and its target, in every direction', async () => {
    for (const [name, makeFlow] of FIXTURES) {
      const flow = makeFlow();
      for (const direction of DIRECTIONS) {
        const { plan, now } = await layoutFlow(elk, flow, direction);
        expect(minLinkGap(flow, plan, direction), `${name} plan ${direction}`).toBeGreaterThanOrEqual(MIN_LINK_ROOM);
        expect(minLinkGap(nowOf(flow), now, direction), `${name} now ${direction}`).toBeGreaterThanOrEqual(MIN_LINK_ROOM);
      }
    }
  });

  it('spaces opposite directions alike, so flipping the direction does not reshape the diagram', async () => {
    for (const [name, makeFlow] of FIXTURES) {
      const flow = makeFlow();
      for (const [forward, backward] of [['DOWN', 'UP'], ['RIGHT', 'LEFT']] as const) {
        const a = (await layoutFlow(elk, flow, forward)).plan;
        const b = (await layoutFlow(elk, flow, backward)).plan;
        expect(minLinkGap(flow, b, backward), `${name} ${backward} link gap`).toBeCloseTo(minLinkGap(flow, a, forward), 6);
        expect(minSeparation(b), `${name} ${backward} card gap`).toBeCloseTo(minSeparation(a), 6);
      }
    }
  });
});

describe('layoutFlow on small and odd graphs', () => {
  it('lays out a single node with no links', async () => {
    const flow: PlanFlow = { nodes: [node('solo')], edges: [] };
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(sorted(plan.keys()), direction).toEqual(['solo']);
      expect(sorted(now.keys()), direction).toEqual(['solo']);
      expect(isFinitePoint(at(plan, 'solo')), direction).toBe(true);
      expect(isFinitePoint(at(now, 'solo')), direction).toBe(true);
    }
  });

  it('lays out a single new node: one plan position, no now position', async () => {
    const flow: PlanFlow = { nodes: [node('solo', 'create')], edges: [] };
    const { plan, now } = await layoutFlow(elk, flow, 'DOWN');
    expect(sorted(plan.keys())).toEqual(['solo']);
    expect(isFinitePoint(at(plan, 'solo'))).toBe(true);
    expect(now.size).toBe(0);
  });

  it('lays out a two-node cycle and an isolated node with finite, separate positions', async () => {
    const flow: PlanFlow = { nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'a')] };
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      for (const [name, layout] of [['plan', plan], ['now', now]] as const) {
        expect(sorted(layout.keys()), `${name} ${direction}`).toEqual(['a', 'b', 'c']);
        expect(nonFinite(layout), `${name} ${direction}`).toEqual([]);
        expect(overlappingPairs(layout), `${name} ${direction}`).toEqual([]);
      }
    }
  });

  it('lays out a flow whose cycle only exists once the new nodes are added', async () => {
    const flow: PlanFlow = {
      nodes: [node('a'), node('b'), node('d', 'create')],
      edges: [edge('a', 'b'), edge('b', 'd', 'new'), edge('d', 'a', 'new')],
    };
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(sorted(plan.keys()), direction).toEqual(['a', 'b', 'd']);
      expect(sorted(now.keys()), direction).toEqual(['a', 'b']);
      expect(nonFinite(plan), direction).toEqual([]);
      expect(nonFinite(now), direction).toEqual([]);
      expect(overlappingPairs(plan), direction).toEqual([]);
      expect(overlappingPairs(now), direction).toEqual([]);
    }
  });

  it('lays out a flow with a cycle in the now graph next to new nodes', async () => {
    const flow: PlanFlow = {
      nodes: [node('a'), node('b', 'modify'), node('c', 'create'), node('d', 'create')],
      edges: [edge('a', 'b'), edge('b', 'a', 'removed'), edge('b', 'd', 'new'), edge('c', 'd', 'new')],
    };
    expect(nowOf(flow).edges).toHaveLength(2);
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(sorted(plan.keys()), direction).toEqual(['a', 'b', 'c', 'd']);
      expect(sorted(now.keys()), direction).toEqual(['a', 'b']);
      expect(nonFinite(plan), direction).toEqual([]);
      expect(nonFinite(now), direction).toEqual([]);
      expect(overlappingPairs(plan), direction).toEqual([]);
      expect(overlappingPairs(now), direction).toEqual([]);
    }
  });

  it('still orders the links that are not part of a cycle', async () => {
    const flow: PlanFlow = {
      nodes: [node('a'), node('b'), node('tail'), node('lone')],
      edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'tail')],
    };
    for (const direction of DIRECTIONS) {
      const { plan } = await layoutFlow(elk, flow, direction);
      expect(directedEdges(flow).map((e) => e.to)).toEqual(['tail']);
      expect(misordered(flow, plan, direction), direction).toEqual([]);
    }
  });

  it('lays out nodes whose ids are names Object.prototype also has', async () => {
    const flow: PlanFlow = {
      nodes: [node('plain'), node('constructor'), node('__proto__', 'create')],
      edges: [edge('plain', 'constructor'), edge('constructor', '__proto__', 'new')],
    };
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(sorted(plan.keys()), direction).toEqual(['__proto__', 'constructor', 'plain']);
      expect(sorted(now.keys()), direction).toEqual(['constructor', 'plain']);
      expect(nonFinite(plan), direction).toEqual([]);
      expect(nonFinite(now), direction).toEqual([]);
      expect(overlappingPairs(plan), direction).toEqual([]);
    }
  });

  it('keeps the links of those nodes attached: they still flow in the chosen direction', async () => {
    const flow: PlanFlow = {
      nodes: [node('plain'), node('constructor'), node('__proto__', 'create')],
      edges: [edge('plain', 'constructor'), edge('constructor', '__proto__', 'new')],
    };
    for (const direction of DIRECTIONS) {
      const { plan, now } = await layoutFlow(elk, flow, direction);
      expect(misordered(flow, plan, direction), `plan ${direction}`).toEqual([]);
      expect(misordered(nowOf(flow), now, direction), `now ${direction}`).toEqual([]);
    }
  });

  it('lays out two nodes that are both called after Object.prototype members and exist today', async () => {
    const flow: PlanFlow = { nodes: [node('__proto__'), node('constructor')], edges: [edge('__proto__', 'constructor')] };
    const { plan, now } = await layoutFlow(elk, flow, 'DOWN');
    expect(sorted(plan.keys())).toEqual(['__proto__', 'constructor']);
    expect(sorted(now.keys())).toEqual(['__proto__', 'constructor']);
    expect(at(plan, '__proto__').y).toBeLessThan(at(plan, 'constructor').y);
    expect(at(now, '__proto__').y).toBeLessThan(at(now, 'constructor').y);
  });

  it('gives a flow where every node is new an empty now layout and a full plan layout', async () => {
    const flow: PlanFlow = {
      nodes: [node('x', 'create'), node('y', 'create'), node('z', 'create')],
      edges: [edge('x', 'y', 'new'), edge('y', 'z', 'new')],
    };
    for (const direction of DIRECTIONS) {
      const layouts = await layoutFlow(elk, flow, direction);
      expect(layouts.now.size, direction).toBe(0);
      expect(sorted(layouts.plan.keys()), direction).toEqual(['x', 'y', 'z']);
      expect(nonFinite(layouts.plan), direction).toEqual([]);
    }
  });
});

describe('positionsFor', () => {
  it('returns the plan layout for the plan view', async () => {
    const layouts = await layoutFlow(elk, userFlow(), 'DOWN');
    expect(positionsFor(layouts, 'plan')).toEqual(layouts.plan);
  });

  it('has every node of the plan layout for the now view, existing nodes at their now position and new nodes at their plan position', async () => {
    const flow = userFlow();
    for (const direction of DIRECTIONS) {
      const layouts = await layoutFlow(elk, flow, direction);
      const view = positionsFor(layouts, 'now');
      expect(sorted(view.keys()), direction).toEqual(sorted(ids(flow)));
      for (const n of flow.nodes) {
        const expected = n.state === 'create' ? at(layouts.plan, n.id) : at(layouts.now, n.id);
        expect(at(view, n.id), `${direction} ${n.id}`).toEqual(expected);
      }
    }
  });

  it('moves at least one existing node of userPlan between the plan and the now layout', async () => {
    const flow = userFlow();
    const { plan, now } = await layoutFlow(elk, flow, 'DOWN');
    const moved = existingIds(flow).filter((id) => at(plan, id).x !== at(now, id).x || at(plan, id).y !== at(now, id).y);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('still has all nodes for the now view when every node is new', async () => {
    const flow: PlanFlow = { nodes: [node('x', 'create'), node('y', 'create')], edges: [edge('x', 'y', 'new')] };
    const layouts = await layoutFlow(elk, flow, 'RIGHT');
    expect(positionsFor(layouts, 'now')).toEqual(layouts.plan);
    expect(sorted(positionsFor(layouts, 'now').keys())).toEqual(['x', 'y']);
  });

  it('uses the now position where there is one and the plan position otherwise', () => {
    const layouts = {
      plan: points({ a: [0, 0], b: [10, 10], c: [20, 20] }),
      now: points({ a: [5, 5], c: [99, 99] }),
    };
    expect(positionsFor(layouts, 'now')).toEqual(points({ a: [5, 5], b: [10, 10], c: [99, 99] }));
    expect(positionsFor(layouts, 'plan')).toEqual(points({ a: [0, 0], b: [10, 10], c: [20, 20] }));
  });

  it('returns every node for each view', async () => {
    const flow = limitFlow();
    const layouts = await layoutFlow(elk, flow, 'DOWN');
    for (const view of ['now', 'plan'] as FlowView[]) {
      expect(sorted(positionsFor(layouts, view).keys()), view).toEqual(sorted(ids(flow)));
    }
  });

  it('does not change the layouts it is given', () => {
    const layouts = {
      plan: points({ a: [0, 0], b: [10, 10], c: [20, 20] }),
      now: points({ a: [5, 5], c: [99, 99] }),
    };
    positionsFor(layouts, 'now');
    positionsFor(layouts, 'plan');
    expect(layouts.plan).toEqual(points({ a: [0, 0], b: [10, 10], c: [20, 20] }));
    expect(layouts.now).toEqual(points({ a: [5, 5], c: [99, 99] }));
  });
});

describe('tweenPositions', () => {
  const from = () => points({ mover: [0, 100], slider: [40, 40], still: [7, -3], gone: [500, 500] });
  const to = () => points({ mover: [100, 0], slider: [240, 40], still: [7, -3], arrived: [60, 80] });
  const expectPoint = (actual: Point, [x, y]: [number, number]) => {
    expect(actual.x).toBeCloseTo(x, 9);
    expect(actual.y).toBeCloseTo(y, 9);
  };
  const strictlyBetween = (value: number, a: number, b: number) => value > Math.min(a, b) && value < Math.max(a, b);

  it('is at the from position for every id in both maps when t is 0', () => {
    const result = tweenPositions(from(), to(), 0);
    expectPoint(at(result, 'mover'), [0, 100]);
    expectPoint(at(result, 'slider'), [40, 40]);
    expectPoint(at(result, 'still'), [7, -3]);
  });

  it('is at the to position for every id when t is 1', () => {
    const result = tweenPositions(from(), to(), 1);
    expectPoint(at(result, 'mover'), [100, 0]);
    expectPoint(at(result, 'slider'), [240, 40]);
    expectPoint(at(result, 'still'), [7, -3]);
    expectPoint(at(result, 'arrived'), [60, 80]);
  });

  it('puts a moving node strictly between its two positions at t = 0.5', () => {
    const mover = at(tweenPositions(from(), to(), 0.5), 'mover');
    expect(strictlyBetween(mover.x, 0, 100)).toBe(true);
    expect(strictlyBetween(mover.y, 100, 0)).toBe(true);
  });

  it('moves only the coordinate that differs and leaves the other one alone', () => {
    const slider = at(tweenPositions(from(), to(), 0.5), 'slider');
    expect(strictlyBetween(slider.x, 40, 240)).toBe(true);
    expect(slider.y).toBeCloseTo(40, 9);
  });

  it('keeps a node that does not move where it is at t = 0.5', () => {
    expectPoint(at(tweenPositions(from(), to(), 0.5), 'still'), [7, -3]);
  });

  it('eases t itself: the moved fraction is easeOutCubic(t), not t', () => {
    for (const t of [0.1, 0.25, 0.5, 0.8]) {
      const k = easeOutCubic(t);
      const result = tweenPositions(from(), to(), t);
      expectPoint(at(result, 'mover'), [100 * k, 100 - 100 * k]);
      expectPoint(at(result, 'slider'), [40 + 200 * k, 40]);
    }
  });

  it('has moved 87.5% of the way at t = 0.5', () => {
    const result = tweenPositions(points({ n: [0, 0] }), points({ n: [100, 0] }), 0.5);
    expect(at(result, 'n').x).toBeCloseTo(87.5, 9);
    expect(at(result, 'n').y).toBeCloseTo(0, 9);
  });

  it('gets closer to the target as t grows', () => {
    const steps = Array.from({ length: 11 }, (_, i) => i / 10);
    const movers = steps.map((t) => at(tweenPositions(from(), to(), t), 'mover'));
    const sliders = steps.map((t) => at(tweenPositions(from(), to(), t), 'slider'));
    const xs = (list: Point[]) => list.map((p) => p.x);
    const ys = (list: Point[]) => list.map((p) => p.y);
    const rises = (values: number[]) => values.every((value, i) => i === 0 || value > (values[i - 1] ?? Infinity));
    expect(rises(xs(movers))).toBe(true);
    expect(rises(ys(movers).map((y) => -y))).toBe(true);
    expect(rises(xs(sliders))).toBe(true);
  });

  it('puts an id that is missing from from at its to position for every t', () => {
    for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      expect(at(tweenPositions(from(), to(), t), 'arrived'), `t = ${t}`).toEqual({ x: 60, y: 80 });
    }
  });

  it('treats a t below 0 as 0', () => {
    expect(tweenPositions(from(), to(), -0.5)).toEqual(tweenPositions(from(), to(), 0));
    expect(tweenPositions(from(), to(), -100)).toEqual(tweenPositions(from(), to(), 0));
  });

  it('treats a t above 1 as 1', () => {
    expect(tweenPositions(from(), to(), 1.5)).toEqual(tweenPositions(from(), to(), 1));
    expect(tweenPositions(from(), to(), 100)).toEqual(tweenPositions(from(), to(), 1));
  });

  it('has exactly the ids of to and drops ids that only exist in from', () => {
    for (const t of [0, 0.5, 1]) {
      expect(sorted(tweenPositions(from(), to(), t).keys()), `t = ${t}`).toEqual(['arrived', 'mover', 'slider', 'still']);
    }
  });

  it('returns an empty map when to is empty', () => {
    expect(tweenPositions(from(), new Map(), 0.5).size).toBe(0);
  });

  it('puts every node at its to position when from is empty', () => {
    expect(tweenPositions(new Map(), to(), 0.5)).toEqual(to());
  });

  it('does not change the maps it is given', () => {
    const start = from();
    const end = to();
    tweenPositions(start, end, 0.5);
    expect(start).toEqual(from());
    expect(end).toEqual(to());
  });

  it('works on real layouts: nodes that exist today travel from their now position to their plan position', async () => {
    const flow = userFlow();
    const layouts = await layoutFlow(elk, flow, 'DOWN');
    const start = positionsFor(layouts, 'now');
    const end = positionsFor(layouts, 'plan');
    expect(tweenPositions(start, end, 0)).toEqual(start);
    expect(tweenPositions(start, end, 1)).toEqual(end);
    expect(sorted(tweenPositions(start, end, 0.5).keys())).toEqual(sorted(ids(flow)));
  });
});

describe('easeOutCubic', () => {
  const samples = Array.from({ length: 21 }, (_, i) => i / 20);
  const inside = samples.filter((t) => t > 0 && t < 1);

  it('is 0 at 0 and 1 at 1', () => {
    expect(easeOutCubic(0)).toBeCloseTo(0, 12);
    expect(easeOutCubic(1)).toBeCloseTo(1, 12);
  });

  it('rises with t', () => {
    for (let i = 1; i < samples.length; i += 1) {
      expect(easeOutCubic(samples[i] ?? NaN), `t = ${samples[i]}`).toBeGreaterThan(easeOutCubic(samples[i - 1] ?? NaN));
    }
  });

  it('is above the identity between 0 and 1', () => {
    for (const t of inside) expect(easeOutCubic(t), `t = ${t}`).toBeGreaterThan(t);
  });

  it('stays within 0 and 1 for t in [0, 1]', () => {
    for (const t of samples) {
      expect(easeOutCubic(t), `t = ${t}`).toBeGreaterThanOrEqual(0);
      expect(easeOutCubic(t), `t = ${t}`).toBeLessThanOrEqual(1);
    }
  });

  it('is the cubic ease-out 1 - (1 - t)^3', () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
    expect(easeOutCubic(0.25)).toBeCloseTo(1 - 0.75 ** 3, 9);
    expect(easeOutCubic(0.9)).toBeCloseTo(1 - 0.1 ** 3, 9);
  });
});
