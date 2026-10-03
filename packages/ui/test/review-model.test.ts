import { describe, expect, it } from 'vitest';
import type { ChangeView, HistoryView, PlanView, RevertFile, RevertRecordView, SummaryView } from '@ide/protocol';
import { kindOf, reviewSections, sectionFiles, type ReviewItem, type ReviewSection } from '../src/history/review-model';

const view = (o: Partial<HistoryView> = {}): HistoryView => ({ changes: [], events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [], ...o });
let seq = 0;
const change = (o: Partial<ChangeView> = {}): ChangeView => ({
  id: `c${++seq}`, path: 'src/a.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false,
  toolUseIds: [], planId: 'p1', planVersion: 1, stepKey: 'a', eventId: null, resolution: null, added: 0, removed: 0, stored: true,
  unreadable: false, beforeMode: null, ...o,
});
const step = (key: string, order: number, o: Record<string, unknown> = {}) => ({ key, order, title: key.toUpperCase(), rationale: '', status: 'done' as const, targets: [], ...o });
const plan = (o: Partial<PlanView> = {}): PlanView => ({
  id: 'p1', version: 1, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [step('a', 1, { title: 'API' }), step('b', 2, { title: 'DB' })],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: 2, ...o,
});
const restored = (...changes: ChangeView[]): RevertFile[] => [...new Set(changes.map((c) => c.path))].map((path) => ({ path, outcome: 'restored', reason: null }));
const revert = (changes: ChangeView[], o: Partial<RevertRecordView> = {}): RevertRecordView => ({
  id: `r${++seq}`, kind: 'review', eventId: null, planId: null, stepKey: null, changeIds: changes.map((c) => c.id), files: restored(...changes), ts: 1, undoneAt: null, ...o,
});
const summary = (o: Partial<SummaryView> = {}): SummaryView => ({ key: 'k', scope: 'step', ref: 'p1/a', text: 'did a', pending: false, ...o });
const paths = (section: ReviewSection | undefined): string[] => (section?.files ?? []).map((file) => file.path);
const fileOf = (sections: ReviewSection[], path: string): ReviewItem => {
  const found = sectionFiles(sections).find((file) => file.path === path);
  if (!found) throw new Error(`no file ${path} in ${JSON.stringify(sections.map((s) => paths(s)))}`);
  return found;
};
const sorted = (values: string[]): string[] => [...values].sort();
const freeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) Object.values(value).forEach(freeze);
  return Object.freeze(value);
};

