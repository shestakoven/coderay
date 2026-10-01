import { describe, expect, it } from 'vitest';
import { accept, loadReviewed, neighbor, nextPending, progress, saveReviewed, statusOf, type Position, type Reviewed } from '../src/history/review-progress';
import type { ReviewFile, ReviewGroup } from '../src/history/review-state';

const file = (path: string, after: string | null = `${path}#1`): ReviewFile => ({ path, ids: [`id-${path}`], before: null, after, added: 0, removed: 0 });
const group = (key: string, ...files: ReviewFile[]): ReviewGroup => ({ key, title: key, outOfPlan: false, summary: null, added: 0, removed: 0, files });
const at = (key: string, path: string): Position => ({ group: key, path });
const done = (...files: ReviewFile[]): Reviewed => Object.fromEntries(files.map((f) => [f.path, f.after]));

describe('statusOf', () => {
  it('is pending for a file that was never accepted', () => {
    expect(statusOf({}, file('a.ts'))).toBe('pending');
  });

  it('is pending when only other files were accepted', () => {
    expect(statusOf({ 'b.ts': 'x' }, file('a.ts', 'x'))).toBe('pending');
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])('is pending for a file named %s that was never accepted', (path) => {
    expect(statusOf({}, file(path))).toBe('pending');
  });

  it('is reviewed when the accepted hash is the current after hash', () => {
    expect(statusOf({ 'a.ts': 'h1' }, file('a.ts', 'h1'))).toBe('reviewed');
  });

  it('is updated when the file changed again after it was accepted', () => {
    expect(statusOf({ 'a.ts': 'h1' }, file('a.ts', 'h2'))).toBe('updated');
  });

  it('is reviewed when a deletion was accepted and the file is still deleted', () => {
    expect(statusOf({ 'a.ts': null }, file('a.ts', null))).toBe('reviewed');
  });

  it('is updated when a file was accepted and has been deleted since', () => {
    expect(statusOf({ 'a.ts': 'h1' }, file('a.ts', null))).toBe('updated');
  });

  it('is updated when a deletion was accepted and the file has been recreated since', () => {
    expect(statusOf({ 'a.ts': null }, file('a.ts', 'h2'))).toBe('updated');
  });
});

describe('accept', () => {
  it('records the after hash of every accepted file', () => {
    expect(accept({}, [file('a.ts', 'h1'), file('b.ts', 'h2')])).toEqual({ 'a.ts': 'h1', 'b.ts': 'h2' });
  });

  it('records null for a deleted file', () => {
    expect(accept({}, [file('a.ts', null)])).toEqual({ 'a.ts': null });
  });

  it('keeps the decisions on other files', () => {
    expect(accept({ 'old.ts': 'h0' }, [file('a.ts', 'h1')])).toEqual({ 'old.ts': 'h0', 'a.ts': 'h1' });
  });

  it('overwrites an earlier decision on the same file with the new after hash', () => {
    expect(accept({ 'a.ts': 'h1' }, [file('a.ts', 'h2')])).toEqual({ 'a.ts': 'h2' });
  });

  it('turns an updated file into a reviewed one', () => {
    const row = file('a.ts', 'h2');
    expect(statusOf(accept({ 'a.ts': 'h1' }, [row]), row)).toBe('reviewed');
  });

  it('changes nothing when no file is accepted', () => {
    expect(accept({ 'a.ts': 'h1' }, [])).toEqual({ 'a.ts': 'h1' });
  });

  it('does not mutate the decisions it was given', () => {
    const before: Reviewed = { 'a.ts': 'h1' };
    accept(before, [file('a.ts', 'h2'), file('b.ts')]);
    expect(before).toEqual({ 'a.ts': 'h1' });
  });
});

describe('progress', () => {
  it('is zero of zero for no groups', () => {
    expect(progress([], {})).toEqual({ done: 0, total: 0 });
  });

  it('is zero of zero for groups without files', () => {
    expect(progress([group('g')], { 'a.ts': 'h' })).toEqual({ done: 0, total: 0 });
  });

  it('counts every row as total and none as done when nothing was accepted', () => {
    expect(progress([group('g1', file('a.ts'), file('b.ts')), group('g2', file('c.ts'))], {})).toEqual({ done: 0, total: 3 });
  });

  it('counts a row as done when the file was accepted', () => {
    const [a, b] = [file('a.ts'), file('b.ts')];
    expect(progress([group('g', a, b)], done(a))).toEqual({ done: 1, total: 2 });
  });

  it('does not count a file that was accepted but has changed since', () => {
    expect(progress([group('g', file('a.ts', 'h2'), file('b.ts', 'k1'))], { 'a.ts': 'h1', 'b.ts': 'k1' })).toEqual({ done: 1, total: 2 });
  });

  it('counts rows of all groups', () => {
    const [a, b, c] = [file('a.ts'), file('b.ts'), file('c.ts')];
    expect(progress([group('g1', a), group('g2', b, c)], done(a, c))).toEqual({ done: 2, total: 3 });
  });

  it('is complete when every row was accepted', () => {
    const [a, b] = [file('a.ts'), file('b.ts', null)];
    expect(progress([group('g', a, b)], done(a, b))).toEqual({ done: 2, total: 2 });
  });
});

