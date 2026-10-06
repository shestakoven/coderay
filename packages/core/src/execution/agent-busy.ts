import type { PlanView } from '@ide/protocol';

export interface BusySession {
  hasOpenTurn(): boolean;
  runningSubagents(): number;
  runningShell(): boolean;
}

// An approved plan with no active step does not count: the agent is idle, and a plan nobody finishes must not lock the tree.
export function busyReason(session: BusySession | null, plans: readonly PlanView[]): string | null {
  if (session?.hasOpenTurn()) return 'the agent is working';
  if (session && (session.runningSubagents() > 0 || session.runningShell())) return 'the agent has work running in the background';
  if (plans.some((plan) => plan.status === 'approved' && plan.steps.some((step) => step.status === 'active'))) return 'a plan step is running';
  return null;
}
