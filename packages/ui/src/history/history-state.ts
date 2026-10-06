import type {
  ChangeView, CheckpointView, FileDiff, HistoryPatch, HistoryView, MapSnapshot, PlanView, RollbackPreview, SummaryView, WatchdogEventView,
} from '@ide/protocol';
import { projectPathOf } from './project-path';

export interface HistoryState {
  history: HistoryView;
  results: Record<string, { error: string | null; diff?: FileDiff; preview?: RollbackPreview }>;
}

export type HistoryAction =
  | { type: 'snapshot'; history: HistoryView }
  | { type: 'patch'; patch: HistoryPatch }
  | { type: 'result'; requestId: string; error: string | null; diff?: FileDiff; preview?: RollbackPreview }
  | { type: 'forget'; requestId: string };

const emptyHistory = (): HistoryView => ({ changes: [], events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [] });

export const initialHistoryState: HistoryState = { history: emptyHistory(), results: {} };

function upsert<T>(list: T[], incoming: T[] | undefined, keyOf: (item: T) => string): T[] {
  if (!incoming) return list;
  const next = [...list];
  const index = new Map(next.map((item, i) => [keyOf(item), i]));
  for (const item of incoming) {
    const at = index.get(keyOf(item));
    if (at === undefined) {
      index.set(keyOf(item), next.length);
      next.push(item);
    } else next[at] = item;
  }
  return next;
}

const byId = (item: { id: string }): string => item.id;
const checkpointKey = (c: CheckpointView): string => `${c.planId}\u0000${c.stepKey}\u0000${c.cycle}`;
const summaryKey = (s: SummaryView): string => s.key;

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, history: action.history };
    case 'patch': {
      const h = state.history;
      const p = action.patch;
      return {
        ...state,
        history: {
          changes: upsert(h.changes, p.changes, byId),
          events: upsert(h.events, p.events, byId),
          reverts: upsert(h.reverts, p.reverts, byId),
          checkpoints: upsert(h.checkpoints, p.checkpoints, checkpointKey),
          gateEvents: upsert(h.gateEvents, p.gateEvents, byId),
          summaries: upsert(h.summaries, p.summaries, summaryKey),
        },
      };
    }
    case 'result':
      return { ...state, results: { ...state.results, [action.requestId]: { error: action.error, diff: action.diff, preview: action.preview } } };
    case 'forget': {
      const { [action.requestId]: _gone, ...rest } = state.results;
      return { ...state, results: rest };
    }
  }
}

const isOpen = (e: WatchdogEventView): boolean => e.phase === 'pending' || e.phase === 'collecting';

export const pendingEvent = (h: HistoryView): WatchdogEventView | null =>
  h.events.filter(isOpen).reduce<WatchdogEventView | null>((oldest, e) => (oldest === null || e.ts < oldest.ts ? e : oldest), null);

export type NodeState = 'modified' | 'in-progress' | 'out-of-plan';

export const nodeStateClass = (states: NodeState[]): 'out-of-plan' | 'in-progress' | 'modified' | '' =>
  states.includes('out-of-plan') ? 'out-of-plan' : states.includes('in-progress') ? 'in-progress' : states.includes('modified') ? 'modified' : '';

export interface NodeChanges {
  files: string[];
  added: number;
  removed: number;
  states: NodeState[];
  changes: ChangeView[];
}

function nodeFiles(snapshot: MapSnapshot | null, nodeId: string): Set<string> {
  const component = snapshot?.components.find((c) => c.id === nodeId);
  return new Set(component ? component.files : [nodeId]);
}

function latestByPath(changes: ChangeView[]): Map<string, ChangeView> {
  const latest = new Map<string, ChangeView>();
  for (const change of changes) {
    const seen = latest.get(change.path);
    if (!seen || change.at >= seen.at) latest.set(change.path, change);
  }
  return latest;
}

const activeStep = (h: HistoryView, change: ChangeView): boolean =>
  change.planId !== null && change.stepKey !== null &&
  h.checkpoints.some((c) => c.planId === change.planId && c.stepKey === change.stepKey && c.sealedAt === null);

function ownChanges(h: HistoryView, snapshot: MapSnapshot | null, nodeId: string): ChangeView[] {
  const files = nodeFiles(snapshot, nodeId);
  const toProject = projectPathOf(snapshot);
  return h.changes.flatMap((c) => {
    const path = toProject(c.path);
    return files.has(path) ? [path === c.path ? c : { ...c, path }] : [];
  });
}

