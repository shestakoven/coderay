import type { C4Container, GatePromptView, MapSnapshot, PlanStepView, PlanView, StepStatus, TargetOp } from '@ide/protocol';

export interface PlanState {
  plans: PlanView[];
  prompts: GatePromptView[];
}

export type PlanAction = { type: 'plans'; plans: PlanView[] } | { type: 'prompts'; prompts: GatePromptView[] };

export const initialPlanState: PlanState = { plans: [], prompts: [] };

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  return action.type === 'plans' ? { ...state, plans: action.plans } : { ...state, prompts: action.prompts };
}

export function planOnMap(plans: PlanView[]): PlanView | null {
  const latest = plans.at(-1);
  if (!latest) return null;
  const versions = plans.filter((plan) => plan.id === latest.id);
  return versions.findLast((plan) => plan.status === 'proposed') ?? versions.findLast((plan) => plan.status === 'approved') ?? latest;
}

export const drawsOverlay = (plan: PlanView | null): boolean => plan !== null && (plan.status === 'proposed' || plan.status === 'approved');
export const waitsForUser = (plan: PlanView | null): boolean => plan?.status === 'proposed';
export const panelOpenByDefault = (plan: PlanView): boolean => plan.status === 'proposed';
export const pendingPrompts = (prompts: GatePromptView[]): GatePromptView[] => prompts.filter((prompt) => prompt.status === 'pending');

export function planTitle(plan: PlanView): string {
  const base = `Plan v${plan.version}`;
  if (plan.status === 'proposed') return `${base} · waiting for you`;
  if (plan.status === 'changes-requested') return `${base} · changes requested`;
  if (plan.status !== 'approved') return `${base} · ${plan.status}`;
  const active = plan.steps.findIndex((step) => step.status === 'active');
  if (active !== -1) return `${base} · step ${active + 1}/${plan.steps.length}`;
  return plan.approvedBy === 'auto' ? `${base} · approved automatically` : `${base} · approved`;
}

export interface StepMark {
  n: number;
  status: StepStatus;
}

export interface ComponentMark {
  steps: StepMark[];
  files: Set<string>;
  creates: number;
  whole: boolean;
}

export interface Marks {
  components: Map<string, ComponentMark>;
  files: Map<string, StepMark[]>;
  ghosts: { path: string; componentId: string; step: StepMark }[];
  other: { path: string; op: TargetOp; step: number }[];
  stepComponents: string[][];
}

export const EMPTY_MARKS: Marks = { components: new Map(), files: new Map(), ghosts: [], other: [], stepComponents: [] };

export function dimsNode(marks: Marks, dimOthers: boolean, nodeId: string, componentId: string): boolean {
  if (!dimOthers || marks.components.has(componentId)) return false;
  return !marks.files.has(nodeId.startsWith('new:') ? nodeId.slice('new:'.length) : nodeId);
}

function addStep(list: StepMark[], mark: StepMark): void {
  if (!list.some((existing) => existing.n === mark.n)) list.push(mark);
  list.sort((a, b) => a.n - b.n);
}

export type ClassifiedTarget =
  | { kind: 'component'; op: TargetOp; componentId: string }
  | { kind: 'directory'; op: TargetOp; path: string; componentIds: string[] }
  | { kind: 'file'; op: TargetOp; path: string; owner: string }
  | { kind: 'other'; op: TargetOp; path: string };

export function classifyTargets(step: PlanStepView, plan: PlanView, snapshot: MapSnapshot | null): ClassifiedTarget[] {
  const known = new Set(snapshot?.components.map((component) => component.id));
  return step.targets.map((target): ClassifiedTarget => {
    if (target.componentId !== undefined) return { kind: 'component', op: target.op, componentId: target.componentId };
    const path = target.path as string;
    // owners has no entry for a directory target.
    if (!Object.hasOwn(plan.owners, path)) {
      const componentIds = (snapshot?.components ?? []).filter((component) => component.files.some((file) => file.startsWith(`${path}/`))).map((component) => component.id);
      return { kind: 'directory', op: target.op, path, componentIds };
    }
    const owner = plan.owners[path] ?? null;
    if (owner === null || (snapshot !== null && !known.has(owner))) return { kind: 'other', op: target.op, path };
    return { kind: 'file', op: target.op, path, owner };
  });
}

export function planMarks(plan: PlanView | null, snapshot: MapSnapshot | null): Marks {
  if (!plan || !snapshot || !drawsOverlay(plan)) return EMPTY_MARKS;
  const byId = new Map(snapshot.components.map((component) => [component.id, component]));
  const indexed = new Set(snapshot.files.map((file) => file.path));
  const marks: Marks = { components: new Map(), files: new Map(), ghosts: [], other: [], stepComponents: [] };
  const componentMark = (id: string): ComponentMark => {
    let mark = marks.components.get(id);
    if (!mark) {
      mark = { steps: [], files: new Set(), creates: 0, whole: false };
      marks.components.set(id, mark);
    }
    return mark;
  };
  plan.steps.forEach((step, index) => {
    const stepMark: StepMark = { n: index + 1, status: step.status };
    const touched = new Set<string>();
    for (const target of classifyTargets(step, plan, snapshot)) {
      if (target.kind === 'component') {
        const mark = componentMark(target.componentId);
        addStep(mark.steps, stepMark);
        mark.whole = true;
        for (const path of byId.get(target.componentId)?.files ?? []) mark.files.add(path);
        touched.add(target.componentId);
      } else if (target.kind === 'directory') {
        for (const id of target.componentIds) {
          const mark = componentMark(id);
          addStep(mark.steps, stepMark);
          for (const file of byId.get(id)?.files ?? []) if (file.startsWith(`${target.path}/`)) mark.files.add(file);
          touched.add(id);
        }
        if (target.componentIds.length === 0) marks.other.push({ path: target.path, op: target.op, step: stepMark.n });
      } else if (target.kind === 'other') {
        marks.other.push({ path: target.path, op: target.op, step: stepMark.n });
        const fileSteps = marks.files.get(target.path) ?? [];
        addStep(fileSteps, stepMark);
        marks.files.set(target.path, fileSteps);
      } else {
        const mark = componentMark(target.owner);
        addStep(mark.steps, stepMark);
        mark.files.add(target.path);
        touched.add(target.owner);
        const fileSteps = marks.files.get(target.path) ?? [];
        addStep(fileSteps, stepMark);
        marks.files.set(target.path, fileSteps);
        if (target.op === 'create' && !indexed.has(target.path) && !marks.ghosts.some((ghost) => ghost.path === target.path)) {
          mark.creates += 1;
          marks.ghosts.push({ path: target.path, componentId: target.owner, step: stepMark });
        }
      }
    }
    marks.stepComponents.push([...touched]);
  });
  return marks;
}

export interface ContainerMark {
  steps: StepMark[];
  components: number;
  files: number;
}

export function containerMark(containers: C4Container[], marks: Marks): ContainerMark | null {
  const steps: StepMark[] = [];
  const components = new Set<string>();
  const files = new Set<string>();
  for (const container of containers) {
    for (const component of container.components) {
      const mark = marks.components.get(component.id);
      if (!mark) continue;
      components.add(component.id);
      for (const step of mark.steps) addStep(steps, { ...step });
      for (const file of mark.files) files.add(file);
    }
  }
  return components.size === 0 ? null : { steps, components: components.size, files: files.size };
}

export const circled = (n: number): string => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);

export const badgeText = (step: StepMark): string => (step.status === 'done' ? `✓${step.n}` : circled(step.n));
