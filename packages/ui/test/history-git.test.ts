import { describe, expect, it } from 'vitest';
import type { ChangeView, HistoryView, PlanView } from '@ide/protocol';
import { timelineItems } from '../src/history/history-state';
import { reviewCount, reviewGroups } from '../src/history/review-state';

let seq = 0;
const change = (o: Partial<ChangeView>): ChangeView => ({
  id: `c${++seq}`, path: 'src/a.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false,
  toolUseIds: [], planId: 'p1', planVersion: 1, stepKey: 'a', eventId: null, resolution: null, added: 0, removed: 0, stored: true,
  unreadable: false, beforeMode: null, ...o,
});
const plan: PlanView = {
  id: 'p1', version: 1, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [{ key: 'a', order: 1, title: 'API', rationale: '', status: 'active', targets: [] }],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2,
};
const gitWork = { origin: 'git', planId: null, planVersion: null, stepKey: null } as const;

describe('what git wrote', () => {
  it('is left out of review, and shows in History as one row per git call', () => {
    const history: HistoryView = {
      changes: [
        change({ path: 'src/a.ts' }),
        change({ ...gitWork, path: 'x.ts', toolUseIds: ['t1'], at: 5 }),
        change({ ...gitWork, path: 'y.ts', toolUseIds: ['t1'], at: 6 }),
        change({ ...gitWork, path: '.git/HEAD', toolUseIds: ['t1'], enforcement: 'recorded' }),
        change({ ...gitWork, path: 'z.ts', toolUseIds: ['t2'], at: 9 }),
      ],
      events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [],
    };
    const groups = reviewGroups(history, [plan]);
    expect([groups.flatMap((g) => g.files.map((f) => f.path)), reviewCount(groups)]).toEqual([['src/a.ts'], 1]);
    const rows = timelineItems([plan], history, (id) => (id === 't1' ? 'git rebase main' : undefined)).filter((item) => item.kind === 'git');
    expect(rows.map((row) => [row.label, row.files])).toEqual([['git rebase main · 2 files', ['x.ts', 'y.ts']], ['git · 1 file', ['z.ts']]]);
  });
});