describe('nextPending', () => {
  const [a, b, c] = [file('a.ts'), file('b.ts'), file('c.ts')];
  const groups = [group('g1', a, b), group('g2', c)];

  it('returns null when there are no groups', () => {
    expect(nextPending([], {}, null)).toBeNull();
  });

  it('starts at the first pending row when there is no current row', () => {
    expect(nextPending(groups, {}, null)).toEqual(at('g1', 'a.ts'));
  });

  it('starts at the first pending row when the current row is no longer listed', () => {
    expect(nextPending(groups, done(a), at('gone', 'x.ts'))).toEqual(at('g1', 'b.ts'));
  });

  it('skips reviewed rows at the start', () => {
    expect(nextPending(groups, done(a, b), null)).toEqual(at('g2', 'c.ts'));
  });

  it('moves to the row after the current one', () => {
    expect(nextPending(groups, {}, at('g1', 'a.ts'))).toEqual(at('g1', 'b.ts'));
  });

  it('skips reviewed rows after the current one', () => {
    expect(nextPending(groups, done(b), at('g1', 'a.ts'))).toEqual(at('g2', 'c.ts'));
  });

  it('moves on into the next group', () => {
    expect(nextPending(groups, {}, at('g1', 'b.ts'))).toEqual(at('g2', 'c.ts'));
  });

  it('wraps around to an earlier pending row when none is left after the current one', () => {
    expect(nextPending(groups, done(b, c), at('g2', 'c.ts'))).toEqual(at('g1', 'a.ts'));
  });

  it('wraps around past reviewed rows to the first pending one', () => {
    expect(nextPending(groups, done(a, c), at('g2', 'c.ts'))).toEqual(at('g1', 'b.ts'));
  });

  it('returns the current row when it is the only one left to review', () => {
    expect(nextPending(groups, done(a, c), at('g1', 'b.ts'))).toEqual(at('g1', 'b.ts'));
  });

  it('returns null when every row is reviewed', () => {
    expect(nextPending(groups, done(a, b, c), null)).toBeNull();
    expect(nextPending(groups, done(a, b, c), at('g1', 'b.ts'))).toBeNull();
  });

  it('treats an updated row as still needing review', () => {
    expect(nextPending(groups, { 'a.ts': 'stale', 'b.ts': b.after, 'c.ts': c.after }, at('g2', 'c.ts'))).toEqual(at('g1', 'a.ts'));
  });

  it('treats a deleted file accepted as deleted as reviewed', () => {
    const gone = file('gone.ts', null);
    expect(nextPending([group('g', gone, a)], { 'gone.ts': null }, null)).toEqual(at('g', 'a.ts'));
  });

  it('tells apart rows with the same path in different groups', () => {
    const shared = [group('g1', file('x.ts', 'h1')), group('g2', file('x.ts', 'h2')), group('g3', file('y.ts'))];
    expect(nextPending(shared, {}, at('g2', 'x.ts'))).toEqual(at('g3', 'y.ts'));
    expect(nextPending(shared, {}, at('g1', 'x.ts'))).toEqual(at('g2', 'x.ts'));
  });
});

