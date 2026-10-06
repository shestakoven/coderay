import { describe, expect, it } from 'vitest';
import type { ChangeView, HistoryView, PlanView, SummaryView } from '@ide/protocol';
import { reviewCount, reviewGroups, type ReviewGroup } from '../src/history/review-state';

const view = (o: Partial<HistoryView> = {}): HistoryView => ({ changes: [], events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [], ...o });
let seq = 0;
const change = (o: Partial<ChangeView> = {}): ChangeView => ({
  id: `c${++seq}`, path: 'src/a.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false,
  toolUseIds: [], planId: 'p1', planVersion: 1, stepKey: 'a', eventId: null, resolution: null, added: 0, removed: 0, stored: true,
  unreadable: false, beforeMode: null, ...o,
});
const plan = (o: Partial<PlanView> = {}): PlanView => ({
  id: 'p1', version: 1, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [
    { key: 'a', order: 1, title: 'API', rationale: '', status: 'done', targets: [] },
    { key: 'b', order: 2, title: 'DB', rationale: '', status: 'active', targets: [] },
  ],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2, ...o,
});
const summary = (o: Partial<SummaryView> = {}): SummaryView => ({ key: 'k', scope: 'step', ref: 'p1/a', text: 'did a', pending: false, ...o });
const keys = (groups: ReviewGroup[]): string[] => groups.map((g) => g.key);
const paths = (g: ReviewGroup | undefined): string[] => (g?.files ?? []).map((f) => f.path);

