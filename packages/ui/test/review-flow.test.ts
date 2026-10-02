import { describe, expect, it } from 'vitest';
import type { ReviewItem, ReviewSection } from '../src/history/review-model';
import {
  acceptFiles, fileState, isOpen, nextOpen, requestChanges, settled, step, tally, undoAccept,
  type Decisions, type FileState, type Position,
} from '../src/history/review-flow';

const item = (path: string, o: Partial<ReviewItem> = {}): ReviewItem => ({
  path, ids: [`id-${path}`], before: 'before', after: `${path}#1`, added: 0, removed: 0,
  toolUseIds: [], eventIds: [], reverted: false, revertId: null, renamedFrom: null, ...o,
});
const section = (key: string, ...files: ReviewItem[]): ReviewSection => ({
  key, title: key, outOfPlan: false, summary: null, added: 0, removed: 0, files,
  planId: null, stepKey: null, rationale: null, stepNo: null, stepTotal: 0,
});
const at = (group: string, path: string): Position => ({ group, path });
const none: Decisions = { reviewed: {}, requested: {} };
const decide = (o: Partial<Decisions>): Decisions => ({ ...none, ...o });
const freeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) Object.values(value).forEach(freeze);
  return Object.freeze(value);
};

describe('fileState', () => {
  it('is pending for a file nobody decided on', () => {
    expect(fileState({}, {}, item('a.ts'))).toBe('pending');
  });

  it('is pending when only other files were decided on', () => {
    expect(fileState({ 'b.ts': 'x' }, { 'c.ts': 'y' }, item('a.ts'))).toBe('pending');
  });

  it('is accepted when the accepted hash is the current after hash', () => {
    expect(fileState({ 'a.ts': 'h1' }, {}, item('a.ts', { after: 'h1' }))).toBe('accepted');
  });

  it('is changed when the file moved on after it was accepted', () => {
    expect(fileState({ 'a.ts': 'h1' }, {}, item('a.ts', { after: 'h2' }))).toBe('changed');
  });

  it('is accepted when a deletion was accepted and the file is still deleted', () => {
    expect(fileState({ 'a.ts': null }, {}, item('a.ts', { before: 'h', after: null }))).toBe('accepted');
  });

  it('is changed when a deletion was accepted but the file came back', () => {
    expect(fileState({ 'a.ts': null }, {}, item('a.ts', { after: 'h2' }))).toBe('changed');
  });

  it('is changed when the file was accepted and has been deleted since', () => {
    expect(fileState({ 'a.ts': 'h1' }, {}, item('a.ts', { before: 'h1', after: null }))).toBe('changed');
  });

  it('is requested when changes were requested for the current after hash', () => {
    expect(fileState({}, { 'a.ts': 'h1' }, item('a.ts', { after: 'h1' }))).toBe('requested');
  });

  it('is revised when the agent edited the file after changes were requested', () => {
    expect(fileState({}, { 'a.ts': 'h1' }, item('a.ts', { after: 'h2' }))).toBe('revised');
  });

  it('is requested when changes were requested on a deleted file that is still deleted', () => {
    expect(fileState({}, { 'a.ts': null }, item('a.ts', { before: 'h', after: null }))).toBe('requested');
  });

  it('is revised when changes were requested on a deleted file that came back', () => {
    expect(fileState({}, { 'a.ts': null }, item('a.ts', { after: 'h2' }))).toBe('revised');
  });

  it('is revised when changes were requested and the file has been deleted since', () => {
    expect(fileState({}, { 'a.ts': 'h1' }, item('a.ts', { before: 'h', after: null }))).toBe('revised');
  });

  it('is reverted for a reverted file whatever else is recorded', () => {
    const file = item('a.ts', { after: 'h1', reverted: true });
    expect(fileState({}, {}, file)).toBe('reverted');
    expect(fileState({ 'a.ts': 'h1' }, {}, file)).toBe('reverted');
    expect(fileState({}, { 'a.ts': 'h1' }, file)).toBe('reverted');
    expect(fileState({ 'a.ts': 'h1' }, { 'a.ts': 'h1' }, file)).toBe('reverted');
  });

  it('lets an accepted decision win over an older request for the same file', () => {
    expect(fileState({ 'a.ts': 'h1' }, { 'a.ts': 'h1' }, item('a.ts', { after: 'h1' }))).toBe('accepted');
  });

  it('is pending for a path that is named like an Object.prototype member and was never decided', () => {
    for (const path of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(fileState({}, {}, item(path)), path).toBe('pending');
    }
  });

  it('is requested for a path named like an Object.prototype member when changes were requested', () => {
    const requested = Object.fromEntries([['constructor', 'h1'], ['toString', 'h1']]);
    expect(fileState({}, requested, item('constructor', { after: 'h1' }))).toBe('requested');
    expect(fileState({}, requested, item('toString', { after: 'h1' }))).toBe('requested');
  });
});

