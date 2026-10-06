import { describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { busyReason, type BusySession } from '../../src/execution/agent-busy';

const session = (over: Partial<Record<keyof BusySession, unknown>> = {}): BusySession => ({
  hasOpenTurn: () => false, runningSubagents: () => 0, runningShell: () => false, ...over,
}) as BusySession;
const plan = (status: PlanView['status'], steps: ('pending' | 'active' | 'done')[]): PlanView => ({ status, steps: steps.map((s) => ({ status: s })) }) as PlanView;

describe('busyReason', () => {
  it('names an open turn, background work and an active step of an approved plan', () => {
    expect(busyReason(session({ hasOpenTurn: () => true }), [])).toBe('the agent is working');
    expect(busyReason(session({ runningSubagents: () => 2 }), [])).toBe('the agent has work running in the background');
    expect(busyReason(session({ runningShell: () => true }), [])).toBe('the agent has work running in the background');
    expect(busyReason(null, [plan('approved', ['done', 'active'])])).toBe('a plan step is running');
  });

  it('is free when nothing runs, even with an idle approved plan or an active step of a plan nobody approved', () => {
    expect(busyReason(null, [])).toBeNull();
    expect(busyReason(session(), [plan('approved', ['done', 'pending'])])).toBeNull();
    expect(busyReason(session(), [plan('proposed', ['active'])])).toBeNull();
  });
});
