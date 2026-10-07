import { isAbsolute, relative, sep } from 'node:path';
import type { PlanFlow, PlanStep, PlanTarget, TargetOp } from '@ide/protocol';
import { realTarget } from '../gate/paths';
import { discoverNestedRepo, scopeRelOf, worktreeOf } from '../gate/worktrees';
import { isRecord } from '../json';
import { parsePlanFlow } from './plan-flow';

export interface ComponentRef {
  id: string;
  name: string;
  files: string[];
  globs: string[];
}

export interface PlanInput {
  goal: string;
  steps: PlanStep[];
  flow: PlanFlow | null;
}

const OPS: readonly string[] = ['modify', 'create', 'delete'];
const WILDCARD = /[*?]/;
const MAX_STEPS = 50;
const MAX_TARGETS = 200;
const MAX_TEXT = 2000;
const LISTED_IDS = 100;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null);

export function projectPath(path: string, root: string): string | null {
  const rel = relative(root, realTarget(path, root));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const projectRel = rel.split(sep).join('/');
  // The gate judges a worktree file by its path inside the worktree; the plan must name it the same way.
  const hit = worktreeOf(root, projectRel) ?? discoverNestedRepo(root, projectRel);
  const inner = hit ? scopeRelOf(root, hit) : null;
  return inner ? inner : projectRel;
}

export function parsePlanInput(raw: unknown, root: string, components: ComponentRef[]): PlanInput | string {
  if (!isRecord(raw)) return 'CodeRay: propose_plan needs {"goal": "...", "steps": [...]}.';
  const goal = text(raw.goal);
  if (!goal) return 'CodeRay: the plan needs a "goal".';
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return 'CodeRay: the plan needs at least one step.';
  if (raw.steps.length > MAX_STEPS) return `CodeRay: a plan can have at most ${MAX_STEPS} steps.`;
  const byId = new Map(components.map((component) => [component.id, component]));
  const steps: PlanStep[] = [];
  const keys = new Set<string>();
  for (const [index, value] of raw.steps.entries()) {
    if (!isRecord(value)) return `CodeRay: step ${index + 1} is not an object.`;
    const key = text(value.key);
    if (!key) return `CodeRay: step ${index + 1} needs a "key".`;
    if (keys.has(key)) return `CodeRay: two steps have the key "${key}"; keys must be unique.`;
    const title = text(value.title);
    if (!title) return `CodeRay: step "${key}" needs a "title".`;
    if (!Array.isArray(value.targets) || value.targets.length === 0) return `CodeRay: step "${key}" needs at least one target.`;
    if (value.targets.length > MAX_TARGETS) return `CodeRay: step "${key}" has more than ${MAX_TARGETS} targets.`;
    const targets: PlanTarget[] = [];
    for (const target of value.targets) {
      const parsed = parseTarget(target, key, root, byId);
      if (typeof parsed === 'string') return parsed;
      targets.push(parsed);
    }
    keys.add(key);
    steps.push({ key, order: index + 1, title, rationale: text(value.rationale) ?? '', targets });
  }
  const flow = parsePlanFlow(raw.flow, keys, (path) => projectPath(path, root));
  if (typeof flow === 'string') return flow;
  return { goal, steps, flow };
}

function parseTarget(value: unknown, key: string, root: string, byId: Map<string, ComponentRef>): PlanTarget | string {
  if (!isRecord(value)) return `CodeRay: a target of step "${key}" is not an object.`;
  if (typeof value.op !== 'string' || !OPS.includes(value.op)) return `CodeRay: a target of step "${key}" needs "op": "modify", "create" or "delete".`;
  const op = value.op as TargetOp;
  const componentId = typeof value.componentId === 'string' && value.componentId !== '' ? value.componentId : null;
  const path = typeof value.path === 'string' && value.path !== '' ? value.path : null;
  if ((componentId === null) === (path === null)) return `CodeRay: each target of step "${key}" names either a "componentId" or a "path".`;
  if (componentId !== null) {
    if (!byId.has(componentId)) return `CodeRay: step "${key}" names an unknown component "${componentId}". ${validIds(byId)}`;
    return { componentId, op };
  }
  if (WILDCARD.test(path!)) return `CodeRay: "${path}" in step "${key}" contains a wildcard; name files or directories.`;
  const rel = projectPath(path!, root);
  if (rel === null) return `CodeRay: "${path}" in step "${key}" is not a path inside the project.`;
  return { path: rel, op };
}

function validIds(byId: Map<string, ComponentRef>): string {
  if (byId.size === 0) return 'The map has no components yet; name project paths instead.';
  const listed = [...byId.values()].slice(0, LISTED_IDS).map((component) => `${component.id} (${component.name})`);
  const more = byId.size > LISTED_IDS ? `, and ${byId.size - LISTED_IDS} more` : '';
  return `Valid component ids: ${listed.join(', ')}${more}.`;
}
