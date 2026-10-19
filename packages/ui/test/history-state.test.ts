import { describe, expect, it } from 'vitest';
import type { ChangeView, CheckpointView, HistoryView, PlanView, WatchdogEventView } from '@ide/protocol';
import {
  changesByStep, chatFilterIds, historyReducer, initialHistoryState, isFollowUp, nodeChanges, pendingEvent, timelineItems, type HistoryState,
} from '../src/history/history-state';
import { demoSnapshot } from './snapshot';

const view = (o: Partial<HistoryView> = {}): HistoryView => ({ changes: [], events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [], ...o });
let seq = 0;
const change = (o: Partial<ChangeView> = {}): ChangeView => ({
  id: `c${++seq}`, path: 'src/api/a.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false,
  toolUseIds: [], planId: null, planVersion: null, stepKey: null, eventId: null, resolution: null, added: 0, removed: 0, stored: true,
  unreadable: false, beforeMode: null, ...o,
});
const event = (o: Partial<WatchdogEventView> = {}): WatchdogEventView => ({
  id: `e${++seq}`, kind: 'watchdog', mode: 'B', phase: 'pending', resolution: 'pending', changes: [], toolCalls: [], interrupted: false, paused: false,
  runningSubagents: 0, backgroundShell: false, unknownOrigin: false, snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: 1,
  resolvedAt: null, ...o,
});
const plan = (o: Partial<PlanView> = {}): PlanView => ({
  id: 'p1', version: 1, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [
    { key: 'a', order: 1, title: 'API', rationale: 'why a', status: 'done', targets: [] },
    { key: 'b', order: 2, title: 'DB', rationale: '', status: 'active', targets: [] },
  ],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2, ...o,
});
const checkpoint = (o: Partial<CheckpointView> = {}): CheckpointView => ({ planId: 'p1', stepKey: 'a', cycle: 0, before: 1, after: 2, startedAt: 1, sealedAt: 2, ...o });
const withHistory = (history: HistoryView): HistoryState => ({ ...initialHistoryState, history });

describe('historyReducer', () => {
  it('upserts patched arrays by id and replaces on snapshot', () => {
    const c1 = change({ id: 'x', added: 1 });
    let state = historyReducer(initialHistoryState, { type: 'snapshot', history: view({ changes: [c1, change({ id: 'y' })], checkpoints: [checkpoint(), checkpoint({ cycle: 1, after: null })], summaries: [{ key: 'k', scope: 'step', ref: 'r', text: 'old', pending: true }] }) });
    state = historyReducer(state, {
      type: 'patch',
      patch: { changes: [{ ...c1, added: 9 }, change({ id: 'z' })], checkpoints: [checkpoint({ cycle: 1, after: 7 })], summaries: [{ key: 'k', scope: 'step', ref: 'r', text: 'new', pending: false }] },
    });
    expect(state.history.changes.map((c) => [c.id, c.added])).toEqual([['x', 9], ['y', 0], ['z', 0]]);
    expect(state.history.checkpoints.map((c) => [c.cycle, c.after])).toEqual([[0, 2], [1, 7]]);
    expect(state.history.summaries).toEqual([{ key: 'k', scope: 'step', ref: 'r', text: 'new', pending: false }]);
    expect(state.history.events).toEqual([]);
    state = historyReducer(state, { type: 'snapshot', history: view() });
    expect(state.history.changes).toEqual([]);
  });

  it('stores a result by request id and forgets it', () => {
    let state = historyReducer(initialHistoryState, { type: 'result', requestId: 'r1', error: 'boom' });
    state = historyReducer(state, { type: 'result', requestId: 'r2', error: null });
    expect(state.results.r1).toMatchObject({ error: 'boom' });
    state = historyReducer(state, { type: 'forget', requestId: 'r1' });
    expect(Object.keys(state.results)).toEqual(['r2']);
  });

  it('keeps the graph of a result', () => {
    const graph = { parts: [], links: [], partial: null };
    const next = historyReducer(initialHistoryState, { type: 'result', requestId: 'r1', error: null, graph });
    expect(next.results.r1).toEqual({ error: null, diff: undefined, preview: undefined, graph });
  });
});

describe('pendingEvent', () => {
  it('finds the oldest open watchdog event', () => {
    const h = view({ events: [event({ id: 'late', ts: 9 }), event({ id: 'done', phase: 'resolved', ts: 1 }), event({ id: 'early', phase: 'collecting', ts: 4 })] });
    expect(pendingEvent(h)?.id).toBe('early');
    expect(pendingEvent(view({ events: [event({ phase: 'resolved' })] }))).toBeNull();
  });
});