describe('reviewGroups', () => {
  it('returns no groups for an empty history', () => {
    expect(reviewGroups(view(), [plan()])).toEqual([]);
  });

  it('returns no groups when the only change is an IDE change and there are no plans', () => {
    expect(reviewGroups(view({ changes: [change({ origin: 'ide' })] }), [])).toEqual([]);
  });

  describe('enforcement', () => {
    it('drops a recorded change', () => {
      const history = view({ changes: [change({ path: 'src/kept.ts' }), change({ path: 'src/dropped.ts', enforcement: 'recorded' })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups.flatMap(paths)).toEqual(['src/kept.ts']);
    });

    it('returns no groups when every change is recorded', () => {
      const history = view({
        changes: [
          change({ enforcement: 'recorded' }),
          change({ enforcement: 'recorded', outOfPlan: true }),
          change({ enforcement: 'recorded', origin: 'human' }),
        ],
      });
      expect(reviewGroups(history, [plan()])).toEqual([]);
    });
  });

  describe('plan steps', () => {
    it('groups an agent change under its plan step with the step title', () => {
      const [group] = reviewGroups(view({ changes: [change({ path: 'src/a.ts', stepKey: 'a' })] }), [plan()]);
      expect(group).toMatchObject({ key: 'p1/a', title: 'API', outOfPlan: false });
      expect(paths(group)).toEqual(['src/a.ts']);
    });

    it('groups an agent-tool change like an agent change', () => {
      const [group] = reviewGroups(view({ changes: [change({ origin: 'agent-tool', stepKey: 'b' })] }), [plan()]);
      expect(group).toMatchObject({ key: 'p1/b', title: 'DB' });
    });

    it('orders step groups by step order, not by change order or array order', () => {
      const steps = [
        { key: 'b', order: 2, title: 'DB', rationale: '', status: 'active' as const, targets: [] },
        { key: 'a', order: 1, title: 'API', rationale: '', status: 'done' as const, targets: [] },
      ];
      const history = view({ changes: [change({ stepKey: 'b', at: 1 }), change({ stepKey: 'a', at: 2 })] });
      expect(keys(reviewGroups(history, [plan({ steps })]))).toEqual(['p1/a', 'p1/b']);
    });

    it('omits a plan step that has no changes', () => {
      const history = view({ changes: [change({ stepKey: 'b' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['p1/b']);
    });

    it('uses the latest plan version for the step title', () => {
      const v1 = plan({ version: 1, steps: [{ key: 'a', order: 1, title: 'Old title', rationale: '', status: 'done', targets: [] }] });
      const v2 = plan({ version: 2, steps: [{ key: 'a', order: 1, title: 'New title', rationale: '', status: 'done', targets: [] }] });
      const history = view({ changes: [change({ stepKey: 'a', planVersion: 1 })] });
      expect(reviewGroups(history, [v2, v1])[0]?.title).toBe('New title');
      expect(reviewGroups(history, [v1, v2])[0]?.title).toBe('New title');
    });

    it('uses the step order of the latest plan version', () => {
      const v1 = plan({
        version: 1,
        steps: [
          { key: 'a', order: 1, title: 'API', rationale: '', status: 'done', targets: [] },
          { key: 'b', order: 2, title: 'DB', rationale: '', status: 'done', targets: [] },
        ],
      });
      const v2 = plan({
        version: 2,
        steps: [
          { key: 'b', order: 1, title: 'DB', rationale: '', status: 'done', targets: [] },
          { key: 'a', order: 2, title: 'API', rationale: '', status: 'done', targets: [] },
        ],
      });
      const history = view({ changes: [change({ stepKey: 'a', planVersion: 1 }), change({ stepKey: 'b', planVersion: 1 })] });
      expect(keys(reviewGroups(history, [v1, v2]))).toEqual(['p1/b', 'p1/a']);
    });

    it('treats a change on a step missing from the latest plan version as outside the plan', () => {
      const v1 = plan({ version: 1 });
      const v2 = plan({ version: 2, steps: [{ key: 'a', order: 1, title: 'API', rationale: '', status: 'done', targets: [] }] });
      const history = view({ changes: [change({ path: 'src/gone.ts', stepKey: 'b', planVersion: 1 })] });
      const groups = reviewGroups(history, [v1, v2]);
      expect(keys(groups)).toEqual(['outside']);
      expect(paths(groups[0])).toEqual(['src/gone.ts']);
    });

    it('keeps the steps of different plans apart and in plan order', () => {
      const other = plan({ id: 'p2', steps: [{ key: 'a', order: 1, title: 'Other API', rationale: '', status: 'done', targets: [] }] });
      const history = view({ changes: [change({ planId: 'p2', stepKey: 'a' }), change({ planId: 'p1', stepKey: 'a' })] });
      const groups = reviewGroups(history, [plan(), other]);
      expect(groups.map((g) => [g.key, g.title])).toEqual([['p1/a', 'API'], ['p2/a', 'Other API']]);
    });

    it('does not mix up changes of two plans that use the same step key', () => {
      const other = plan({ id: 'p2', steps: [{ key: 'a', order: 1, title: 'Other API', rationale: '', status: 'done', targets: [] }] });
      const history = view({ changes: [change({ planId: 'p1', stepKey: 'a', path: 'src/one.ts' }), change({ planId: 'p2', stepKey: 'a', path: 'src/two.ts' })] });
      const groups = reviewGroups(history, [plan(), other]);
      expect(groups.map((g) => paths(g))).toEqual([['src/one.ts'], ['src/two.ts']]);
    });
  });

  describe('follow-ups', () => {
    it('lists a plan change with no step under Follow-ups after the steps, and leaves an out-of-plan one outside', () => {
      const history = view({
        changes: [
          change({ path: 'src/a.ts', stepKey: 'a' }),
          change({ path: 'src/fix.ts', stepKey: null }),
          change({ path: 'src/stray.ts', stepKey: null, outOfPlan: true }),
        ],
      });
      expect(reviewGroups(history, [plan()]).map((g) => [g.key, g.title, paths(g)])).toEqual([
        ['outside', 'Outside the plan', ['src/stray.ts']],
        ['p1/a', 'API', ['src/a.ts']],
        ['p1/', 'Follow-ups', ['src/fix.ts']],
      ]);
    });

    it('flags the group of an added step and no other', () => {
      const steps = [
        { key: 'a', order: 1, title: 'API', rationale: '', status: 'done' as const, targets: [] },
        { key: 'b', order: 2, title: 'DB', rationale: '', status: 'done' as const, targets: [], extra: true },
      ];
      const history = view({ changes: [change({ stepKey: 'a' }), change({ stepKey: 'b' }), change({ stepKey: null })] });
      expect(reviewGroups(history, [plan({ steps })]).map((g) => [g.key, Boolean(g.extra)])).toEqual([['p1/a', false], ['p1/b', true], ['p1/', false]]);
    });
  });

  describe('one row per file', () => {
    it('merges a file changed twice in one step into one row', () => {
      const history = view({
        changes: [
          change({ id: 'c1', path: 'src/a.ts', at: 1, beforeHash: 'orig', afterHash: 'mid', added: 3, removed: 1 }),
          change({ id: 'c2', path: 'src/a.ts', at: 2, beforeHash: 'mid', afterHash: 'final', added: 2, removed: 4 }),
        ],
      });
      const [group] = reviewGroups(history, [plan()]);
      expect(group?.files).toEqual([{ path: 'src/a.ts', ids: ['c1', 'c2'], before: 'orig', after: 'final', added: 5, removed: 5 }]);
    });

    it('takes the first before and the last after by time even when changes arrive out of order', () => {
      const history = view({
        changes: [
          change({ path: 'src/a.ts', at: 3, beforeHash: 'two', afterHash: 'three' }),
          change({ path: 'src/a.ts', at: 1, beforeHash: null, afterHash: 'one' }),
          change({ path: 'src/a.ts', at: 2, beforeHash: 'one', afterHash: 'two' }),
        ],
      });
      const [file] = reviewGroups(history, [plan()])[0]!.files;
      expect(file).toMatchObject({ before: null, after: 'three' });
    });

    it('keeps a null after hash for a file the step deleted', () => {
      const history = view({
        changes: [
          change({ path: 'src/a.ts', at: 1, beforeHash: 'orig', afterHash: 'mid' }),
          change({ path: 'src/a.ts', at: 2, beforeHash: 'mid', afterHash: null }),
        ],
      });
      expect(reviewGroups(history, [plan()])[0]?.files[0]).toMatchObject({ before: 'orig', after: null });
    });

    it('treats missing line counts as zero', () => {
      const history = view({ changes: [change({ added: null, removed: null }), change({ added: 2, removed: null })] });
      expect(reviewGroups(history, [plan()])[0]?.files[0]).toMatchObject({ added: 2, removed: 0 });
    });

    it('keeps different files in separate rows', () => {
      const history = view({ changes: [change({ path: 'src/a.ts', at: 1 }), change({ path: 'src/b.ts', at: 2 })] });
      expect(paths(reviewGroups(history, [plan()])[0])).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('sums the added and removed lines of all files into the group totals', () => {
      const history = view({
        changes: [
          change({ path: 'src/a.ts', at: 1, added: 3, removed: 1 }),
          change({ path: 'src/a.ts', at: 2, added: 2, removed: 0 }),
          change({ path: 'src/b.ts', at: 3, added: 10, removed: 7 }),
        ],
      });
      expect(reviewGroups(history, [plan()])[0]).toMatchObject({ added: 15, removed: 8 });
    });

    it('does not merge the same file changed in two different steps', () => {
      const history = view({ changes: [change({ path: 'src/a.ts', stepKey: 'a', added: 1 }), change({ path: 'src/a.ts', stepKey: 'b', added: 2 })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups.map((g) => [g.key, g.files[0]?.added])).toEqual([['p1/a', 1], ['p1/b', 2]]);
    });
  });

  describe('outside the plan', () => {
    it('puts a change flagged outOfPlan into the Outside the plan group', () => {
      const history = view({ changes: [change({ path: 'src/stray.ts', stepKey: 'a', outOfPlan: true })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ key: 'outside', title: 'Outside the plan', outOfPlan: true, summary: null });
      expect(paths(groups[0])).toEqual(['src/stray.ts']);
    });

    it('puts an agent change without a plan into the Outside the plan group', () => {
      const history = view({ changes: [change({ path: 'src/free.ts', planId: null, planVersion: null, stepKey: null })] });
      expect(reviewGroups(history, [plan()]).map((g) => [g.title, g.outOfPlan])).toEqual([['Outside the plan', true]]);
    });

    it('puts an agent change for an unknown plan into the Outside the plan group', () => {
      const history = view({ changes: [change({ planId: 'ghost', stepKey: 'a' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['outside']);
    });

    it('puts an agent change with an unknown step into the Outside the plan group', () => {
      const history = view({ changes: [change({ stepKey: 'nope' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['outside']);
    });

    it('puts a change of unknown origin into the Outside the plan group', () => {
      const history = view({ changes: [change({ origin: 'unknown', planId: null, planVersion: null, stepKey: null })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['outside']);
    });

    it('lists the Outside the plan group before every step group', () => {
      const history = view({ changes: [change({ stepKey: 'a' }), change({ stepKey: 'b' }), change({ planId: null, planVersion: null, stepKey: null })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['outside', 'p1/a', 'p1/b']);
    });

    it('does not flag a step group as outside the plan', () => {
      const history = view({ changes: [change({ stepKey: 'a' }), change({ outOfPlan: true })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups.filter((g) => g.outOfPlan).map((g) => g.key)).toEqual(['outside']);
    });

    it('keeps an outOfPlan change out of its step group', () => {
      const history = view({ changes: [change({ path: 'src/in.ts', stepKey: 'a' }), change({ path: 'src/stray.ts', stepKey: 'a', outOfPlan: true })] });
      const groups = reviewGroups(history, [plan()]);
      expect(paths(groups.find((g) => g.key === 'outside'))).toEqual(['src/stray.ts']);
      expect(paths(groups.find((g) => g.key === 'p1/a'))).toEqual(['src/in.ts']);
    });
  });

  describe('external changes', () => {
    it('puts a human change into the External changes group', () => {
      const history = view({ changes: [change({ path: 'src/hand.ts', origin: 'human', planId: null, planVersion: null, stepKey: null })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ key: 'external', title: 'External changes', outOfPlan: false, summary: null });
      expect(paths(groups[0])).toEqual(['src/hand.ts']);
    });

    it('puts a human change into External changes even when it carries a plan step', () => {
      const history = view({ changes: [change({ origin: 'human', stepKey: 'a' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['external']);
    });

    it('puts a human change into External changes even when it is flagged outOfPlan', () => {
      const history = view({ changes: [change({ origin: 'human', outOfPlan: true })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['external']);
    });

    it('lists the External changes group after every step group', () => {
      const history = view({ changes: [change({ origin: 'human', at: 1 }), change({ stepKey: 'b', at: 2 }), change({ stepKey: 'a', at: 3 })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['p1/a', 'p1/b', 'external']);
    });

    it('orders groups as outside, steps, then external', () => {
      const history = view({
        changes: [
          change({ origin: 'human', path: 'src/hand.ts' }),
          change({ stepKey: 'b', path: 'src/db.ts' }),
          change({ stepKey: 'a', path: 'src/api.ts' }),
          change({ planId: null, planVersion: null, stepKey: null, path: 'src/free.ts' }),
        ],
      });
      const groups = reviewGroups(history, [plan()]);
      expect(keys(groups)).toEqual(['outside', 'p1/a', 'p1/b', 'external']);
      expect(groups.map((g) => paths(g))).toEqual([['src/free.ts'], ['src/api.ts'], ['src/db.ts'], ['src/hand.ts']]);
    });
  });

  describe('ide changes', () => {
    it('never shows a change made by the IDE', () => {
      const history = view({ changes: [change({ origin: 'ide', path: 'src/ide.ts', stepKey: 'a' }), change({ origin: 'ide', planId: null, planVersion: null, stepKey: null })] });
      expect(reviewGroups(history, [plan()])).toEqual([]);
    });

    it('shows the agent change next to an IDE change of the same step and not the IDE one', () => {
      const history = view({ changes: [change({ origin: 'ide', path: 'src/ide.ts' }), change({ origin: 'agent', path: 'src/agent.ts' })] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups.flatMap(paths)).toEqual(['src/agent.ts']);
    });
  });

  describe('reverted changes', () => {
    it('drops a reverted change', () => {
      const history = view({ changes: [change({ path: 'src/kept.ts' }), change({ path: 'src/undone.ts', resolution: 'reverted' })] });
      expect(reviewGroups(history, [plan()]).flatMap(paths)).toEqual(['src/kept.ts']);
    });

    it('returns no groups when every change was reverted', () => {
      const history = view({
        changes: [
          change({ resolution: 'reverted' }),
          change({ resolution: 'reverted', outOfPlan: true }),
          change({ resolution: 'reverted', origin: 'human', planId: null, planVersion: null, stepKey: null }),
        ],
      });
      expect(reviewGroups(history, [plan()])).toEqual([]);
    });

    it.each(['kept', 'plan-expanded', 'relabeled-human', 'flagged'] as const)('keeps a change resolved as %s', (resolution) => {
      expect(reviewGroups(view({ changes: [change({ path: 'src/a.ts', resolution })] }), [plan()]).flatMap(paths)).toEqual(['src/a.ts']);
    });

    it('omits a step whose only change was reverted', () => {
      const history = view({ changes: [change({ stepKey: 'a', resolution: 'reverted' }), change({ stepKey: 'b' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['p1/b']);
    });

    it('omits the Outside the plan group when its only change was reverted', () => {
      const history = view({ changes: [change({ stepKey: 'a', outOfPlan: true, resolution: 'reverted' }), change({ stepKey: 'a' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['p1/a']);
    });

    it('omits the External changes group when its only change was reverted', () => {
      const history = view({ changes: [change({ origin: 'human', resolution: 'reverted' }), change({ stepKey: 'a' })] });
      expect(keys(reviewGroups(history, [plan()]))).toEqual(['p1/a']);
    });

    it('keeps the unreverted changes of a file in its row without the reverted ones', () => {
      const history = view({
        changes: [
          change({ id: 'c1', path: 'src/a.ts', at: 1, beforeHash: 'orig', afterHash: 'mid', added: 3, removed: 1, resolution: 'reverted' }),
          change({ id: 'c2', path: 'src/a.ts', at: 2, beforeHash: 'mid', afterHash: 'final', added: 2, removed: 4 }),
        ],
      });
      expect(reviewGroups(history, [plan()])[0]?.files).toEqual([{ path: 'src/a.ts', ids: ['c2'], before: 'mid', after: 'final', added: 2, removed: 4 }]);
    });

    it('leaves the reverted lines out of the group totals', () => {
      const history = view({ changes: [change({ path: 'src/a.ts', added: 5, removed: 5, resolution: 'reverted' }), change({ path: 'src/b.ts', added: 2, removed: 1 })] });
      expect(reviewGroups(history, [plan()])[0]).toMatchObject({ added: 2, removed: 1 });
    });

    it('does not count a reverted file in the review count', () => {
      const history = view({ changes: [change({ path: 'src/a.ts', resolution: 'reverted' }), change({ path: 'src/b.ts' })] });
      expect(reviewCount(reviewGroups(history, [plan()]))).toBe(1);
    });
  });

  describe('change ids', () => {
    it('lists the id of a file changed once', () => {
      const history = view({ changes: [change({ id: 'only', path: 'src/a.ts' })] });
      expect(reviewGroups(history, [plan()])[0]?.files[0]?.ids).toEqual(['only']);
    });

    it('lists every change id of a file row ordered by time, not by arrival', () => {
      const history = view({
        changes: [
          change({ id: 'third', path: 'src/a.ts', at: 3 }),
          change({ id: 'first', path: 'src/a.ts', at: 1 }),
          change({ id: 'second', path: 'src/a.ts', at: 2 }),
        ],
      });
      expect(reviewGroups(history, [plan()])[0]?.files[0]?.ids).toEqual(['first', 'second', 'third']);
    });

    it('keeps the ids of different files in their own rows', () => {
      const history = view({ changes: [change({ id: 'a1', path: 'src/a.ts', at: 1 }), change({ id: 'b1', path: 'src/b.ts', at: 2 }), change({ id: 'a2', path: 'src/a.ts', at: 3 })] });
      expect(reviewGroups(history, [plan()])[0]?.files.map((f) => [f.path, f.ids])).toEqual([['src/a.ts', ['a1', 'a2']], ['src/b.ts', ['b1']]]);
    });

    it('keeps the ids of the same file in two steps apart', () => {
      const history = view({ changes: [change({ id: 'in-a', path: 'src/a.ts', stepKey: 'a' }), change({ id: 'in-b', path: 'src/a.ts', stepKey: 'b' })] });
      expect(reviewGroups(history, [plan()]).map((g) => [g.key, g.files[0]?.ids])).toEqual([['p1/a', ['in-a']], ['p1/b', ['in-b']]]);
    });

    it('leaves out the ids of recorded and IDE changes', () => {
      const history = view({
        changes: [
          change({ id: 'agent', path: 'src/a.ts', at: 1 }),
          change({ id: 'recorded', path: 'src/a.ts', at: 2, enforcement: 'recorded' }),
          change({ id: 'ide', path: 'src/a.ts', at: 3, origin: 'ide' }),
        ],
      });
      expect(reviewGroups(history, [plan()])[0]?.files[0]?.ids).toEqual(['agent']);
    });
  });

  describe('step summary', () => {
    it('attaches the step summary matching plan id and step key', () => {
      const wanted = summary({ key: 's-a', ref: 'p1/a', text: 'did a' });
      const history = view({ changes: [change({ stepKey: 'a' }), change({ stepKey: 'b' })], summaries: [summary({ key: 's-b', ref: 'p1/b', text: 'did b' }), wanted] });
      const groups = reviewGroups(history, [plan()]);
      expect(groups.map((g) => g.summary?.key)).toEqual(['s-a', 's-b']);
      expect(groups[0]?.summary).toEqual(wanted);
    });

    it('leaves the summary null when the step has none', () => {
      const history = view({ changes: [change({ stepKey: 'a' })], summaries: [summary({ ref: 'p1/b' })] });
      expect(reviewGroups(history, [plan()])[0]?.summary).toBeNull();
    });

    it('ignores a component summary with the same ref', () => {
      const history = view({ changes: [change({ stepKey: 'a' })], summaries: [summary({ scope: 'component', ref: 'p1/a' })] });
      expect(reviewGroups(history, [plan()])[0]?.summary).toBeNull();
    });

    it('ignores the summary of a same-named step in another plan', () => {
      const other = plan({ id: 'p2' });
      const history = view({ changes: [change({ planId: 'p1', stepKey: 'a' })], summaries: [summary({ ref: 'p2/a' })] });
      expect(reviewGroups(history, [plan(), other])[0]?.summary).toBeNull();
    });
  });
});

describe('reviewCount', () => {
  const group = (files: string[]): ReviewGroup => ({
    key: files.join(','), title: 't', outOfPlan: false, summary: null, added: 0, removed: 0,
    files: files.map((path) => ({ path, ids: [path], before: null, after: 'h', added: 0, removed: 0 })),
  });

  it('is zero for no groups', () => {
    expect(reviewCount([])).toBe(0);
  });

  it('counts the files of all groups', () => {
    expect(reviewCount([group(['a.ts', 'b.ts']), group(['c.ts'])])).toBe(3);
  });

  it('counts a path that appears in two groups once', () => {
    expect(reviewCount([group(['a.ts', 'b.ts']), group(['b.ts', 'c.ts'])])).toBe(3);
  });

  it('counts distinct paths of real review groups', () => {
    const history = view({
      changes: [
        change({ path: 'src/a.ts', stepKey: 'a' }),
        change({ path: 'src/a.ts', stepKey: 'b' }),
        change({ path: 'src/b.ts', origin: 'human', planId: null, planVersion: null, stepKey: null }),
        change({ path: 'src/c.ts', enforcement: 'recorded' }),
      ],
    });
    expect(reviewCount(reviewGroups(history, [plan()]))).toBe(2);
  });
});