describe('isOpen', () => {
  it.each<FileState>(['pending', 'changed', 'revised'])('treats %s as still needing a decision', (state) => {
    expect(isOpen(state)).toBe(true);
  });

  it.each<FileState>(['accepted', 'requested', 'reverted'])('treats %s as decided', (state) => {
    expect(isOpen(state)).toBe(false);
  });
});

describe('acceptFiles', () => {
  it('records the after hash of each accepted file', () => {
    const out = acceptFiles(none, [item('a.ts', { after: 'h1' }), item('b.ts', { after: 'h2' })]);
    expect(out.reviewed).toEqual({ 'a.ts': 'h1', 'b.ts': 'h2' });
  });

  it('records null for a deleted file', () => {
    expect(acceptFiles(none, [item('a.ts', { before: 'h', after: null })]).reviewed).toEqual({ 'a.ts': null });
  });

  it('turns a deleted file that was accepted into an accepted state', () => {
    const file = item('a.ts', { before: 'h', after: null });
    const out = acceptFiles(none, [file]);
    expect(fileState(out.reviewed, out.requested, file)).toBe('accepted');
  });

  it('removes the accepted paths from the requested changes', () => {
    const out = acceptFiles(decide({ requested: { 'a.ts': 'h0', 'b.ts': 'h0' } }), [item('a.ts', { after: 'h1' })]);
    expect(out.requested).toEqual({ 'b.ts': 'h0' });
  });

  it('leaves decisions on other files untouched', () => {
    const out = acceptFiles(decide({ reviewed: { 'old.ts': 'h0' }, requested: { 'other.ts': 'h9' } }), [item('a.ts', { after: 'h1' })]);
    expect(out).toEqual({ reviewed: { 'old.ts': 'h0', 'a.ts': 'h1' }, requested: { 'other.ts': 'h9' } });
  });

  it('replaces an earlier accepted hash of the same file', () => {
    expect(acceptFiles(decide({ reviewed: { 'a.ts': 'h1' } }), [item('a.ts', { after: 'h2' })]).reviewed).toEqual({ 'a.ts': 'h2' });
  });

  it('changes nothing when no files are given', () => {
    const before = decide({ reviewed: { 'a.ts': 'h' }, requested: { 'b.ts': 'h' } });
    expect(acceptFiles(before, [])).toEqual(before);
  });

  it('does not modify the decisions it is given', () => {
    const before = freeze(decide({ reviewed: { 'x.ts': 'h' }, requested: { 'a.ts': 'h0' } }));
    expect(() => acceptFiles(before, [item('a.ts', { after: 'h1' })])).not.toThrow();
    expect(before).toEqual({ reviewed: { 'x.ts': 'h' }, requested: { 'a.ts': 'h0' } });
  });
});

