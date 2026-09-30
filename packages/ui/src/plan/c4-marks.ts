import type { C4Container, C4Model } from '@ide/protocol';
import { OWN_COMPONENT_CARDS } from '../c4/c4-graph';
import { containerMark, type Marks, type StepMark } from './plan-state';

export interface NodePlan {
  steps: StepMark[];
  line: string;
  creates: number;
}

export interface C4NodeRef {
  id: string;
  type?: string;
  parentId?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ownCards = (container: C4Container): string[] =>
  container.components.filter((component) => component.near > 0).slice(0, OWN_COMPONENT_CARDS).map((component) => component.id);

// The card of a component inside its open container: its own card, or the Libraries card it is folded into.
export const componentCard = (container: C4Container, componentId: string): string =>
  ownCards(container).includes(componentId) ? `${container.id}/${componentId}` : `${container.id}/shared`;

function summary(containers: C4Container[], marks: Marks): NodePlan | null {
  const mark = containerMark(containers, marks);
  return mark ? { steps: mark.steps, line: `plan: ${plural(mark.components, 'component')} · ${plural(mark.files, 'file')}`, creates: 0 } : null;
}

export function c4NodePlans(nodes: C4NodeRef[], model: C4Model, marks: Marks): Map<string, NodePlan> {
  const plans = new Map<string, NodePlan>();
  if (marks.components.size === 0) return plans;
  const containers = new Map(model.containers.map((container) => [container.id, container]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    let plan: NodePlan | null = null;
    if (node.type === 'container') {
      const container = containers.get(node.id);
      plan = container ? summary([container], marks) : null;
    } else if (node.type === 'c4group') {
      plan = summary(model.containers.filter((container) => container.group === node.id), marks);
    } else if (node.type === 'component') {
      const componentId = node.id.startsWith('root:') ? node.id.slice('root:'.length) : node.id.slice(node.id.indexOf('/') + 1);
      const mark = marks.components.get(componentId);
      if (mark) plan = { steps: mark.steps, creates: mark.creates, line: mark.whole ? 'whole component in scope' : `${plural(mark.files.size, 'file')} in scope` };
    } else if (node.type === 'shared') {
      const container = containers.get(node.parentId ?? '');
      if (container) {
        const folded = container.components.filter((component) => !nodeIds.has(`${container.id}/${component.id}`));
        plan = summary([{ ...container, components: folded }], marks);
      }
    }
    if (plan) plans.set(node.id, plan);
  }
  return plans;
}

export function locateComponent(
  componentId: string,
  model: C4Model,
  view: { expanded: string | null; root: string | null; nodeIds: Set<string> },
): { container: string | null; node: string | null } {
  if (view.root && view.nodeIds.has(`root:${componentId}`)) return { container: view.root, node: `root:${componentId}` };
  const holders = model.containers
    .flatMap((container) => {
      const held = container.components.find((component) => component.id === componentId);
      return held ? [{ container, near: held.near }] : [];
    })
    .sort((a, b) => b.near - a.near || (a.container.group ? 1 : 0) - (b.container.group ? 1 : 0));
  const open = holders.find((holder) => holder.container.id === view.expanded);
  if (open) {
    const card = componentCard(open.container, componentId);
    return { container: open.container.id, node: view.nodeIds.has(card) ? card : open.container.id };
  }
  const best = holders[0]?.container;
  if (!best) return { container: null, node: null };
  const node = view.nodeIds.has(best.id) ? best.id : best.group && view.nodeIds.has(best.group) ? best.group : null;
  return { container: best.id, node };
}
