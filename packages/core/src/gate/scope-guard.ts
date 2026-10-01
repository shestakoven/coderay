import type { ControlMode } from '@ide/protocol';
import { covers, type FrozenScope } from './scope';
import type { ToolClass } from './tools';

export type TargetKind = 'enforced' | 'recorded' | 'temp' | 'outside' | 'unresolved' | 'all-tracked';

export interface ClassifiedTarget {
  raw: string;
  kind: TargetKind;
  rel: string | null;
  abs: string | null;
  dir: boolean;
  mkdir: boolean;
  deleting: boolean;
  exists: boolean;
  guarded: boolean;
  why: string;
  unowned?: boolean;
}

export type PlanGate =
  | { state: 'none' }
  | { state: 'approved'; planId: string; version: number; scope: FrozenScope; activeStep: string | null }
  | { state: 'done'; planId: string }
  | { state: 'rejected'; planId: string };

export type Outcome = 'allow' | 'unchecked' | 'deny' | 'ask' | 'flag';

export interface GuardInput {
  tool: string;
  toolClass: ToolClass;
  targets: ClassifiedTarget[];
  gate: PlanGate;
  mode: ControlMode;
}

export interface GuardDecision {
  outcome: Outcome;
  reason: string;
  relevant: ClassifiedTarget[];
  outOfScope: ClassifiedTarget[];
  planId: string | null;
  version: number | null;
  stepKey: string | null;
}

const NEEDS_PLAN = new Set<TargetKind>(['enforced', 'outside', 'unresolved', 'all-tracked']);
const UNCHECKED = new Set<ToolClass>(['subagent', 'read', 'mcp', 'interactive']);
const MAX_LISTED = 5;
const NO_OWNER = 'no component owns this directory; name the file in a step, or expand the plan.';
const NONE = { relevant: [], outOfScope: [], planId: null, version: null, stepKey: null };

export const targetName = (target: ClassifiedTarget): string => target.rel ?? target.abs ?? target.raw;

export function describeTargets(targets: ClassifiedTarget[]): string {
  const names = targets.map((target) => {
    if (target.kind === 'all-tracked') return 'every tracked file (a git command that rewrites the work tree)';
    if (target.kind === 'unresolved') return `${target.raw} (${target.why})`;
    return targetName(target);
  });
  const shown = names.slice(0, MAX_LISTED).join(', ');
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

export function decide(input: GuardInput): GuardDecision {
  if (input.toolClass === 'ide') return { ...NONE, outcome: 'allow', reason: "IDE: the IDE's own tool." };
  if (UNCHECKED.has(input.toolClass)) return { ...NONE, outcome: 'unchecked', reason: 'IDE: this tool writes no project files.' };
  if (input.toolClass === 'unknown') return unknownTool(input);
  const relevant = input.targets.filter((target) => NEEDS_PLAN.has(target.kind));
  if (relevant.length === 0) return { ...NONE, outcome: 'unchecked', reason: 'IDE: no project files are written.' };
  const list = describeTargets(relevant);
  const gate = input.gate;
  if (gate.state === 'none') {
    return {
      ...NONE, relevant, outcome: 'deny',
      reason: `IDE: no approved plan covers ${list}. Call mcp__idecore__propose_plan with your steps and their targets first, and wait for its result.`,
    };
  }
  if (gate.state === 'rejected') {
    return { ...NONE, relevant, planId: gate.planId, outcome: 'deny', reason: `IDE: the user rejected plan ${gate.planId}. Stop and wait for the user's next message.` };
  }
  if (gate.state === 'done') {
    return { ...NONE, relevant, planId: gate.planId, outcome: 'deny', reason: `IDE: plan ${gate.planId} is done. Call mcp__idecore__propose_plan for further changes.` };
  }
  const stamp = { planId: gate.planId, version: gate.version };
  if (gate.activeStep === null) {
    return {
      ...NONE, ...stamp, relevant, outcome: 'deny',
      reason: `IDE: plan ${gate.planId} is approved, but no step is active. Call mcp__idecore__step with {"key": "<step key>", "phase": "start"} first.`,
    };
  }
  const outOfScope = relevant.filter((target) => !inScope(gate.scope, target));
  const base = { ...stamp, stepKey: gate.activeStep, relevant, outOfScope };
  if (outOfScope.length === 0) return { ...base, outcome: 'allow', reason: `IDE: allowed by plan ${gate.planId}, step ${gate.activeStep}.` };
  const outside = describeTargets(outOfScope);
  const hint = outOfScope.some((target) => target.unowned) ? ` ${NO_OWNER}` : '';
  const one = outOfScope.length === 1;
  if (input.mode === 'A') {
    return {
      ...base, outcome: 'deny',
      reason: `IDE: ${outside} ${one ? 'is' : 'are'} outside the approved plan ${gate.planId}. Propose a new version of the plan with mcp__idecore__propose_plan (keep the active and done steps) to include ${one ? 'it' : 'them'}.${hint}`,
    };
  }
  if (input.mode === 'C') return { ...base, outcome: 'flag', reason: `IDE: allowed and flagged (control mode C): ${outside} outside the approved plan ${gate.planId}.${hint}` };
  return { ...base, outcome: 'ask', reason: `IDE: ${outside} outside the approved plan ${gate.planId}; waiting for the user.${hint}` };
}

function inScope(scope: FrozenScope, target: ClassifiedTarget): boolean {
  if (target.kind === 'enforced' && target.rel !== null) return covers(scope, { rel: target.rel, dir: target.dir, mkdir: target.mkdir, deleting: target.deleting });
  if (target.kind === 'all-tracked') return scope.globs.includes('**');
  return false;
}

function unknownTool(input: GuardInput): GuardDecision {
  if (input.mode === 'A') return { ...NONE, outcome: 'deny', reason: `IDE: ${input.tool} is a tool the IDE does not know; control mode A blocks it.` };
  if (input.mode === 'C') return { ...NONE, outcome: 'flag', reason: `IDE: ${input.tool} is a tool the IDE does not know; allowed and flagged (control mode C).` };
  return { ...NONE, outcome: 'ask', reason: `IDE: ${input.tool} is a tool the IDE does not know; waiting for the user.` };
}
