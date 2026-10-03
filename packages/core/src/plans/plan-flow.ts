import { PLAN_FLOW_EDGE_STATES, PLAN_FLOW_FILE_OPS, PLAN_FLOW_NODE_KINDS, PLAN_FLOW_NODE_STATES } from '@ide/protocol';
import type { FrozenScope, PlanFlow, PlanFlowEdge, PlanFlowFile, PlanFlowNode, PlanStep } from '@ide/protocol';
import { globMatches } from '../gate/scope';
import { isRecord } from '../json';

export const MAX_FLOW_NODES = 40;
export const MAX_FLOW_EDGES = 80;
export const MAX_FLOW_FILES = 20;
const MAX_ID = 60;
const MAX_TITLE = 60;
const MAX_SUB = 80;
const MAX_LABEL = 60;
const MAX_NOTE = 120;
const MAX_PATH = 1000;
const LISTED = 5;
const SHAPE = 'IDE: "flow" must be {"nodes": [...], "edges": [...]}.';

type ToRel = (path: string) => string | null;

const clean = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

const shown = (value: unknown): string => JSON.stringify(value) ?? 'nothing';

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | null => options.find((option) => option === value) ?? null;

export function parsePlanFlow(raw: unknown, stepKeys: ReadonlySet<string>, toRel: ToRel): PlanFlow | null | string {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return SHAPE;
  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawEdges)) return SHAPE;
  if (raw.nodes.length === 0) return 'IDE: the flow needs at least one node.';
  if (raw.nodes.length > MAX_FLOW_NODES) return `IDE: a flow can have at most ${MAX_FLOW_NODES} nodes.`;
  if (rawEdges.length > MAX_FLOW_EDGES) return `IDE: a flow can have at most ${MAX_FLOW_EDGES} edges.`;
  const nodes: PlanFlowNode[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.nodes.entries()) {
    const node = parseNode(value, index, stepKeys, toRel);
    if (typeof node === 'string') return node;
    if (ids.has(node.id)) return `IDE: two flow nodes have the id "${node.id}"; ids must be unique.`;
    ids.add(node.id);
    nodes.push(node);
  }
  const edges: PlanFlowEdge[] = [];
  for (const [index, value] of rawEdges.entries()) {
    const edge = parseEdge(value, index, ids, stepKeys);
    if (typeof edge === 'string') return edge;
    edges.push(edge);
  }
  return { nodes, edges };
}

function parseNode(value: unknown, index: number, stepKeys: ReadonlySet<string>, toRel: ToRel): PlanFlowNode | string {
  if (!isRecord(value)) return `IDE: flow node ${index + 1} is not an object.`;
  const id = clean(value.id, MAX_ID);
  if (!id) return `IDE: flow node ${index + 1} needs an "id".`;
  const title = clean(value.title, MAX_TITLE);
  if (!title) return `IDE: flow node "${id}" needs a "title".`;
  const kind = oneOf(PLAN_FLOW_NODE_KINDS, value.kind);
  if (!kind) return `IDE: flow node "${id}" needs "kind": ${PLAN_FLOW_NODE_KINDS.join(', ')} (got ${shown(value.kind)}).`;
  const state = oneOf(PLAN_FLOW_NODE_STATES, value.state);
  if (!state) return `IDE: flow node "${id}" needs "state": ${PLAN_FLOW_NODE_STATES.join(', ')} (got ${shown(value.state)}).`;
  const steps = parseStepKeys(value.steps, `flow node "${id}"`, stepKeys);
  if (typeof steps === 'string') return steps;
  if (state !== 'existing' && steps.length === 0) return `IDE: flow node "${id}" is "${state}" and needs at least one step key in "steps".`;
  const files = parseFiles(value.files, id, toRel);
  if (typeof files === 'string') return files;
  return { id, title, sub: clean(value.sub, MAX_SUB) ?? '', kind, state, steps, files };
}