describe('undoAccept', () => {
  it('removes the paths from the accepted files', () => {
    const out = undoAccept(decide({ reviewed: { 'a.ts': 'h1', 'b.ts': 'h2' } }), [item('a.ts')]);
    expect(out.reviewed).toEqual({ 'b.ts': 'h2' });
  });

  it('leaves the requested changes alone', () => {
    const out = undoAccept(decide({ reviewed: { 'a.ts': 'h1' }, requested: { 'b.ts': 'h2', 'a.ts': 'h3' } }), [item('a.ts')]);
    expect(out.requested).toEqual({ 'b.ts': 'h2', 'a.ts': 'h3' });
  });

  it('brings an accepted file back to pending', () => {
    const file = item('a.ts', { after: 'h1' });
    const accepted = acceptFiles(none, [file]);
    const undone = undoAccept(accepted, [file]);
    expect(fileState(undone.reviewed, undone.requested, file)).toBe('pending');
  });

  it('ignores a path that was never accepted', () => {
    const before = decide({ reviewed: { 'a.ts': 'h1' } });
    expect(undoAccept(before, [item('zzz.ts')])).toEqual(before);
  });

  it('does not modify the decisions it is given', () => {
    const before = freeze(decide({ reviewed: { 'a.ts': 'h1' } }));
    expect(() => undoAccept(before, [item('a.ts')])).not.toThrow();
    expect(before.reviewed).toEqual({ 'a.ts': 'h1' });
  });
});

describe('requestChanges', () => {
  it('records the after hash of each file in the requested changes', () => {
    const out = requestChanges(none, [item('a.ts', { after: 'h1' }), item('b.ts', { after: null, before: 'h' })]);
    expect(out.requested).toEqual({ 'a.ts': 'h1', 'b.ts': null });
  });

  it('removes the files from the accepted ones', () => {
    const out = requestChanges(decide({ reviewed: { 'a.ts': 'h1', 'b.ts': 'h2' } }), [item('a.ts', { after: 'h1' })]);
    expect(out.reviewed).toEqual({ 'b.ts': 'h2' });
  });

  it('leaves requests for other files untouched', () => {
    const out = requestChanges(decide({ requested: { 'old.ts': 'h0' } }), [item('a.ts', { after: 'h1' })]);
    expect(out.requested).toEqual({ 'old.ts': 'h0', 'a.ts': 'h1' });
  });

  it('turns an accepted file into a requested one', () => {
    const file = item('a.ts', { after: 'h1' });
    const out = requestChanges(acceptFiles(none, [file]), [file]);
    expect(fileState(out.reviewed, out.requested, file)).toBe('requested');
  });

  it('is replaced again by a later accept', () => {
    const file = item('a.ts', { after: 'h1' });
    const out = acceptFiles(requestChanges(none, [file]), [file]);
    expect(out).toEqual({ reviewed: { 'a.ts': 'h1' }, requested: {} });
  });

  it('does not modify the decisions it is given', () => {
    const before = freeze(decide({ reviewed: { 'a.ts': 'h1' }, requested: { 'x.ts': 'h' } }));
    expect(() => requestChanges(before, [item('a.ts', { after: 'h1' })])).not.toThrow();
    expect(before).toEqual({ reviewed: { 'a.ts': 'h1' }, requested: { 'x.ts': 'h' } });
  });
});

describe('tally', () => {
  it('counts nothing for no sections', () => {
    expect(tally([], none)).toEqual({ accepted: 0, requested: 0, reverted: 0, open: 0, total: 0 });
  });

  it('counts every undecided file as open', () => {
    expect(tally([section('s', item('a.ts'), item('b.ts'))], none)).toEqual({ accepted: 0, requested: 0, reverted: 0, open: 2, total: 2 });
  });

  it('counts each state in its own bucket', () => {
    const files = [
      item('acc.ts', { after: 'h' }), item('req.ts', { after: 'h' }), item('rev.ts', { reverted: true }),
      item('pen.ts'), item('chg.ts', { after: 'new' }), item('rvs.ts', { after: 'new' }),
    ];
    const decisions = decide({ reviewed: { 'acc.ts': 'h', 'chg.ts': 'old' }, requested: { 'req.ts': 'h', 'rvs.ts': 'old' } });
    expect(tally([section('s', ...files)], decisions)).toEqual({ accepted: 1, requested: 1, reverted: 1, open: 3, total: 6 });
  });

  it('counts the files of all sections', () => {
    const sections = [section('one', item('a.ts', { after: 'h' })), section('two', item('b.ts'), item('c.ts', { after: 'h' }))];
    const out = tally(sections, decide({ reviewed: { 'a.ts': 'h', 'c.ts': 'h' } }));
    expect(out).toEqual({ accepted: 2, requested: 0, reverted: 0, open: 1, total: 3 });
  });

  it('counts a path that appears in two sections once per row', () => {
    const sections = [section('one', item('a.ts')), section('two', item('a.ts'))];
    expect(tally(sections, none).total).toBe(2);
  });

  it('counts a reverted file as reverted even when it was accepted before', () => {
    const out = tally([section('s', item('a.ts', { after: 'h', reverted: true }))], decide({ reviewed: { 'a.ts': 'h' } }));
    expect(out).toMatchObject({ accepted: 0, reverted: 1, open: 0 });
  });

  it('ignores sections without files', () => {
    expect(tally([section('empty'), section('s', item('a.ts'))], none).total).toBe(1);
  });
});