describe('nodeChanges', () => {
  it('sums the latest change of each file for a component node', () => {
    const h = view({ changes: [change({ path: 'src/api/a.ts', added: 5, removed: 1, at: 1 }), change({ path: 'src/api/a.ts', added: 2, removed: 0, at: 2 }), change({ path: 'src/api/b.ts', added: 1, removed: 1, at: 3 })] });
    expect(nodeChanges(h, demoSnapshot(), 'folder:src/api')).toMatchObject({ files: ['src/api/a.ts', 'src/api/b.ts'], added: 3, removed: 1, states: ['modified'] });
  });

  it('resolves a file node to itself and ignores other files', () => {
    const h = view({ changes: [change({ path: 'src/api/a.ts', added: 4 }), change({ path: 'src/db/c.ts', added: 7 })] });
    const node = nodeChanges(h, demoSnapshot(), 'src/api/a.ts');
    expect(node.files).toEqual(['src/api/a.ts']);
    expect(node.added).toBe(4);
  });

  it('marks an unresolved out-of-plan change and a pending event file as out-of-plan', () => {
    const open = view({ changes: [change({ path: 'src/db/c.ts', outOfPlan: true })] });
    expect(nodeChanges(open, demoSnapshot(), 'folder:src/db').states).toEqual(['modified', 'out-of-plan']);
    const settled = view({ changes: [change({ path: 'src/db/c.ts', outOfPlan: true, resolution: 'kept' })] });
    expect(nodeChanges(settled, demoSnapshot(), 'folder:src/db').states).toEqual(['modified']);
    const pending = view({ events: [event({ changes: [change({ path: 'src/db/c.ts' })] })] });
    expect(nodeChanges(pending, demoSnapshot(), 'folder:src/db')).toMatchObject({ states: ['out-of-plan'], files: ['src/db/c.ts'] });
    const resolved = view({ events: [event({ phase: 'resolved', changes: [change({ path: 'src/db/c.ts' })] })] });
    expect(nodeChanges(resolved, demoSnapshot(), 'folder:src/db').states).toEqual([]);
  });

  it('marks a file changed under the active step as in-progress', () => {
    const changes = [change({ path: 'src/api/a.ts', planId: 'p1', stepKey: 'b' })];
    const active = view({ changes, checkpoints: [checkpoint({ stepKey: 'b', sealedAt: null, after: null })] });
    expect(nodeChanges(active, demoSnapshot(), 'folder:src/api').states).toEqual(['modified', 'in-progress']);
    const sealed = view({ changes, checkpoints: [checkpoint({ stepKey: 'b' })] });
    expect(nodeChanges(sealed, demoSnapshot(), 'folder:src/api').states).toEqual(['modified']);
    const later = view({ changes: [...changes, change({ path: 'src/api/a.ts', at: 5 })], checkpoints: [checkpoint({ stepKey: 'b', sealedAt: null })] });
    expect(nodeChanges(later, demoSnapshot(), 'folder:src/api').states).toEqual(['modified']);
  });

  it('returns no states for an untouched node', () => {
    const h = view({ changes: [change({ path: 'src/db/c.ts' })] });
    expect(nodeChanges(h, demoSnapshot(), 'folder:src/api')).toMatchObject({ files: [], added: 0, removed: 0, states: [], changes: [] });
  });
});

describe('changesByStep', () => {
  it('groups by step in plan order with the no-step group last', () => {
    const h = view({
      changes: [
        change({ id: 'h1', origin: 'human', planId: 'p1', stepKey: 'a', at: 1 }),
        change({ id: 'b1', origin: 'agent', planId: 'p1', stepKey: 'b', at: 2 }),
        change({ id: 'a1', origin: 'agent-tool', planId: 'p1', stepKey: 'a', at: 3 }),
        change({ id: 'n1', origin: 'agent', at: 4 }),
        change({ id: 'i1', origin: 'ide', at: 5 }),
        change({ id: 'u1', origin: 'unknown', planId: 'p1', stepKey: 'b', at: 6 }),
      ],
      summaries: [{ key: 'k', scope: 'step', ref: 'p1/a', text: 'did a', pending: false }],
    });
    const groups = changesByStep(h, [plan()], 'folder:src/api', demoSnapshot());
    expect(groups.map((g) => [g.stepKey, g.title, g.changes.map((c) => c.id)])).toEqual([
      ['a', 'API', ['a1']], ['b', 'DB', ['b1']], [null, 'No step', ['h1', 'n1', 'i1', 'u1']],
    ]);
    expect(groups[0]).toMatchObject({ rationale: 'why a', summary: { text: 'did a' } });
    expect(groups[1]).toMatchObject({ rationale: null, summary: null });
  });

  it('labels follow-ups, and shows each git call as one row after the rest', () => {
    const h = view({
      changes: [
        change({ id: 'f1', planId: 'p1', planVersion: 1, stepKey: null, at: 1 }),
        change({ id: 'o1', planId: 'p1', stepKey: null, outOfPlan: true, at: 2 }),
        change({ id: 'g1', origin: 'git', toolUseIds: ['t1'], at: 3 }),
        change({ id: 'g2', origin: 'git', path: 'src/api/b.ts', toolUseIds: ['t1'], at: 4 }),
      ],
    });
    const groups = changesByStep(h, [plan({ status: 'done' })], 'folder:src/api', demoSnapshot(), (id) => (id === 't1' ? 'git rebase main' : undefined));
    expect(groups.map((g) => [g.title, g.git, g.changes.map((c) => c.id)])).toEqual([
      ['Follow-ups', false, ['f1']], ['No step', false, ['o1']], ['git rebase main · 2 files', true, ['g1', 'g2']],
    ]);
  });
});

