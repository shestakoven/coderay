import type { ControlMode } from './settings';

export type TargetOp = 'modify' | 'create' | 'delete';

export interface PlanTarget {
  componentId?: string;
  path?: string;
  op: TargetOp;
}

export interface PlanStep {
  key: string;
  order: number;
  title: string;
  rationale: string;
  targets: PlanTarget[];
}

export type StepStatus = 'pending' | 'active' | 'done';

export interface PlanStepView extends PlanStep {
  status: StepStatus;
  extra?: boolean;
}

export type PlanStatus = 'proposed' | 'approved' | 'changes-requested' | 'rejected' | 'withdrawn' | 'superseded' | 'done' | 'closed';

export type ApprovedBy = 'user-card' | 'user-expand' | 'auto';

export interface FrozenScope {
  paths: string[];
  globs: string[];
  deletes?: { paths: string[]; globs: string[] };
}

export interface PlanReview {
  auto: boolean;
  notes: string[];
}

export const PLAN_FLOW_NODE_KINDS = ['actor', 'endpoint', 'schema', 'service', 'module', 'model', 'store', 'external', 'test'] as const;
export const PLAN_FLOW_NODE_STATES = ['existing', 'modify', 'create', 'delete'] as const;
export const PLAN_FLOW_EDGE_STATES = ['existing', 'new', 'removed'] as const;
export const PLAN_FLOW_FILE_OPS = ['+', '~', '-'] as const;

export type PlanFlowNodeKind = (typeof PLAN_FLOW_NODE_KINDS)[number];
export type PlanFlowNodeState = (typeof PLAN_FLOW_NODE_STATES)[number];
export type PlanFlowEdgeState = (typeof PLAN_FLOW_EDGE_STATES)[number];
export type PlanFlowFileOp = (typeof PLAN_FLOW_FILE_OPS)[number];

export interface PlanFlowFile {
  op: PlanFlowFileOp;
  path: string;
  note?: string;
}

export interface PlanFlowNode {
  id: string;
  title: string;
  sub: string;
  kind: PlanFlowNodeKind;
  state: PlanFlowNodeState;
  steps: string[];
  files: PlanFlowFile[];
}

export interface PlanFlowEdge {
  from: string;
  to: string;
  label: string;
  state: PlanFlowEdgeState;
  step?: string;
}

export interface PlanFlow {
  nodes: PlanFlowNode[];
  edges: PlanFlowEdge[];
}

export interface PlanView {
  id: string;
  version: number;
  goal: string;
  status: PlanStatus;
  approvedBy: ApprovedBy | null;
  steps: PlanStepView[];
  scope: FrozenScope;
  owners: Record<string, string | null>;
  review: PlanReview;
  feedback: string | null;
  flow: PlanFlow | null;
  proposedAt: number;
  decidedAt: number | null;
}

export type PlanAnswer = { kind: 'approve' } | { kind: 'accept' } | { kind: 'changes'; feedback: string } | { kind: 'reject'; feedback: string };

export type ToolDecision = 'allow' | 'unchecked' | 'ask-approved' | 'ask-denied' | 'deny' | 'flag' | 'hook-missing' | 'hook-pending';

export type GateAnswer = 'allow-once' | 'expand-plan' | 'deny';

export type GateTargetKind = 'enforced' | 'outside' | 'unresolved' | 'all-tracked';

export interface GateTarget {
  path: string;
  kind: GateTargetKind;
  inScope: boolean;
  deleting: boolean;
  componentId: string | null;
}

export type GatePreview =
  | { kind: 'write'; path: string; content: string; truncated: boolean }
  | { kind: 'edit'; path: string; oldString: string; newString: string; truncated: boolean }
  | { kind: 'command'; command: string; truncated: boolean }
  | { kind: 'input'; text: string; truncated: boolean };

export type GatePromptStatus = 'pending' | 'answered' | 'dropped';

export interface GatePromptView {
  id: string;
  toolUseId: string;
  parentToolUseId: string | null;
  tool: string;
  summary: string;
  preview: GatePreview;
  reason: string | null;
  targets: GateTarget[];
  canExpand: boolean;
  planId: string | null;
  mode: ControlMode;
  status: GatePromptStatus;
  answer: GateAnswer | null;
  ts: number;
}

export type PlanServerMessage =
  | { type: 'plans.snapshot'; plans: PlanView[] }
  | { type: 'gate.snapshot'; prompts: GatePromptView[] };

export type PlanClientMessage =
  | { type: 'plan.answer'; planId: string; version: number; answer: PlanAnswer }
  | { type: 'gate.answer'; promptId: string; answer: GateAnswer };
