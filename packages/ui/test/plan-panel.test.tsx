import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { PlanPanel } from '../src/plan/PlanPanel';

const plan: PlanView = {
  id: 'plan-1', version: 1, goal: 'Fix', status: 'approved', approvedBy: 'user-card',
  steps: [{ key: 'a', order: 1, title: 'API', rationale: '', status: 'active', targets: [{ path: 'src/a.ts', op: 'modify' }] }],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2,
};

const leftOpen = (working: boolean): boolean =>
  renderToStaticMarkup(<PlanPanel plan={plan} snapshot={null} open working={working} onAnswer={() => undefined} onFocusStep={() => undefined} />).includes('>left open<');

describe('PlanPanel', () => {
  it('reads "left open" for the active step only while the agent has no turn open', () => {
    expect([leftOpen(false), leftOpen(true)]).toEqual([true, false]);
  });
});