describe('settled', () => {
  it('is true when nothing is open', () => {
    expect(settled({ accepted: 1, requested: 1, reverted: 1, open: 0, total: 3 })).toBe(true);
  });

  it('is true for a review without files', () => {
    expect(settled(tally([], none))).toBe(true);
  });

  it('is false while one file is open', () => {
    expect(settled({ accepted: 5, requested: 0, reverted: 0, open: 1, total: 6 })).toBe(false);
  });

  it('is false after an accepted file changed again', () => {
    const sections = [section('s', item('a.ts', { after: 'h2' }))];
    expect(settled(tally(sections, decide({ reviewed: { 'a.ts': 'h1' } })))).toBe(false);
  });
});

describe('nextOpen', () => {
  const sections = [
    section('s1', item('a.ts', { after: 'h' }), item('b.ts', { after: 'h' })),
    section('s2', item('c.ts', { after: 'h' }), item('d.ts', { after: 'h' })),
  ];
  const accepted = (...paths: string[]): Decisions => decide({ reviewed: Object.fromEntries(paths.map((p) => [p, 'h'])) });

  it('is null when no file is open', () => {
    expect(nextOpen(sections, accepted('a.ts', 'b.ts', 'c.ts', 'd.ts'), at('s1', 'a.ts'))).toBeNull();
    expect(nextOpen(sections, accepted('a.ts', 'b.ts', 'c.ts', 'd.ts'), null)).toBeNull();
  });

  it('is null for no sections', () => {
    expect(nextOpen([], none, null)).toBeNull();
  });

  it('starts at the first open file when there is no current one', () => {
    expect(nextOpen(sections, accepted('a.ts'), null)).toEqual(at('s1', 'b.ts'));
    expect(nextOpen(sections, none, null)).toEqual(at('s1', 'a.ts'));
  });

  it('is the next file after the current one', () => {
    expect(nextOpen(sections, none, at('s1', 'a.ts'))).toEqual(at('s1', 'b.ts'));
  });

  it('skips files that are decided', () => {
    expect(nextOpen(sections, accepted('b.ts', 'c.ts'), at('s1', 'a.ts'))).toEqual(at('s2', 'd.ts'));
  });

  it('crosses from one section into the next', () => {
    expect(nextOpen(sections, none, at('s1', 'b.ts'))).toEqual(at('s2', 'c.ts'));
  });

  it('wraps around to the start after the last file', () => {
    expect(nextOpen(sections, none, at('s2', 'd.ts'))).toEqual(at('s1', 'a.ts'));
    expect(nextOpen(sections, accepted('a.ts', 'c.ts', 'd.ts'), at('s2', 'c.ts'))).toEqual(at('s1', 'b.ts'));
  });

  it('does not return the current file when another file is open', () => {
    expect(nextOpen(sections, accepted('a.ts', 'c.ts', 'd.ts'), at('s1', 'a.ts'))).toEqual(at('s1', 'b.ts'));
  });

  it('returns the current file when it is the only open one', () => {
    expect(nextOpen(sections, accepted('a.ts', 'c.ts', 'd.ts'), at('s1', 'b.ts'))).toEqual(at('s1', 'b.ts'));
  });

  it('counts a changed file as open and a requested one as decided', () => {
    const decisions = decide({ reviewed: { 'b.ts': 'stale', 'a.ts': 'h' }, requested: { 'c.ts': 'h' } });
    expect(nextOpen(sections, decisions, at('s1', 'a.ts'))).toEqual(at('s1', 'b.ts'));
    expect(nextOpen(sections, decisions, at('s1', 'b.ts'))).toEqual(at('s2', 'd.ts'));
  });

  it('counts a reverted file as decided', () => {
    const withReverted = [section('s', item('a.ts', { reverted: true }), item('b.ts'))];
    expect(nextOpen(withReverted, none, null)).toEqual(at('s', 'b.ts'));
  });

  it('tells apart the same path in two sections', () => {
    const twice = [section('s1', item('x.ts')), section('s2', item('x.ts'))];
    expect(nextOpen(twice, none, at('s1', 'x.ts'))).toEqual(at('s2', 'x.ts'));
  });

  it('continues after the second of two rows with the same path in different sections', () => {
    const twice = [section('s1', item('x.ts')), section('s2', item('x.ts')), section('s3', item('y.ts', { reverted: true }))];
    expect(nextOpen(twice, none, at('s2', 'x.ts'))).toEqual(at('s1', 'x.ts'));
  });

  it('starts from the beginning when the current file is no longer listed', () => {
    expect(nextOpen(sections, none, at('s9', 'gone.ts'))).toEqual(at('s1', 'a.ts'));
  });
});