export function nodeChanges(h: HistoryView, snapshot: MapSnapshot | null, nodeId: string): NodeChanges {
  const files = nodeFiles(snapshot, nodeId);
  const changes = ownChanges(h, snapshot, nodeId);
  const latest = latestByPath(changes);
  const toProject = projectPathOf(snapshot);
  const pendingPaths = new Set(h.events.filter(isOpen).flatMap((e) => e.changes.map((c) => toProject(c.path))));
  const touched = [...files].filter((path) => latest.has(path) || pendingPaths.has(path)).sort();
  let added = 0;
  let removed = 0;
  for (const change of latest.values()) {
    added += change.added ?? 0;
    removed += change.removed ?? 0;
  }
  const states: NodeState[] = [];
  if (changes.length > 0) states.push('modified');
  if ([...latest.values()].some((c) => activeStep(h, c))) states.push('in-progress');
  if (changes.some((c) => c.outOfPlan && c.resolution === null) || [...pendingPaths].some((path) => files.has(path))) states.push('out-of-plan');
  return { files: touched, added, removed, states, changes: [...changes].sort((a, b) => a.at - b.at) };
}

export function changeIndex(h: HistoryView, snapshot: MapSnapshot | null): Map<string, NodeChanges> {
  const index = new Map<string, NodeChanges>();
  if (h.changes.length === 0 && h.events.length === 0) return index;
  const toProject = projectPathOf(snapshot);
  const ids = [...(snapshot?.components.map((c) => c.id) ?? []), ...new Set(h.changes.map((c) => toProject(c.path)))];
  for (const id of ids) {
    const found = nodeChanges(h, snapshot, id);
    if (found.files.length > 0 || found.states.length > 0) index.set(id, found);
  }
  return index;
}

export interface StepGroup {
  key: string;
  stepKey: string | null;
  title: string;
  rationale: string | null;
  summary: SummaryView | null;
  changes: ChangeView[];
  git: boolean;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const byAgent = (change: ChangeView): boolean => change.origin === 'agent' || change.origin === 'agent-tool';

// A write the plan covers, made once its steps ran out: stamped with the plan but with no step.
export const isFollowUp = (change: ChangeView, planId: string): boolean =>
  byAgent(change) && change.planId === planId && change.stepKey === null && !change.outOfPlan;

// What git wrote, one entry per git call.
function gitCalls(changes: ChangeView[]): Map<string, ChangeView[]> {
  const byCall = new Map<string, ChangeView[]>();
  for (const change of changes) {
    const call = change.toolUseIds[0];
    if (change.origin === 'git' && change.enforcement === 'enforced' && call !== undefined) byCall.set(call, [...(byCall.get(call) ?? []), change]);
  }
  return byCall;
}

const gitLabel = (command: string | undefined, changes: ChangeView[]): string => `${command ?? 'git'} · ${plural(new Set(changes.map((c) => c.path)).size, 'file')}`;

const latestVersions = (plans: PlanView[]): Map<string, PlanView> => {
  const byPlan = new Map<string, PlanView>();
  for (const plan of plans) {
    const seen = byPlan.get(plan.id);
    if (!seen || plan.version >= seen.version) byPlan.set(plan.id, plan);
  }
  return byPlan;
};

export const latestPlanVersion = (plans: PlanView[], planId: string): PlanView | null =>
  latestVersions(plans.filter((plan) => plan.id === planId)).get(planId) ?? null;

export function changesByStep(
  h: HistoryView, plans: PlanView[], nodeId: string, snapshot: MapSnapshot | null, commandOf: (toolUseId: string) => string | undefined = () => undefined,
): StepGroup[] {
  const changes = nodeChanges(h, snapshot, nodeId).changes;
  const latest = latestVersions(plans);
  const stepOf = (change: ChangeView) =>
    change.planId !== null && change.stepKey !== null && byAgent(change)
      ? latest.get(change.planId)?.steps.find((s) => s.key === change.stepKey)
      : undefined;
  const groups: StepGroup[] = [];
  const none = { stepKey: null, rationale: null, summary: null, git: false };
  for (const plan of latest.values()) {
    for (const step of [...plan.steps].sort((a, b) => a.order - b.order)) {
      const own = changes.filter((c) => c.planId === plan.id && stepOf(c)?.key === step.key);
      if (own.length === 0) continue;
      const summary = h.summaries.find((s) => s.scope === 'step' && s.ref === `${plan.id}/${step.key}`) ?? null;
      groups.push({ key: `${plan.id}/${step.key}`, stepKey: step.key, title: step.title, rationale: step.rationale || null, summary, changes: own, git: false });
    }
    const followUps = changes.filter((c) => isFollowUp(c, plan.id));
    if (followUps.length > 0) groups.push({ ...none, key: `${plan.id}/`, title: 'Follow-ups', changes: followUps });
  }
  const calls = [...gitCalls(changes)].map(([call, own]): StepGroup => ({ ...none, key: `git:${call}`, title: gitLabel(commandOf(call), own), changes: own, git: true }));
  const grouped = new Set([...groups, ...calls].flatMap((group) => group.changes.map((c) => c.id)));
  const rest = changes.filter((c) => !grouped.has(c.id));
  if (rest.length > 0) groups.push({ ...none, key: 'none', title: 'No step', changes: rest });
  return [...groups, ...calls];
}

export const chatFilterIds = (h: HistoryView, nodeId: string, snapshot: MapSnapshot | null): Set<string> =>
  new Set(ownChanges(h, snapshot, nodeId).flatMap((c) => c.toolUseIds));

export type TimelineKind = 'step' | 'event' | 'revert' | 'gate' | 'git';
export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  at: number;
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  files: string[];
  ref: { planId?: string; stepKey?: string; eventId?: string; revertId?: string };
}

