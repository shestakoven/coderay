import type { PlanFlow, PlanFlowEdge, PlanFlowNode, PlanView, StepStatus } from '@ide/protocol';

export type FlowView = 'now' | 'plan';
export type StepPhase = 'proposed' | StepStatus;
export type NodePhase = StepPhase | 'none';

const DRAWN = new Set(['proposed', 'approved', 'done']);

// The map stays while the agent revises a plan the user sent changes on, so the answer does not make it vanish.
export const flowOf = (plan: PlanView | null): PlanFlow | null => (plan !== null && (DRAWN.has(plan.status) || plan.status === 'changes-requested') ? plan.flow : null);

export function stepPhase(plan: PlanView, key: string): StepPhase {
  if (plan.status === 'proposed') return 'proposed';
  return plan.steps.find((step) => step.key === key)?.status ?? 'pending';
}

export function nodePhase(plan: PlanView, node: PlanFlowNode): NodePhase {
  const phases = node.steps.map((key) => stepPhase(plan, key));
  if (phases.length === 0) return 'none';
  if (phases.every((phase) => phase === 'proposed')) return 'proposed';
  if (phases.every((phase) => phase === 'done')) return 'done';
  if (phases.includes('active')) return 'active';
  return 'pending';
}

export const edgePhase = (plan: PlanView, edge: PlanFlowEdge): NodePhase => (edge.step === undefined ? 'none' : stepPhase(plan, edge.step));

export function stepBadges(plan: PlanView, node: PlanFlowNode): { n: number; phase: StepPhase }[] {
  return node.steps
    .flatMap((key) => {
      const index = plan.steps.findIndex((step) => step.key === key);
      return index === -1 ? [] : [{ n: index + 1, phase: stepPhase(plan, key) }];
    })
    .sort((a, b) => a.n - b.n);
}

export function nowFlow(flow: PlanFlow): PlanFlow {
  const nodes = flow.nodes.filter((node) => node.state !== 'create');
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: flow.edges.filter((edge) => edge.state !== 'new' && ids.has(edge.from) && ids.has(edge.to)) };
}

export type FlowFocus = { step: string } | { node: string } | null;

export interface FocusSet {
  nodes: Set<string>;
  edges: Set<number>;
}

export function focusSet(flow: PlanFlow, focus: FlowFocus): FocusSet | null {
  if (focus === null) return null;
  const nodes = new Set<string>();
  const edges = new Set<number>();
  if ('step' in focus) {
    for (const node of flow.nodes) if (node.steps.includes(focus.step)) nodes.add(node.id);
    flow.edges.forEach((edge, index) => {
      if (edge.step !== focus.step) return;
      edges.add(index);
      nodes.add(edge.from);
      nodes.add(edge.to);
    });
  } else {
    nodes.add(focus.node);
    flow.edges.forEach((edge, index) => {
      if (edge.from !== focus.node && edge.to !== focus.node) return;
      edges.add(index);
      nodes.add(edge.from);
      nodes.add(edge.to);
    });
  }
  return { nodes, edges };
}

export function pickFocus(hoverStep: string | null, hoverNode: string | null, selected: string | null): FlowFocus {
  if (hoverStep !== null) return { step: hoverStep };
  const node = hoverNode ?? selected;
  return node === null ? null : { node };
}

export interface FlowSummary {
  created: number;
  modified: number;
  removed: number;
  links: number;
  files: number;
}

export function summarize(flow: PlanFlow): FlowSummary {
  const count = (state: PlanFlowNode['state']) => flow.nodes.filter((node) => node.state === state).length;
  return {
    created: count('create'),
    modified: count('modify'),
    removed: count('delete'),
    links: flow.edges.filter((edge) => edge.state === 'new').length,
    files: new Set(flow.nodes.flatMap((node) => node.files.map((file) => file.path))).size,
  };
}

export interface Connection {
  edge: PlanFlowEdge;
  other: PlanFlowNode;
  outgoing: boolean;
}

export function connections(flow: PlanFlow, nodeId: string): Connection[] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  return flow.edges.flatMap((edge) => {
    if (edge.from !== nodeId && edge.to !== nodeId) return [];
    const other = byId.get(edge.from === nodeId ? edge.to : edge.from);
    return other === undefined ? [] : [{ edge, other, outgoing: edge.from === nodeId }];
  });
}

export function rationale(plan: PlanView, node: PlanFlowNode): string {
  for (const key of node.steps) {
    const text = plan.steps.find((step) => step.key === key)?.rationale;
    if (text) return text;
  }
  return '';
}