describe('step', () => {
  const sections = [section('s1', item('a.ts'), item('b.ts')), section('empty'), section('s2', item('c.ts'))];

  it('is null when there are no files', () => {
    expect(step([], null, 1)).toBeNull();
    expect(step([section('empty')], at('empty', 'x'), -1)).toBeNull();
  });

  it('goes to the first file forwards and the last file backwards when there is no current one', () => {
    expect(step(sections, null, 1)).toEqual(at('s1', 'a.ts'));
    expect(step(sections, null, -1)).toEqual(at('s2', 'c.ts'));
  });

  it('moves by one in the flattened order', () => {
    expect(step(sections, at('s1', 'a.ts'), 1)).toEqual(at('s1', 'b.ts'));
    expect(step(sections, at('s1', 'b.ts'), -1)).toEqual(at('s1', 'a.ts'));
  });

  it('crosses sections, skipping empty ones', () => {
    expect(step(sections, at('s1', 'b.ts'), 1)).toEqual(at('s2', 'c.ts'));
    expect(step(sections, at('s2', 'c.ts'), -1)).toEqual(at('s1', 'b.ts'));
  });

  it('stays on the last file at the end instead of wrapping', () => {
    expect(step(sections, at('s2', 'c.ts'), 1)).toEqual(at('s2', 'c.ts'));
  });

  it('stays on the first file at the start instead of wrapping', () => {
    expect(step(sections, at('s1', 'a.ts'), -1)).toEqual(at('s1', 'a.ts'));
  });

  it('tells apart the same path in two sections', () => {
    const twice = [section('s1', item('x.ts')), section('s2', item('x.ts')), section('s3', item('y.ts'))];
    expect(step(twice, at('s2', 'x.ts'), 1)).toEqual(at('s3', 'y.ts'));
    expect(step(twice, at('s2', 'x.ts'), -1)).toEqual(at('s1', 'x.ts'));
    expect(step(twice, at('s1', 'x.ts'), 1)).toEqual(at('s2', 'x.ts'));
  });

  it('treats a current file that is no longer listed like no current file', () => {
    expect(step(sections, at('s9', 'gone.ts'), 1)).toEqual(at('s1', 'a.ts'));
    expect(step(sections, at('s9', 'gone.ts'), -1)).toEqual(at('s2', 'c.ts'));
  });

  it('does not depend on the decisions: decided files are still visited', () => {
    expect(step([section('s', item('a.ts', { reverted: true }), item('b.ts'))], at('s', 'a.ts'), 1)).toEqual(at('s', 'b.ts'));
  });
});