const EVENT_TONE: Record<WatchdogEventView['resolution'], TimelineItem['tone']> = {
  pending: 'warn', kept: 'ok', reverted: 'warn', 'plan-expanded': 'ok', 'relabeled-human': 'ok', flagged: 'error', mixed: 'warn', dropped: 'muted',
};
const GATE_TONE: Record<string, TimelineItem['tone']> = { 'allowed-once': 'ok', 'plan-expanded': 'ok', denied: 'error', flagged: 'warn' };

export function timelineItems(plans: PlanView[], h: HistoryView, commandOf: (toolUseId: string) => string | undefined = () => undefined): TimelineItem[] {
  const items: TimelineItem[] = [];
  const latest = latestVersions(plans);
  for (const [call, own] of gitCalls(h.changes)) {
    const files = [...new Set(own.map((c) => c.path))].sort();
    items.push({ id: `git:${call}`, kind: 'git', at: Math.min(...own.map((c) => c.at)), label: gitLabel(commandOf(call), own), tone: 'muted', files, ref: {} });
  }
  for (const checkpoint of h.checkpoints) {
    const plan = latest.get(checkpoint.planId);
    const step = plan?.steps.find((s) => s.key === checkpoint.stepKey);
    const files = [...new Set(h.changes.filter((c) => c.planId === checkpoint.planId && c.stepKey === checkpoint.stepKey).map((c) => c.path))].sort();
    items.push({
      id: `step:${checkpoint.planId}/${checkpoint.stepKey}/${checkpoint.cycle}`, kind: 'step', at: checkpoint.sealedAt ?? checkpoint.startedAt,
      label: `${step ? `Step ${step.order}: ${step.title}` : `Step ${checkpoint.stepKey}`} · ${plural(files.length, 'file')}`,
      tone: checkpoint.sealedAt === null ? 'muted' : 'ok', files, ref: { planId: checkpoint.planId, stepKey: checkpoint.stepKey },
    });
  }
  for (const event of h.events) {
    const files = [...new Set(event.changes.map((c) => c.path))].sort();
    items.push({
      id: `event:${event.id}`, kind: 'event', at: event.ts,
      label: `${event.kind === 'fail-open' ? 'Fail-open' : 'Watchdog'}: ${plural(files.length, 'file')} ${event.resolution}`,
      tone: EVENT_TONE[event.resolution], files, ref: { eventId: event.id },
    });
  }
  for (const gate of h.gateEvents.filter((g) => g.kind === 'pre-execution')) {
    items.push({
      id: `gate:${gate.id}`, kind: 'gate', at: gate.ts, label: `Gate: ${gate.resolution.replace(/-/g, ' ')}`,
      tone: GATE_TONE[gate.resolution] ?? 'muted', files: [...gate.targets], ref: { eventId: gate.id },
    });
  }
  for (const revert of h.reverts) {
    const conflicts = revert.files.filter((f) => f.outcome === 'conflict' || f.outcome === 'not-rolled-back').length;
    items.push({
      id: `revert:${revert.id}`, kind: 'revert', at: revert.ts,
      label: `${revert.undoneAt === null ? 'Reverted' : 'Revert undone'}: ${plural(revert.files.length, 'file')}`,
      tone: revert.undoneAt !== null ? 'muted' : conflicts > 0 ? 'warn' : 'ok', files: revert.files.map((f) => f.path),
      ref: { revertId: revert.id, eventId: revert.eventId ?? undefined, planId: revert.planId ?? undefined, stepKey: revert.stepKey ?? undefined },
    });
  }
  return items.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
