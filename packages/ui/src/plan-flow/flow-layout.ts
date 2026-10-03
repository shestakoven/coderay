import type { PlanFlow } from '@ide/protocol';
import type { ELK } from 'elkjs/lib/elk-api.js';
import type { Direction } from '../map/layout-settings';
import { nowFlow, type FlowView } from './flow-model';

export const FLOW_NODE_SIZE = { width: 216, height: 82 } as const;

export type Positions = Map<string, { x: number; y: number }>;

export interface FlowLayouts {
  plan: Positions;
  now: Positions;
}

async function layoutOne(elk: ELK, flow: PlanFlow, direction: Direction): Promise<Positions> {
  const vertical = direction === 'DOWN' || direction === 'UP';
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': vertical ? '56' : '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': vertical ? '92' : '130',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: flow.nodes.map((node) => ({ id: node.id, ...FLOW_NODE_SIZE })),
    edges: flow.edges.map((edge, index) => ({ id: `e${index}`, sources: [edge.from], targets: [edge.to] })),
  });
  return new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]));
}

export async function layoutFlow(elk: ELK, flow: PlanFlow, direction: Direction): Promise<FlowLayouts> {
  const [plan, now] = await Promise.all([layoutOne(elk, flow, direction), layoutOne(elk, nowFlow(flow), direction)]);
  return { plan, now };
}

export function positionsFor(layouts: FlowLayouts, view: FlowView): Positions {
  if (view === 'plan') return layouts.plan;
  return new Map([...layouts.plan].map(([id, position]) => [id, layouts.now.get(id) ?? position]));
}