describe('reviewSections basics', () => {
  it('returns no sections for an empty history', () => {
    expect(reviewSections(view(), [plan()])).toEqual([]);
  });

  it('keeps the group data: key, title, totals and summary', () => {
    const history = view({
      changes: [change({ path: 'src/a.ts', added: 4, removed: 1 }), change({ path: 'src/b.ts', added: 2, removed: 0 })],
      summaries: [summary({ text: 'did the API' })],
    });
    const [section] = reviewSections(history, [plan()]);
    expect(section).toMatchObject({ key: 'p1/a', title: 'API', outOfPlan: false, added: 6, removed: 1, summary: { text: 'did the API', pending: false } });
    expect(paths(section)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('puts out-of-plan changes in their own section without plan details', () => {
    const history = view({ changes: [change({ planId: null, stepKey: null, outOfPlan: true })] });
    const [section] = reviewSections(history, [plan()]);
    expect(section).toMatchObject({ key: 'outside', outOfPlan: true, planId: null, stepKey: null, rationale: null, stepNo: null, stepTotal: 0 });
  });

  it('puts changes made outside the agent in the external section without plan details', () => {
    const history = view({ changes: [change({ origin: 'human', planId: null, stepKey: null })] });
    const [section] = reviewSections(history, [plan()]);
    expect(section).toMatchObject({ key: 'external', planId: null, stepKey: null, rationale: null, stepNo: null, stepTotal: 0 });
  });

  it('does not modify the history it is given', () => {
    const c = change({ resolution: 'reverted' });
    const history = freeze(view({ changes: [c], reverts: [revert([c])] }));
    expect(() => reviewSections(history, [plan()])).not.toThrow();
    expect(history.changes[0]!.resolution).toBe('reverted');
  });
});

describe('reviewSections step details', () => {
  it('gives a step section its plan id and step key', () => {
    const [section] = reviewSections(view({ changes: [change({ stepKey: 'b' })] }), [plan()]);
    expect(section).toMatchObject({ planId: 'p1', stepKey: 'b' });
  });

  it('numbers steps from 1 by their position in the plan and counts the plan steps', () => {
    const sections = reviewSections(view({ changes: [change({ stepKey: 'a' }), change({ stepKey: 'b', path: 'src/b.ts' })] }), [plan({ steps: [step('a', 1), step('b', 2), step('c', 3)] })]);
    expect(sections.map((s) => [s.stepKey, s.stepNo, s.stepTotal])).toEqual([['a', 1, 3], ['b', 2, 3]]);
  });

  it('numbers the last step of the plan with the plan length', () => {
    const [section] = reviewSections(view({ changes: [change({ stepKey: 'c' })] }), [plan({ steps: [step('a', 1), step('b', 2), step('c', 3)] })]);
    expect(section).toMatchObject({ stepNo: 3, stepTotal: 3 });
  });

  it('uses the trimmed step rationale', () => {
    const [section] = reviewSections(view({ changes: [change()] }), [plan({ steps: [step('a', 1, { rationale: '  Because the API changed.\n' })] })]);
    expect(section!.rationale).toBe('Because the API changed.');
  });

  it.each(['', '   ', '\n\t '])('has no rationale for the blank rationale %j', (rationale) => {
    const [section] = reviewSections(view({ changes: [change()] }), [plan({ steps: [step('a', 1, { rationale })] })]);
    expect(section!.rationale).toBeNull();
  });

  it('reads the rationale and numbering from the latest plan version', () => {
    const v1 = plan({ version: 1, steps: [step('a', 1, { rationale: 'old reason' })] });
    const v2 = plan({ version: 2, steps: [step('x', 1), step('a', 2, { rationale: 'new reason' })] });
    for (const plans of [[v1, v2], [v2, v1]]) {
      const [section] = reviewSections(view({ changes: [change()] }), plans);
      expect(section).toMatchObject({ rationale: 'new reason', stepNo: 2, stepTotal: 2 });
    }
  });

  it('keeps the numbering of each plan separate', () => {
    const other = plan({ id: 'p2', steps: [step('only', 1, { rationale: 'second plan' })] });
    const history = view({ changes: [change({ stepKey: 'b' }), change({ planId: 'p2', stepKey: 'only', path: 'src/z.ts' })] });
    const sections = reviewSections(history, [plan(), other]);
    expect(sections.map((s) => [s.planId, s.stepKey, s.stepNo, s.stepTotal, s.rationale])).toEqual([['p1', 'b', 2, 2, null], ['p2', 'only', 1, 1, 'second plan']]);
  });
});

describe('reviewSections tool and event ids', () => {
  it('has none for a file whose changes carry none', () => {
    const file = fileOf(reviewSections(view({ changes: [change()] }), [plan()]), 'src/a.ts');
    expect(file.toolUseIds).toEqual([]);
    expect(file.eventIds).toEqual([]);
  });

  it('collects each tool use id of the file once across its changes', () => {
    const history = view({
      changes: [
        change({ at: 1, toolUseIds: ['t1', 't2'] }),
        change({ at: 2, toolUseIds: ['t2', 't3'] }),
        change({ at: 3, toolUseIds: ['t1'] }),
      ],
    });
    const file = fileOf(reviewSections(history, [plan()]), 'src/a.ts');
    expect(sorted(file.toolUseIds)).toEqual(['t1', 't2', 't3']);
  });

  it('keeps the tool use ids of different files apart', () => {
    const history = view({ changes: [change({ path: 'src/a.ts', toolUseIds: ['ta'] }), change({ path: 'src/b.ts', toolUseIds: ['tb'] })] });
    const sections = reviewSections(history, [plan()]);
    expect(fileOf(sections, 'src/a.ts').toolUseIds).toEqual(['ta']);
    expect(fileOf(sections, 'src/b.ts').toolUseIds).toEqual(['tb']);
  });

  it('collects each event id once and skips changes without an event', () => {
    const history = view({
      changes: [
        change({ at: 1, eventId: 'e1' }),
        change({ at: 2, eventId: null }),
        change({ at: 3, eventId: 'e2' }),
        change({ at: 4, eventId: 'e1' }),
      ],
    });
    const file = fileOf(reviewSections(history, [plan()]), 'src/a.ts');
    expect(sorted(file.eventIds)).toEqual(['e1', 'e2']);
  });
});

describe('reviewSections reverts', () => {
  const reverted = (o: Partial<ChangeView> = {}): ChangeView => change({ resolution: 'reverted', ...o });

  it('hides a reverted change that has no revert record', () => {
    expect(reviewSections(view({ changes: [reverted()] }), [plan()])).toEqual([]);
  });

  it('keeps a change reverted from the review listed and marks the file reverted', () => {
    const c = reverted();
    const record = revert([c]);
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [record] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: true, revertId: record.id, ids: [c.id] });
  });

  it('marks a file as not reverted when it was never reverted', () => {
    const file = fileOf(reviewSections(view({ changes: [change()] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: false, revertId: null });
  });

  it('hides a change reverted by a watchdog record', () => {
    const c = reverted();
    expect(reviewSections(view({ changes: [c], reverts: [revert([c], { kind: 'watchdog' })] }), [plan()])).toEqual([]);
  });

  it('hides a change reverted by a step rollback record', () => {
    const c = reverted();
    expect(reviewSections(view({ changes: [c], reverts: [revert([c], { kind: 'step' })] }), [plan()])).toEqual([]);
  });

  it('lists a file again, not reverted, once its review revert was undone', () => {
    const c = reverted();
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [revert([c], { undoneAt: 5 })] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: false, revertId: null });
  });

  it('lists a file again once its watchdog revert was undone', () => {
    const c = reverted();
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [revert([c], { kind: 'watchdog', undoneAt: 5 })] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: false, revertId: null });
  });

  it('lists a file again once its step rollback was undone', () => {
    const c = reverted();
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [revert([c], { kind: 'step', undoneAt: 5 })] }), [plan()]), 'src/a.ts');
    expect(file.reverted).toBe(false);
  });

  it('marks the file reverted again when a later review revert covers a change whose earlier revert was undone', () => {
    const c = reverted();
    const undone = revert([c], { undoneAt: 5, ts: 1 });
    const active = revert([c], { ts: 9 });
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [undone, active] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: true, revertId: active.id });
  });

  it('marks the file reverted when the active record comes before the undone one in the list', () => {
    const c = reverted();
    const active = revert([c]);
    const undone = revert([c], { undoneAt: 5 });
    const file = fileOf(reviewSections(view({ changes: [c], reverts: [active, undone] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: true, revertId: active.id });
  });

  it('keeps a change hidden when an undone record is followed by an active watchdog record', () => {
    const c = reverted();
    const history = view({ changes: [c], reverts: [revert([c], { undoneAt: 5 }), revert([c], { kind: 'watchdog' })] });
    expect(reviewSections(history, [plan()])).toEqual([]);
  });

  it('keeps a change hidden when an undone watchdog record is followed by an active watchdog record', () => {
    const c = reverted();
    const history = view({ changes: [c], reverts: [revert([c], { kind: 'watchdog', undoneAt: 5 }), revert([c], { kind: 'watchdog' })] });
    expect(reviewSections(history, [plan()])).toEqual([]);
  });

  it('marks the file reverted only when every one of its changes was reverted from the review', () => {
    const first = reverted({ at: 1, beforeHash: 'h0', afterHash: 'h1' });
    const second = change({ at: 2, beforeHash: 'h1', afterHash: 'h2' });
    const file = fileOf(reviewSections(view({ changes: [first, second], reverts: [revert([first])] }), [plan()]), 'src/a.ts');
    expect(file).toMatchObject({ reverted: false, ids: [first.id, second.id], before: 'h0', after: 'h2' });
  });

  it('marks the file reverted when all its changes are covered, even by different records', () => {
    const first = reverted({ at: 1 });
    const second = reverted({ at: 2 });
    const r1 = revert([first]);
    const r2 = revert([second]);
    const file = fileOf(reviewSections(view({ changes: [first, second], reverts: [r1, r2] }), [plan()]), 'src/a.ts');
    expect(file.reverted).toBe(true);
    expect([r1.id, r2.id]).toContain(file.revertId);
  });

  it.each(['restored', 'deleted', 'recreated'] as const)('marks a file reverted when its revert outcome is %s', (outcome) => {
    const c = reverted();
    const record = revert([c], { files: [{ path: c.path, outcome, reason: null }] });
    expect(fileOf(reviewSections(view({ changes: [c], reverts: [record] }), [plan()]), 'src/a.ts')).toMatchObject({ reverted: true, revertId: record.id });
  });

  it.each(['restored', 'deleted', 'recreated'] as const)('hides a change of a watchdog revert whose outcome is %s', (outcome) => {
    const c = reverted();
    expect(reviewSections(view({ changes: [c], reverts: [revert([c], { kind: 'watchdog', files: [{ path: c.path, outcome, reason: null }] })] }), [plan()])).toEqual([]);
  });

  it.each(['conflict', 'not-rolled-back'] as const)('keeps a file listed and not reverted when its revert outcome is %s', (outcome) => {
    const c = change();
    const record = revert([c], { files: [{ path: c.path, outcome, reason: 'could not be restored' }] });
    expect(fileOf(reviewSections(view({ changes: [c], reverts: [record] }), [plan()]), 'src/a.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('does not treat a review record without an entry for the path as a revert of it', () => {
    const c = change();
    expect(fileOf(reviewSections(view({ changes: [c], reverts: [revert([c], { files: [] })] }), [plan()]), 'src/a.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('does not take the outcome of another path for a revert of this one', () => {
    const c = change();
    const record = revert([c], { files: [{ path: 'src/other.ts', outcome: 'restored', reason: null }] });
    expect(fileOf(reviewSections(view({ changes: [c], reverts: [record] }), [plan()]), 'src/a.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('reverts only the path that succeeded when one record covers a path that succeeded and one that conflicted', () => {
    const done = reverted({ path: 'src/done.ts' });
    const stuck = change({ path: 'src/stuck.ts' });
    const record = revert([done, stuck], { files: [{ path: 'src/done.ts', outcome: 'restored', reason: null }, { path: 'src/stuck.ts', outcome: 'conflict', reason: 'changed again' }] });
    const sections = reviewSections(view({ changes: [done, stuck], reverts: [record] }), [plan()]);
    expect(fileOf(sections, 'src/done.ts')).toMatchObject({ reverted: true, revertId: record.id });
    expect(fileOf(sections, 'src/stuck.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('lists a file again, not reverted, when its revert was undone and a later revert of it conflicted', () => {
    const c = reverted();
    const undone = revert([c], { undoneAt: 5 });
    const conflicted = revert([c], { files: [{ path: c.path, outcome: 'conflict', reason: 'changed again' }] });
    expect(fileOf(reviewSections(view({ changes: [c], reverts: [undone, conflicted] }), [plan()]), 'src/a.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('only marks the reverted file, not the other files of the step', () => {
    const gone = reverted({ path: 'src/gone.ts' });
    const kept = change({ path: 'src/kept.ts' });
    const sections = reviewSections(view({ changes: [gone, kept], reverts: [revert([gone])] }), [plan()]);
    expect(fileOf(sections, 'src/gone.ts').reverted).toBe(true);
    expect(fileOf(sections, 'src/kept.ts').reverted).toBe(false);
  });

  it('ignores records for other changes', () => {
    const c = reverted();
    expect(reviewSections(view({ changes: [c], reverts: [revert([change({ id: 'someone-else' })])] }), [plan()])).toEqual([]);
  });

  it('keeps a reverted file in its section totals', () => {
    const c = reverted({ added: 7, removed: 2 });
    const [section] = reviewSections(view({ changes: [c], reverts: [revert([c])] }), [plan()]);
    expect(section).toMatchObject({ added: 7, removed: 2 });
  });
});

describe('reviewSections renames', () => {
  const removal = (path: string, hash: string, o: Partial<ChangeView> = {}): ChangeView => change({ path, beforeHash: hash, afterHash: null, removed: 10, ...o });
  const creation = (path: string, hash: string, o: Partial<ChangeView> = {}): ChangeView => change({ path, beforeHash: null, afterHash: hash, added: 10, ...o });

  it('shows a deleted and a created file with the same content as one renamed file', () => {
    const gone = removal('old/name.ts', 'H', { at: 1 });
    const came = creation('new/name.ts', 'H', { at: 2 });
    const [section] = reviewSections(view({ changes: [gone, came] }), [plan()]);
    expect(paths(section)).toEqual(['new/name.ts']);
    expect(section!.files[0]).toMatchObject({ path: 'new/name.ts', renamedFrom: 'old/name.ts', before: 'H', after: 'H', added: 0, removed: 0 });
  });

  it('lists the ids of the deleted file first, then those of the created file', () => {
    const gone = removal('old.ts', 'H', { at: 1 });
    const came = creation('new.ts', 'H', { at: 2 });
    const file = fileOf(reviewSections(view({ changes: [came, gone] }), [plan()]), 'new.ts');
    expect(file.ids).toEqual([gone.id, came.id]);
  });

  it('merges the tool use ids and event ids of both files without duplicates', () => {
    const gone = removal('old.ts', 'H', { at: 1, toolUseIds: ['t1', 'tshared'], eventId: 'e1' });
    const came = creation('new.ts', 'H', { at: 2, toolUseIds: ['tshared', 't2'], eventId: 'e1' });
    const file = fileOf(reviewSections(view({ changes: [gone, came] }), [plan()]), 'new.ts');
    expect(sorted(file.toolUseIds)).toEqual(['t1', 't2', 'tshared']);
    expect(file.eventIds).toEqual(['e1']);
  });

  it('merges the event ids of both files, those of the deleted file first', () => {
    const gone = removal('old.ts', 'H', { at: 1, eventId: 'e1' });
    const came = creation('new.ts', 'H', { at: 2, eventId: 'e2' });
    expect(fileOf(reviewSections(view({ changes: [gone, came] }), [plan()]), 'new.ts').eventIds).toEqual(['e1', 'e2']);
  });

  it('shows no removed lines for a renamed file even when the new file was edited after it was created', () => {
    const gone = removal('old.ts', 'H', { at: 1 });
    const created = creation('new.ts', 'H0', { at: 2 });
    const edited = change({ path: 'new.ts', beforeHash: 'H0', afterHash: 'H', at: 3, added: 1, removed: 2 });
    const file = fileOf(reviewSections(view({ changes: [gone, created, edited] }), [plan()]), 'new.ts');
    expect(file).toMatchObject({ renamedFrom: 'old.ts', added: 0, removed: 0 });
  });

  it('does not fold a created file that was reverted from the review into a rename', () => {
    const gone = removal('old.ts', 'H', { at: 1 });
    const came = creation('new.ts', 'H', { at: 2, resolution: 'reverted' });
    const sections = reviewSections(view({ changes: [gone, came], reverts: [revert([came])] }), [plan()]);
    expect(fileOf(sections, 'new.ts')).toMatchObject({ renamedFrom: null, reverted: true });
    expect(fileOf(sections, 'old.ts')).toMatchObject({ renamedFrom: null, after: null });
  });

  it('does not fold a deleted file that was reverted from the review into a rename', () => {
    const gone = removal('old.ts', 'H', { at: 1, resolution: 'reverted' });
    const came = creation('new.ts', 'H', { at: 2 });
    const sections = reviewSections(view({ changes: [gone, came], reverts: [revert([gone])] }), [plan()]);
    expect(fileOf(sections, 'old.ts')).toMatchObject({ renamedFrom: null, reverted: true });
    expect(fileOf(sections, 'new.ts')).toMatchObject({ renamedFrom: null, before: null });
  });

  it('recomputes the totals of the section without the renamed files', () => {
    const history = view({
      changes: [
        removal('old.ts', 'H', { at: 1, removed: 10 }),
        creation('new.ts', 'H', { at: 2, added: 10 }),
        change({ path: 'other.ts', at: 3, beforeHash: 'x', afterHash: 'y', added: 3, removed: 1 }),
      ],
    });
    const [section] = reviewSections(history, [plan()]);
    expect(sorted(paths(section))).toEqual(['new.ts', 'other.ts']);
    expect(section).toMatchObject({ added: 3, removed: 1 });
  });

  it('merges a deleted file of one section with a created file of another', () => {
    const gone = removal('old.ts', 'H', { stepKey: 'a', at: 1 });
    const came = creation('new.ts', 'H', { stepKey: 'b', at: 2 });
    const keep = change({ path: 'keep.ts', stepKey: 'a', beforeHash: 'x', afterHash: 'y', added: 2, removed: 0, at: 3 });
    const sections = reviewSections(view({ changes: [gone, came, keep] }), [plan()]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['p1/a', ['keep.ts']], ['p1/b', ['new.ts']]]);
    expect(sections[0]).toMatchObject({ added: 2, removed: 0 });
    expect(sections[1]!.files[0]).toMatchObject({ renamedFrom: 'old.ts', added: 0, removed: 0 });
  });

  it('removes a section that is left without files', () => {
    const gone = removal('old.ts', 'H', { stepKey: 'a', at: 1 });
    const came = creation('new.ts', 'H', { stepKey: 'b', at: 2 });
    const sections = reviewSections(view({ changes: [gone, came] }), [plan()]);
    expect(sections.map((s) => s.key)).toEqual(['p1/b']);
  });

  it('merges across an out-of-plan section too', () => {
    const gone = removal('old.ts', 'H', { at: 1 });
    const came = creation('new.ts', 'H', { at: 2, planId: null, stepKey: null, outOfPlan: true });
    const sections = reviewSections(view({ changes: [gone, came] }), [plan()]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['outside', ['new.ts']]]);
  });

  it('leaves a deleted file alone when no created file has its content', () => {
    const history = view({ changes: [removal('old.ts', 'H1', { at: 1 }), creation('new.ts', 'H2', { at: 2 })] });
    const sections = reviewSections(history, [plan()]);
    expect(fileOf(sections, 'old.ts')).toMatchObject({ renamedFrom: null, before: 'H1', after: null, removed: 10 });
    expect(fileOf(sections, 'new.ts')).toMatchObject({ renamedFrom: null, before: null, after: 'H2', added: 10 });
  });

  it('keeps two unrelated empty files as a deleted file and a new file', () => {
    const history = view({ changes: [removal('old/empty.txt', 'EMPTY', { at: 1, removed: 0 }), creation('new/empty.txt', 'EMPTY', { at: 2, added: 0 })] });
    const sections = reviewSections(history, [plan()]);
    expect(fileOf(sections, 'old/empty.txt')).toMatchObject({ renamedFrom: null, before: 'EMPTY', after: null });
    expect(fileOf(sections, 'new/empty.txt')).toMatchObject({ renamedFrom: null, before: null, after: 'EMPTY' });
  });

  it('merges a one-line file that was moved', () => {
    const history = view({ changes: [removal('old.txt', 'H', { at: 1, removed: 1 }), creation('new.txt', 'H', { at: 2, added: 1 })] });
    expect(fileOf(reviewSections(history, [plan()]), 'new.txt')).toMatchObject({ renamedFrom: 'old.txt', before: 'H', after: 'H' });
  });

  it('does not take a deleted empty file as the source of a rename', () => {
    const history = view({ changes: [removal('old.txt', 'H', { at: 1, removed: 0 }), creation('new.txt', 'H', { at: 2, added: 10 })] });
    expect(fileOf(reviewSections(history, [plan()]), 'new.txt').renamedFrom).toBeNull();
  });

  it('does not take a new empty file as the target of a rename', () => {
    const history = view({ changes: [removal('old.txt', 'H', { at: 1, removed: 10 }), creation('new.txt', 'H', { at: 2, added: 0 })] });
    expect(fileOf(reviewSections(history, [plan()]), 'new.txt').renamedFrom).toBeNull();
  });

  it('does not merge a modified file that happens to end with the deleted file content', () => {
    const history = view({
      changes: [removal('old.ts', 'H', { at: 1 }), change({ path: 'mod.ts', beforeHash: 'before', afterHash: 'H', at: 2, added: 1 })],
    });
    const sections = reviewSections(history, [plan()]);
    expect(fileOf(sections, 'old.ts').renamedFrom).toBeNull();
    expect(fileOf(sections, 'mod.ts')).toMatchObject({ renamedFrom: null, before: 'before', added: 1 });
  });

  it('lets two created files with identical content consume only one deleted file', () => {
    const history = view({
      changes: [removal('old.ts', 'H', { at: 1 }), creation('copy1.ts', 'H', { at: 2 }), creation('copy2.ts', 'H', { at: 3 })],
    });
    const files = sectionFiles(reviewSections(history, [plan()]));
    expect(files).toHaveLength(2);
    expect(files.filter((f) => f.renamedFrom === 'old.ts')).toHaveLength(1);
    const plainCopy = files.find((f) => f.renamedFrom === null)!;
    expect(plainCopy).toMatchObject({ before: null, after: 'H', added: 10 });
  });

  it('leaves files without any rename untouched', () => {
    const history = view({ changes: [change({ path: 'a.ts', beforeHash: 'x', afterHash: 'y', added: 1, removed: 1 })] });
    const [section] = reviewSections(history, [plan()]);
    expect(section!.files[0]).toMatchObject({ path: 'a.ts', renamedFrom: null, before: 'x', after: 'y', added: 1, removed: 1 });
  });
});

describe('reviewSections with one path in several sections', () => {
  const three = plan({ steps: [step('a', 1), step('b', 2), step('c', 3)] });
  const edit = (path: string, stepKey: string, at: number, beforeHash: string | null, afterHash: string | null, o: Partial<ChangeView> = {}): ChangeView =>
    change({ path, stepKey, at, beforeHash, afterHash, ...o });
  const sectionOf = (sections: ReviewSection[], key: string): ReviewSection | undefined => sections.find((s) => s.key === key);

  it('shows a path edited in two steps once, in the step of its latest change', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const s2 = edit('src/shared.ts', 'b', 3, 'H1', 'H2');
    const ao = edit('src/a-only.ts', 'a', 2, 'x', 'y');
    const bo = edit('src/b-only.ts', 'b', 4, 'x', 'y');
    const sections = reviewSections(view({ changes: [s1, s2, ao, bo] }), [three]);
    expect(sections.map((s) => s.key)).toEqual(['p1/a', 'p1/b']);
    expect(paths(sectionOf(sections, 'p1/a'))).toEqual(['src/a-only.ts']);
    expect(sorted(paths(sectionOf(sections, 'p1/b')))).toEqual(['src/b-only.ts', 'src/shared.ts']);
  });

  it('gives the merged row all change ids by time, the first before and the last after hash', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const s2 = edit('src/shared.ts', 'b', 3, 'H1', 'H2');
    const file = fileOf(reviewSections(view({ changes: [s1, s2] }), [three]), 'src/shared.ts');
    expect(file).toMatchObject({ ids: [s1.id, s2.id], before: 'H0', after: 'H2', renamedFrom: null });
  });

  it('orders the ids by time even when the later change belongs to an earlier step', () => {
    const late = edit('src/shared.ts', 'a', 9, 'H1', 'H2');
    const early = edit('src/shared.ts', 'b', 1, 'H0', 'H1');
    const sections = reviewSections(view({ changes: [late, early] }), [three]);
    expect(sections.map((s) => s.key)).toEqual(['p1/a']);
    expect(sectionFiles(sections)[0]).toMatchObject({ ids: [early.id, late.id], before: 'H0', after: 'H2' });
  });

  it('puts a path edited in three steps into the step of the latest change', () => {
    const c1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const c2 = edit('src/shared.ts', 'c', 2, 'H1', 'H2');
    const c3 = edit('src/shared.ts', 'b', 3, 'H2', 'H3');
    const sections = reviewSections(view({ changes: [c1, c2, c3] }), [three]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['p1/b', ['src/shared.ts']]]);
    expect(sections[0]!.files[0]).toMatchObject({ ids: [c1.id, c2.id, c3.id], before: 'H0', after: 'H3' });
  });

  it('prefers the later change in the history when two changes have the same time', () => {
    const first = edit('src/shared.ts', 'b', 5, 'H0', 'H1');
    const last = edit('src/shared.ts', 'a', 5, 'H1', 'H2');
    const sections = reviewSections(view({ changes: [first, last] }), [three]);
    expect(sections.map((s) => s.key)).toEqual(['p1/a']);
    expect(sectionFiles(sections)[0]!.after).toBe('H2');
  });

  it('adds up the added and removed lines', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1', { added: 3, removed: 1 });
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2', { added: 5, removed: 2 });
    expect(fileOf(reviewSections(view({ changes: [s1, s2] }), [three]), 'src/shared.ts')).toMatchObject({ added: 8, removed: 3 });
  });

  it('collects the tool use ids and event ids of every merged row once', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1', { toolUseIds: ['t1', 't2'], eventId: 'e1' });
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2', { toolUseIds: ['t2', 't3'], eventId: 'e1' });
    const s3 = edit('src/shared.ts', 'c', 3, 'H2', 'H3', { eventId: 'e2' });
    const file = fileOf(reviewSections(view({ changes: [s1, s2, s3] }), [three]), 'src/shared.ts');
    expect(sorted(file.toolUseIds)).toEqual(['t1', 't2', 't3']);
    expect(sorted(file.eventIds)).toEqual(['e1', 'e2']);
  });

  it('removes the path from the other steps and recomputes their totals', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1', { added: 3, removed: 1 });
    const ao = edit('src/a-only.ts', 'a', 2, 'x', 'y', { added: 2, removed: 0 });
    const s2 = edit('src/shared.ts', 'b', 3, 'H1', 'H2', { added: 5, removed: 2 });
    const bo = edit('src/b-only.ts', 'b', 4, 'x', 'y', { added: 4, removed: 4 });
    const sections = reviewSections(view({ changes: [s1, ao, s2, bo] }), [three]);
    expect(sectionOf(sections, 'p1/a')).toMatchObject({ added: 2, removed: 0 });
    expect(sectionOf(sections, 'p1/b')).toMatchObject({ added: 12, removed: 7 });
  });

  it('drops a step that is left without files', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2');
    expect(reviewSections(view({ changes: [s1, s2] }), [three]).map((s) => s.key)).toEqual(['p1/b']);
  });

  it('leaves paths that occur in one section as they are', () => {
    const only = edit('src/only.ts', 'a', 1, 'x', 'y', { added: 2, removed: 1, toolUseIds: ['t1'], eventId: 'e1' });
    const other = edit('src/shared.ts', 'a', 2, 'H0', 'H1');
    const other2 = edit('src/shared.ts', 'b', 3, 'H1', 'H2');
    const file = fileOf(reviewSections(view({ changes: [only, other, other2] }), [three]), 'src/only.ts');
    expect(file).toMatchObject({ ids: [only.id], before: 'x', after: 'y', added: 2, removed: 1, toolUseIds: ['t1'], eventIds: ['e1'], reverted: false, revertId: null });
  });

  it('merges an out-of-plan edit with a step edit into the section of the later one', () => {
    const inStep = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const outside = change({ path: 'src/shared.ts', planId: null, stepKey: null, outOfPlan: true, at: 2, beforeHash: 'H1', afterHash: 'H2' });
    const sections = reviewSections(view({ changes: [inStep, outside] }), [three]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['outside', ['src/shared.ts']]]);
  });

  it('merges a step edit with a later change made outside the agent into the external section', () => {
    const inStep = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const byHand = change({ path: 'src/shared.ts', origin: 'human', planId: null, stepKey: null, at: 2, beforeHash: 'H1', afterHash: 'H2' });
    const sections = reviewSections(view({ changes: [inStep, byHand] }), [three]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['external', ['src/shared.ts']]]);
  });

  it('marks the merged row reverted only when every merged row is reverted', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1', { resolution: 'reverted' });
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2', { resolution: 'reverted' });
    const r1 = revert([s1]);
    const r2 = revert([s2]);
    const file = fileOf(reviewSections(view({ changes: [s1, s2], reverts: [r1, r2] }), [three]), 'src/shared.ts');
    expect(file.reverted).toBe(true);
    expect(file.revertId).toBe(r1.id);
  });

  it('does not mark the merged row reverted when only one of the rows is', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2', { resolution: 'reverted' });
    const r2 = revert([s2]);
    const file = fileOf(reviewSections(view({ changes: [s1, s2], reverts: [r2] }), [three]), 'src/shared.ts');
    expect(file.reverted).toBe(false);
    expect(file.revertId).toBe(r2.id);
  });

  it('does not mark the merged row reverted when only the first of the rows is', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1', { resolution: 'reverted' });
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2');
    const r1 = revert([s1]);
    const file = fileOf(reviewSections(view({ changes: [s1, s2], reverts: [r1] }), [three]), 'src/shared.ts');
    expect(file.reverted).toBe(false);
    expect(file.revertId).toBe(r1.id);
  });

  it('has no revert id when none of the rows was reverted', () => {
    const s1 = edit('src/shared.ts', 'a', 1, 'H0', 'H1');
    const s2 = edit('src/shared.ts', 'b', 2, 'H1', 'H2');
    expect(fileOf(reviewSections(view({ changes: [s1, s2] }), [three]), 'src/shared.ts')).toMatchObject({ reverted: false, revertId: null });
  });

  it('shows a file deleted in one step and recreated unchanged in a later one as a single unchanged row, not as a rename', () => {
    const gone = edit('src/x.ts', 'a', 1, 'H', null, { removed: 10 });
    const back = edit('src/x.ts', 'b', 2, null, 'H', { added: 10 });
    const sections = reviewSections(view({ changes: [gone, back] }), [three]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['p1/b', ['src/x.ts']]]);
    expect(sections[0]!.files[0]).toMatchObject({ before: 'H', after: 'H', renamedFrom: null });
  });

  it('still merges a rename after merging the paths', () => {
    const gone = edit('old.ts', 'a', 1, 'H', null, { removed: 10 });
    const made = edit('new.ts', 'a', 2, null, 'H0', { added: 10 });
    const tweak = edit('new.ts', 'b', 3, 'H0', 'H', { added: 1, removed: 1 });
    const sections = reviewSections(view({ changes: [gone, made, tweak] }), [three]);
    expect(sections.map((s) => [s.key, paths(s)])).toEqual([['p1/b', ['new.ts']]]);
    expect(sections[0]!.files[0]).toMatchObject({ renamedFrom: 'old.ts', ids: [gone.id, made.id, tweak.id] });
  });
});