describe('neighbor', () => {
  const groups = [group('g1', file('a.ts'), file('b.ts')), group('g2', file('c.ts'))];

  it('returns null when there are no groups', () => {
    expect(neighbor([], null, 1)).toBeNull();
    expect(neighbor([], at('g', 'a.ts'), -1)).toBeNull();
  });

  it('returns null when the groups have no files', () => {
    expect(neighbor([group('g')], null, 1)).toBeNull();
  });

  it('moves one row forward', () => {
    expect(neighbor(groups, at('g1', 'a.ts'), 1)).toEqual(at('g1', 'b.ts'));
  });

  it('moves one row backward', () => {
    expect(neighbor(groups, at('g1', 'b.ts'), -1)).toEqual(at('g1', 'a.ts'));
  });

  it('crosses a group boundary in both directions', () => {
    expect(neighbor(groups, at('g1', 'b.ts'), 1)).toEqual(at('g2', 'c.ts'));
    expect(neighbor(groups, at('g2', 'c.ts'), -1)).toEqual(at('g1', 'b.ts'));
  });

  it('stays on the last row when moving forward from it', () => {
    expect(neighbor(groups, at('g2', 'c.ts'), 1)).toEqual(at('g2', 'c.ts'));
  });

  it('stays on the first row when moving backward from it', () => {
    expect(neighbor(groups, at('g1', 'a.ts'), -1)).toEqual(at('g1', 'a.ts'));
  });

  it('picks the first row when moving forward from nothing', () => {
    expect(neighbor(groups, null, 1)).toEqual(at('g1', 'a.ts'));
  });

  it('picks the last row when moving backward from nothing', () => {
    expect(neighbor(groups, null, -1)).toEqual(at('g2', 'c.ts'));
  });

  it('picks the first row when moving forward from a row that is no longer listed', () => {
    expect(neighbor(groups, at('gone', 'x.ts'), 1)).toEqual(at('g1', 'a.ts'));
  });

  it('picks the last row when moving backward from a row that is no longer listed', () => {
    expect(neighbor(groups, at('g1', 'gone.ts'), -1)).toEqual(at('g2', 'c.ts'));
  });

  it('returns the only row whichever way it moves', () => {
    const single = [group('g', file('a.ts'))];
    expect([neighbor(single, at('g', 'a.ts'), 1), neighbor(single, at('g', 'a.ts'), -1)]).toEqual([at('g', 'a.ts'), at('g', 'a.ts')]);
  });

  it('tells apart rows with the same path in different groups', () => {
    const shared = [group('g1', file('x.ts')), group('g2', file('x.ts')), group('g3', file('y.ts'))];
    expect(neighbor(shared, at('g2', 'x.ts'), 1)).toEqual(at('g3', 'y.ts'));
    expect(neighbor(shared, at('g2', 'x.ts'), -1)).toEqual(at('g1', 'x.ts'));
  });
});

describe('loadReviewed and saveReviewed', () => {
  const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  };
  const throwing = () => {
    throw new Error('storage is disabled');
  };

  it('loads nothing when there is no storage', () => {
    expect(loadReviewed(undefined, '/repo')).toEqual({});
  });

  it('loads nothing when nothing was saved for the project', () => {
    expect(loadReviewed(memory(), '/repo')).toEqual({});
  });

  it('loads back what was saved, including deleted files', () => {
    const storage = memory();
    const reviewed: Reviewed = { 'a.ts': 'h1', 'gone.ts': null };
    saveReviewed(storage, '/repo', reviewed);
    expect(loadReviewed(storage, '/repo')).toEqual(reviewed);
  });

  it('keeps the decisions of different projects apart', () => {
    const storage = memory();
    saveReviewed(storage, '/one', { 'a.ts': 'h1' });
    saveReviewed(storage, '/two', { 'b.ts': 'h2' });
    expect([loadReviewed(storage, '/one'), loadReviewed(storage, '/two'), loadReviewed(storage, '/three')]).toEqual([{ 'a.ts': 'h1' }, { 'b.ts': 'h2' }, {}]);
  });

  it('stores the decisions as JSON under a key of the project', () => {
    const storage = memory();
    saveReviewed(storage, '/repo', { 'a.ts': 'h1' });
    expect([...storage.data]).toEqual([['ide.review./repo', '{"a.ts":"h1"}']]);
  });

  it('replaces the earlier decisions on save', () => {
    const storage = memory();
    saveReviewed(storage, '/repo', { 'a.ts': 'h1' });
    saveReviewed(storage, '/repo', {});
    expect(loadReviewed(storage, '/repo')).toEqual({});
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['an empty string', ''],
    ['a JSON array', '["a.ts"]'],
    ['a JSON array of pairs', '[["a.ts","h"]]'],
    ['JSON null', 'null'],
    ['a JSON number', '5'],
    ['a JSON string', '"a.ts"'],
    ['a JSON boolean', 'true'],
  ])('loads nothing from %s', (_, raw) => {
    expect(loadReviewed(memory({ 'ide.review./repo': raw }), '/repo')).toEqual({});
  });

  it('drops entries whose value is neither a string nor null and keeps the rest', () => {
    const raw = JSON.stringify({ 'a.ts': 'h1', 'n.ts': 5, 'gone.ts': null, 'o.ts': { x: 1 }, 'l.ts': ['h'], 'b.ts': true, 'c.ts': 'h3' });
    expect(loadReviewed(memory({ 'ide.review./repo': raw }), '/repo')).toEqual({ 'a.ts': 'h1', 'gone.ts': null, 'c.ts': 'h3' });
  });

  it('loads nothing when reading from storage throws', () => {
    expect(loadReviewed({ getItem: throwing }, '/repo')).toEqual({});
  });

  it('does not throw when writing to storage throws', () => {
    expect(() => saveReviewed({ setItem: throwing }, '/repo', { 'a.ts': 'h1' })).not.toThrow();
  });

  it('does not throw without storage', () => {
    expect(() => saveReviewed(undefined, '/repo', { 'a.ts': 'h1' })).not.toThrow();
  });
});
