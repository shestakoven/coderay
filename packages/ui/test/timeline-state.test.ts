import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type PlanStepView, type PlanView, type RollbackPreview, type TaskView, type TurnView } from '@ide/protocol';
import { chatReducer, initialChatState, type ChatState } from '../src/chat/chat-state';
import { canConfirmRollback, canOfferRollback, rollbackReducer, type RollbackState } from '../src/history/timeline-state';
import { timelineSummary } from '../src/history/Timeline';
import { latestPlanVersion, timelineItems } from '../src/history/history-state';

const preview = (o: Partial<RollbackPreview> = {}): RollbackPreview => ({
  planId: 'p1', stepKey: 'a', allowed: true, reason: null, autoFiles: ['auto.ts'], confirmFiles: ['ask.ts', 'ask2.ts'], notRolledBack: [], conflicts: [], ...o,
});
const open = (): RollbackState => rollbackReducer(null, { type: 'open', planId: 'p1', stepKey: 'a', requestId: 'r1' })!;

describe('rollbackReducer', () => {
  it('walks the dialog through preview, confirmation and result', () => {
    const s1 = open();
    expect([s1.stage, s1.requestId, s1.preview]).toEqual(['previewing', 'r1', null]);
    const s2 = rollbackReducer(s1, { type: 'preview', preview: preview() })!;
    expect([s2.stage, s2.confirm.size, s2.preview?.autoFiles]).toEqual(['confirming', 0, ['auto.ts']]);
    const s3 = rollbackReducer(rollbackReducer(s2, { type: 'toggle', path: 'ask.ts' }), { type: 'run', requestId: 'r2' })!;
    expect([s3.stage, s3.requestId, [...s3.confirm]]).toEqual(['running', 'r2', ['ask.ts']]);
    expect(rollbackReducer(s3, { type: 'result', error: null })).toMatchObject({ stage: 'done', error: null });
    expect(rollbackReducer(s3, { type: 'result', error: 'boom' })).toMatchObject({ stage: 'error', error: 'boom' });
    expect(rollbackReducer(s3, { type: 'close' })).toBeNull();
  });

  it('toggles only paths that need confirmation, and toggles them back off', () => {
    const s = rollbackReducer(open(), { type: 'preview', preview: preview() })!;
    expect(rollbackReducer(s, { type: 'toggle', path: 'auto.ts' })).toBe(s);
    expect(rollbackReducer(s, { type: 'toggle', path: 'nope.ts' })).toBe(s);
    const on = rollbackReducer(s, { type: 'toggle', path: 'ask.ts' })!;
    expect([...on.confirm]).toEqual(['ask.ts']);
    expect(rollbackReducer(on, { type: 'toggle', path: 'ask.ts' })!.confirm.size).toBe(0);
  });

  it('ignores actions that do not fit the stage', () => {
    const previewing = open();
    expect(rollbackReducer(previewing, { type: 'run', requestId: 'x' })).toBe(previewing);
    expect(rollbackReducer(previewing, { type: 'toggle', path: 'ask.ts' })).toBe(previewing);
    expect(rollbackReducer(null, { type: 'preview', preview: preview() })).toBeNull();
  });

  it('turns a failed preview into an error', () => {
    expect(rollbackReducer(open(), { type: 'result', error: 'no' })).toMatchObject({ stage: 'error', error: 'no' });
  });
});

describe('canConfirmRollback', () => {
  const at = (p: RollbackPreview): RollbackState => rollbackReducer(open(), { type: 'preview', preview: p })!;
  it.each([
    ['rollable files', preview(), true],
    ['not allowed', preview({ allowed: false, reason: 'busy' }), false],
    ['conflicts only', preview({ autoFiles: [], confirmFiles: [], conflicts: [{ path: 'c.ts', reason: 'edited' }] }), false],
    ['auto files plus conflicts', preview({ confirmFiles: [], conflicts: [{ path: 'c.ts', reason: 'edited' }] }), true],
  ])('%s → %s', (_name, p, expected) => {
    expect(canConfirmRollback(at(p))).toBe(expected);
  });
  it('is false outside the confirming stage', () => {
    expect(canConfirmRollback(open())).toBe(false);
  });
});