describe('kindOf', () => {
  const kind = (before: string | null, after: string | null, renamedFrom: string | null = null) => kindOf({ before, after, renamedFrom });

  it('is renamed for a file with a rename source, whatever its hashes', () => {
    expect(kind('h', 'h', 'old.ts')).toBe('renamed');
    expect(kind(null, 'h', 'old.ts')).toBe('renamed');
  });

  it('is new when there was no before and there is an after', () => {
    expect(kind(null, 'h')).toBe('new');
  });

  it('is deleted when there is a before and no after', () => {
    expect(kind('h', null)).toBe('deleted');
  });

  it('is modified when both sides exist', () => {
    expect(kind('a', 'b')).toBe('modified');
  });

  it('is modified when neither side exists', () => {
    expect(kind(null, null)).toBe('modified');
  });

  it('ignores an empty rename source', () => {
    expect(kind('a', 'b', '')).toBe('modified');
  });
});

describe('sectionFiles', () => {
  it('lists the files of all sections in order', () => {
    const history = view({ changes: [change({ stepKey: 'a', path: 'one.ts' }), change({ stepKey: 'b', path: 'two.ts' }), change({ stepKey: 'a', path: 'three.ts', at: 2 })] });
    expect(sectionFiles(reviewSections(history, [plan()])).map((f) => f.path)).toEqual(['one.ts', 'three.ts', 'two.ts']);
  });

  it('is empty without sections', () => {
    expect(sectionFiles([])).toEqual([]);
  });
});