function parseStepKeys(value: unknown, owner: string, stepKeys: ReadonlySet<string>): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `IDE: ${owner} needs "steps" as a list of step keys.`;
  const keys: string[] = [];
  for (const key of value) {
    if (typeof key !== 'string' || !stepKeys.has(key)) return `IDE: ${owner} names an unknown step ${JSON.stringify(key)}. Step keys: ${[...stepKeys].join(', ')}.`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function parseFiles(value: unknown, id: string, toRel: ToRel): PlanFlowFile[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `IDE: flow node "${id}" needs "files" as a list.`;
  if (value.length > MAX_FLOW_FILES) return `IDE: flow node "${id}" lists more than ${MAX_FLOW_FILES} files.`;
  const files: PlanFlowFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) return `IDE: a file of flow node "${id}" is not an object.`;
    const op = oneOf(PLAN_FLOW_FILE_OPS, item.op);
    if (!op) return `IDE: a file of flow node "${id}" needs "op": "+", "~" or "-" (got ${shown(item.op)}).`;
    const given = clean(item.path, MAX_PATH);
    const path = given === null ? null : toRel(given);
    if (path === null) return `IDE: flow node "${id}" lists "${String(item.path)}", which is not a path inside the project.`;
    const note = clean(item.note, MAX_NOTE);
    files.push(note === null ? { op, path } : { op, path, note });
  }
  return files;
}

function parseEdge(value: unknown, index: number, ids: ReadonlySet<string>, stepKeys: ReadonlySet<string>): PlanFlowEdge | string {
  const label = `flow edge ${index + 1}`;
  if (!isRecord(value)) return `IDE: ${label} is not an object.`;
  const from = clean(value.from, MAX_ID);
  const to = clean(value.to, MAX_ID);
  if (!from || !ids.has(from)) return `IDE: ${label} names an unknown node in "from": ${shown(value.from)}. Node ids: ${[...ids].join(', ')}.`;
  if (!to || !ids.has(to)) return `IDE: ${label} names an unknown node in "to": ${shown(value.to)}. Node ids: ${[...ids].join(', ')}.`;
  if (from === to) return `IDE: ${label} connects "${from}" to itself.`;
  const state = oneOf(PLAN_FLOW_EDGE_STATES, value.state);
  if (!state) return `IDE: ${label} needs "state": ${PLAN_FLOW_EDGE_STATES.join(', ')} (got ${shown(value.state)}).`;
  let step: string | undefined;
  if (value.step !== undefined) {
    const keys = parseStepKeys([value.step], label, stepKeys);
    if (typeof keys === 'string') return keys;
    step = keys[0];
  }
  if (state !== 'existing' && step === undefined) return `IDE: ${label} is "${state}" and needs a "step" key.`;
  const text = clean(value.label, MAX_LABEL) ?? '';
  return step === undefined ? { from, to, label: text, state } : { from, to, label: text, state, step };
}

const list = (paths: string[]): string => (paths.length <= LISTED ? paths.join(', ') : `${paths.slice(0, LISTED).join(', ')} and ${paths.length - LISTED} more`);

export function flowNotes(flow: PlanFlow | null, steps: PlanStep[], scope: FrozenScope): string[] {
  if (flow === null) return [];
  const flowFiles = [...new Set(flow.nodes.flatMap((node) => node.files.map((file) => file.path)))];
  const targetPaths = [...new Set(steps.flatMap((step) => step.targets.flatMap((target) => (target.path === undefined ? [] : [target.path]))))];
  const inScope = (file: string): boolean => scope.paths.includes(file) || scope.globs.some((glob) => globMatches(file, glob));
  const unplanned = flowFiles.filter((file) => !inScope(file));
  const unshown = targetPaths.filter((target) => !flowFiles.some((file) => file === target || file.startsWith(`${target}/`)));
  const notes: string[] = [];
  if (unplanned.length > 0) notes.push(`the flow lists ${list(unplanned)}, which no step targets`);
  if (unshown.length > 0) notes.push(`${list(unshown)} ${unshown.length === 1 ? 'is a step target' : 'are step targets'} that no flow node lists`);
  return notes;
}