describe('Follow-ups', () => {
  it('hold a write with no step only when its own plan version is done or closed', () => {
    const stray = change({ planId: 'p1', planVersion: 1, stepKey: null });
    const verdict = (...plans: PlanView[]) => isFollowUp(stray, 'p1', plans);
    expect([
      verdict(plan({ status: 'done' })), verdict(plan({ status: 'closed' })),
      verdict(plan({ status: 'approved' })), verdict(plan({ status: 'superseded' }), plan({ version: 2, status: 'done' })),
      verdict(plan({ id: 'p2', status: 'done' })), verdict(),
    ]).toEqual([true, true, false, false, false, false]);
    const titles = (status: PlanView['status']) => changesByStep(view({ changes: [stray] }), [plan({ status })], 'folder:src/api', demoSnapshot()).map((g) => g.title);
    expect([titles('done'), titles('approved')]).toEqual([['Follow-ups'], ['No step']]);
  });
});

describe('chatFilterIds', () => {
  it('builds the chat filter from tool use ids', () => {
    const h = view({ changes: [change({ path: 'src/api/a.ts', toolUseIds: ['t1', 't2'] }), change({ path: 'src/api/b.ts', toolUseIds: ['t2', 't3'] }), change({ path: 'src/db/c.ts', toolUseIds: ['t9'] })] });
    expect([...chatFilterIds(h, 'folder:src/api', demoSnapshot())].sort()).toEqual(['t1', 't2', 't3']);
  });
});

describe('timelineItems', () => {
  it('merges steps, events, gate events and reverts in time order', () => {
    const h = view({
      changes: [change({ path: 'src/api/a.ts', planId: 'p1', stepKey: 'a' }), change({ path: 'src/api/b.ts', planId: 'p1', stepKey: 'a' })],
      checkpoints: [checkpoint({ startedAt: 10, sealedAt: 40 })],
      events: [event({ id: 'e9', ts: 30, resolution: 'reverted', phase: 'resolved', changes: [change({ path: 'src/db/c.ts' })] })],
      gateEvents: [
        { id: 'g1', kind: 'pre-execution', toolUseId: null, mode: 'B', targets: ['x.ts'], resolution: 'denied', ts: 20, resolvedAt: 21 },
        { id: 'g2', kind: 'watchdog', toolUseId: null, mode: 'B', targets: [], resolution: 'kept', ts: 25, resolvedAt: 26 },
      ],
      reverts: [{ id: 'r1', kind: 'watchdog', eventId: 'e9', planId: null, stepKey: null, changeIds: [], files: [{ path: 'src/db/c.ts', outcome: 'conflict', reason: null }], ts: 35, undoneAt: null }],
    });
    const items = timelineItems([plan()], h);
    expect(items.map((i) => [i.kind, i.at, i.tone])).toEqual([['gate', 20, 'error'], ['event', 30, 'warn'], ['revert', 35, 'warn'], ['step', 40, 'ok']]);
    expect(items[0]).toMatchObject({ label: 'Gate: denied', files: ['x.ts'] });
    expect(items[1]).toMatchObject({ files: ['src/db/c.ts'], ref: { eventId: 'e9' } });
    expect(items[3]).toMatchObject({ label: 'Step 1: API · 2 files', files: ['src/api/a.ts', 'src/api/b.ts'], ref: { planId: 'p1', stepKey: 'a' } });
  });
});
