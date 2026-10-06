import type { ChangeView, HistoryView, PlanView, SummaryView } from '@ide/protocol';
import { latestPlanVersion } from './history-state';

export interface ReviewFile {
  path: string;
  ids: string[];
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
}

export interface ReviewGroup {
  key: string;
  title: string;
  outOfPlan: boolean;
  summary: SummaryView | null;
  files: ReviewFile[];
  added: number;
  removed: number;
}

const byAgent = (change: ChangeView): boolean => change.origin === 'agent' || change.origin === 'agent-tool';

// One row per file: the first "before" and the last "after" give the net diff.
function files(changes: ChangeView[]): ReviewFile[] {
  const byPath = new Map<string, ChangeView[]>();
  for (const change of [...changes].sort((a, b) => a.at - b.at)) byPath.set(change.path, [...(byPath.get(change.path) ?? []), change]);
  return [...byPath].map(([path, own]) => ({
    path,
    ids: own.map((change) => change.id),
    before: own[0]!.beforeHash,
    after: own[own.length - 1]!.afterHash,
    added: own.reduce((sum, change) => sum + (change.added ?? 0), 0),
    removed: own.reduce((sum, change) => sum + (change.removed ?? 0), 0),
  }));
}

const group = (key: string, title: string, outOfPlan: boolean, summary: SummaryView | null, changes: ChangeView[]): ReviewGroup => {
  const rows = files(changes);
  return { key, title, outOfPlan, summary, files: rows, added: rows.reduce((sum, row) => sum + row.added, 0), removed: rows.reduce((sum, row) => sum + row.removed, 0) };
};

// Out-of-plan changes come first: they are the ones that need a human decision. External changes (made outside the IDE's agent) come last.
export function reviewGroups(history: HistoryView, plans: PlanView[]): ReviewGroup[] {
  // 'recorded' marks files the gate does not enforce: gitignored, git internals and harness paths. What git wrote is not the agent's work.
  const reviewable = history.changes.filter((change) => change.enforcement === 'enforced' && change.resolution !== 'reverted' && change.origin !== 'git');
  const agentChanges = reviewable.filter(byAgent);
  const claimed = new Set<string>();
  const stepGroups: ReviewGroup[] = [];
  const planIds = [...new Set(plans.map((plan) => plan.id))];
  for (const planId of planIds) {
    const plan = latestPlanVersion(plans, planId);
    if (!plan) continue;
    for (const step of [...plan.steps].sort((a, b) => a.order - b.order)) {
      const own = agentChanges.filter((change) => change.planId === plan.id && change.stepKey === step.key && !change.outOfPlan);
      if (own.length === 0) continue;
      own.forEach((change) => claimed.add(change.id));
      const summary = history.summaries.find((s) => s.scope === 'step' && s.ref === `${plan.id}/${step.key}`) ?? null;
      stepGroups.push(group(`${plan.id}/${step.key}`, step.title, false, summary, own));
    }
  }
  const unclaimed = reviewable.filter((change) => !claimed.has(change.id) && change.origin !== 'ide');
  const outside = unclaimed.filter((change) => change.origin !== 'human');
  const external = unclaimed.filter((change) => change.origin === 'human');
  return [
    ...(outside.length > 0 ? [group('outside', 'Outside the plan', true, null, outside)] : []),
    ...stepGroups,
    ...(external.length > 0 ? [group('external', 'External changes', false, null, external)] : []),
  ];
}

export const reviewCount = (groups: ReviewGroup[]): number => new Set(groups.flatMap((g) => g.files.map((file) => file.path))).size;