const session = { id: 's1', engine: 'claude' as const, engineSessionId: 'c', status: 'running' as const, model: 'm', modelChoice: null, effort: null, cliVersion: '1', permissionMode: 'default', startedAt: 1 };
const turn = (closedAt: number | null): TurnView => ({ id: 't', kind: 'user', openedAt: 1, startedAt: 2, closedAt, resultSubtype: closedAt ? 'success' : null });
const task = (endedAt: number | null): TaskView => ({ id: 'k', toolUseId: null, kind: 'subagent', description: 'd', status: 'running', startedAt: 1, endedAt });
const chatWith = (turns: TurnView[], tasks: TaskView[]): ChatState =>
  chatReducer(initialChatState, { type: 'snapshot', state: { session, turns, items: [], tasks, mcpServers: [], skills: [], usage: EMPTY_USAGE } });
const step: PlanStepView = { key: 'a', order: 1, title: 'A', rationale: '', status: 'done', targets: [] };
const plan: PlanView = {
  id: 'p1', version: 2, goal: 'g', status: 'approved', approvedBy: 'user-card', steps: [step], scope: { paths: [], globs: [] }, owners: {},
  review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2,
};

describe('canOfferRollback', () => {
  it('offers a rollback only for the latest version while the agent is idle', () => {
    expect(canOfferRollback(chatWith([turn(5)], [task(4)]), plan, step)).toBe(true);
    expect(canOfferRollback(chatWith([turn(null)], []), plan, step)).toBe(false);
    expect(canOfferRollback(chatWith([turn(5)], [task(null)]), plan, step)).toBe(false);
    expect(canOfferRollback(chatWith([], []), null, step)).toBe(false);
    expect(canOfferRollback(chatWith([], []), plan, { ...step, key: 'gone' })).toBe(false);
  });
});

describe('latest plan version', () => {
  it('picks the highest version whatever the order, and gates the rollback on it', () => {
    const v3 = { ...plan, version: 3, steps: [{ ...step, key: 'only-v3' }] };
    const v1 = { ...plan, version: 1 };
    const other = { ...plan, id: 'p2', version: 9 };
    const latest = latestPlanVersion([v3, other, v1, plan], 'p1');
    expect(latest?.version).toBe(3);
    expect(latestPlanVersion([v3, v1], 'missing')).toBeNull();
    const idle = chatWith([turn(5)], []);
    expect(canOfferRollback(idle, latest, step)).toBe(false);
    expect(canOfferRollback(idle, latest, v3.steps[0]!)).toBe(true);
  });
});

describe('timelineSummary', () => {
  it('counts steps, events (watchdog and gate) and reverts', () => {
    const h = {
      changes: [], checkpoints: [{ planId: 'p1', stepKey: 'a', cycle: 0, before: 1, after: 2, startedAt: 1, sealedAt: 2 }, { planId: 'p1', stepKey: 'a', cycle: 1, before: 2, after: 3, startedAt: 3, sealedAt: 4 }, { planId: 'p1', stepKey: 'a', cycle: 2, before: 3, after: 4, startedAt: 5, sealedAt: 6 }],
      events: [], gateEvents: [
        { id: 'g1', kind: 'pre-execution' as const, toolUseId: null, mode: 'B' as const, targets: [], resolution: 'denied', ts: 1, resolvedAt: 2 },
        { id: 'g2', kind: 'pre-execution' as const, toolUseId: null, mode: 'B' as const, targets: [], resolution: 'denied', ts: 2, resolvedAt: 3 },
      ],
      reverts: [{ id: 'r1', kind: 'step' as const, eventId: null, planId: null, stepKey: null, changeIds: [], files: [], ts: 9, undoneAt: null }], summaries: [],
    };
    expect(timelineSummary(timelineItems([plan], h))).toBe('3 steps · 2 events · 1 revert');
  });
});
