import { describe, expect, it } from 'vitest';
import type { DiffHunk, FileDiff } from '@ide/protocol';
import {
  anchorKey, anchorsOf, blocksOf, colorRows, diffKind, firstChanged, firstChangedAnchor, foldOf, hunkAt, limitRows, lineTexts, markPairs,
  primaryAnchor, rowsOf, splitRows, stepHunk, type Block, type FileKind, type Row,
} from '../src/history/diff-rows';

// ' text' is a context line, '-text' a removed line, '+text' an added line.
const hunk = (oldStart: number, newStart: number, ...spec: string[]): DiffHunk => {
  const lines = spec.map((line) => ({ op: line[0] === '-' ? ('del' as const) : line[0] === '+' ? ('add' as const) : ('context' as const), text: line.slice(1) }));
  return {
    oldStart, newStart, lines,
    oldLines: lines.filter((line) => line.op !== 'add').length,
    newLines: lines.filter((line) => line.op !== 'del').length,
  };
};
const diff = (...hunks: DiffHunk[]): FileDiff => ({ binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks });
const row = (op: Row['op'], oldNo: number | null, newNo: number | null, text: string): Row => ({ op, oldNo, newNo, text });
const rowsFrom = (...spec: string[]): Row[] => rowsOf(hunk(1, 1, ...spec));
const block = (rows: Row[], index = 0): Block => ({ index, header: `@@ ${index} @@`, oldStart: 1, newStart: 1, rows, added: 0, removed: 0 });
const plainRows = (count: number): Row[] => Array.from({ length: count }, (_, i) => row('add', null, i + 1, `line ${i}`));
const joined = (r: Row): string => (r.segments ?? []).map((part) => part.text).join('');
const changedText = (r: Row): string[] => (r.segments ?? []).filter((part) => part.changed).map((part) => part.text);

describe('rowsOf', () => {
  it('returns no rows for a hunk without lines', () => {
    expect(rowsOf(hunk(5, 5))).toEqual([]);
  });

  it('numbers context lines on both sides starting at the hunk start', () => {
    expect(rowsOf(hunk(10, 12, ' a', ' b'))).toEqual([row('context', 10, 12, 'a'), row('context', 11, 13, 'b')]);
  });

  it('gives a removed line only an old number and an added line only a new number', () => {
    expect(rowsOf(hunk(3, 3, '-gone', '+came'))).toEqual([row('del', 3, null, 'gone'), row('add', null, 3, 'came')]);
  });

  it('advances the old counter for removed lines and the new counter for added lines independently', () => {
    expect(rowsOf(hunk(10, 12, ' c1', '-d1', '-d2', '+a1', ' c2'))).toEqual([
      row('context', 10, 12, 'c1'),
      row('del', 11, null, 'd1'),
      row('del', 12, null, 'd2'),
      row('add', null, 13, 'a1'),
      row('context', 13, 14, 'c2'),
    ]);
  });

  it('numbers an added file from new line 1 when the old side starts at 0', () => {
    expect(rowsOf(hunk(0, 1, '+one', '+two'))).toEqual([row('add', null, 1, 'one'), row('add', null, 2, 'two')]);
  });

  it('keeps line text exactly, including leading whitespace and empty lines', () => {
    const texts = rowsOf(hunk(1, 1, ' \t  indented', ' ', '+')).map((r) => r.text);
    expect(texts).toEqual(['\t  indented', '', '']);
  });
});

describe('splitRows', () => {
  it('returns nothing for no rows', () => {
    expect(splitRows([])).toEqual([]);
  });

  it('shows a context row on both sides', () => {
    const [context] = rowsFrom(' same');
    const [split] = splitRows([context!]);
    expect(split!.left).toBe(context);
    expect(split!.right).toBe(context);
  });

  it('pairs removed and added lines index by index', () => {
    const rows = rowsFrom('-d1', '-d2', '+a1', '+a2');
    expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[2] }, { left: rows[1], right: rows[3] }]);
  });

  it('leaves the right side empty for surplus removed lines', () => {
    const rows = rowsFrom('-d1', '-d2', '-d3', '+a1');
    expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[3] }, { left: rows[1], right: null }, { left: rows[2], right: null }]);
  });

  it('leaves the left side empty for surplus added lines', () => {
    const rows = rowsFrom('-d1', '+a1', '+a2', '+a3');
    expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[1] }, { left: null, right: rows[2] }, { left: null, right: rows[3] }]);
  });

  it('faces a lone added run against empty cells', () => {
    const rows = rowsFrom(' ctx', '+a1', '+a2');
    expect(splitRows(rows).slice(1)).toEqual([{ left: null, right: rows[1] }, { left: null, right: rows[2] }]);
  });

  it('faces a lone removed run against empty cells', () => {
    const rows = rowsFrom('-d1', '-d2', ' ctx');
    expect(splitRows(rows).slice(0, 2)).toEqual([{ left: rows[0], right: null }, { left: rows[1], right: null }]);
  });

  it('keeps the order of context rows and change runs', () => {
    const rows = rowsFrom(' c1', '-d1', '+a1', ' c2', '-d2', '-d3', '+a2', ' c3');
    const split = splitRows(rows);
    expect(split).toEqual([
      { left: rows[0], right: rows[0] },
      { left: rows[1], right: rows[2] },
      { left: rows[3], right: rows[3] },
      { left: rows[4], right: rows[6] },
      { left: rows[5], right: null },
      { left: rows[7], right: rows[7] },
    ]);
  });

  it('does not lose or invent rows when an added run comes before a removed run', () => {
    const rows = rowsFrom('+a1', '-d1');
    expect(splitRows(rows)).toEqual([{ left: null, right: rows[0] }, { left: rows[1], right: null }]);
  });

  describe('with matched pairs', () => {
    const marked = (...spec: string[]): Row[] => {
      const rows = rowsFrom(...spec);
      markPairs(rows);
      return rows;
    };

    it('faces a removed line without a match against nothing when its added line belongs to the next removed line', () => {
      const rows = marked('-completely unrelated removed line', '-const total = items.length;', '+const total = items.size;');
      expect(splitRows(rows)).toEqual([{ left: rows[0], right: null }, { left: rows[1], right: rows[2] }]);
    });

    it('puts an added line that matches nothing on its own row before the matched added line', () => {
      const rows = marked('-const total = items.length;', '+import x from "y";', '+const total = items.size;');
      expect(splitRows(rows)).toEqual([{ left: null, right: rows[1] }, { left: rows[0], right: rows[2] }]);
    });

    it('keeps several unmatched added lines before a matched one in order', () => {
      const rows = marked('-const total = items.length;', '+first new line', '+second new line', '+const total = items.size;');
      expect(splitRows(rows)).toEqual([{ left: null, right: rows[1] }, { left: null, right: rows[2] }, { left: rows[0], right: rows[3] }]);
    });

    it('faces matched removed and added lines in order', () => {
      const rows = marked('-const a = first(1);', '-const b = second(2);', '+const a = first(10);', '+const b = second(20);');
      expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[2] }, { left: rows[1], right: rows[3] }]);
    });

    it('still pairs unmatched removed and added lines by position', () => {
      const rows = marked('-alpha beta gamma', '-delta epsilon zeta', '+one two three', '+four five six');
      expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[2] }, { left: rows[1], right: rows[3] }]);
    });

    it('puts added lines left over after the matched ones on rows of their own', () => {
      const rows = marked('-const total = items.length;', '+const total = items.size;', '+brand new line');
      expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[1] }, { left: null, right: rows[2] }]);
    });

    it('mixes unmatched removed lines before and after a matched one', () => {
      const rows = marked('-completely unrelated removed line', '-const total = items.length;', '-another removed line', '+const total = items.size;', '+brand new line');
      expect(splitRows(rows)).toEqual([
        { left: rows[0], right: null },
        { left: rows[1], right: rows[3] },
        { left: rows[2], right: rows[4] },
      ]);
    });

    it('treats each run of changes on its own', () => {
      const rows = marked('-const a = first(1);', '+const a = first(10);', ' same', '-unrelated removed line', '-const total = items.length;', '+const total = items.size;');
      expect(splitRows(rows)).toEqual([
        { left: rows[0], right: rows[1] },
        { left: rows[2], right: rows[2] },
        { left: rows[3], right: null },
        { left: rows[4], right: rows[5] },
      ]);
    });

    it('shows every changed row exactly once', () => {
      const rows = marked('-completely unrelated removed line', '-const total = items.length;', '+import x from "y";', '+const total = items.size;', '+tail');
      const cells = splitRows(rows).flatMap((pair) => [pair.left, pair.right]).filter((cell): cell is Row => cell !== null);
      expect(cells.map((cell) => cell.text).sort()).toEqual(rows.map((r) => r.text).sort());
    });

    it('follows a pair link that was set by hand', () => {
      const rows = rowsFrom('-first removed', '-second removed', '+one', '+two', '+three');
      rows[0]!.pair = rows[3]!;
      rows[1]!.pair = rows[4]!;
      expect(splitRows(rows)).toEqual([
        { left: null, right: rows[2] },
        { left: rows[0], right: rows[3] },
        { left: rows[1], right: rows[4] },
      ]);
    });

    it('lets an unlinked removed line take the first added line that no pair claims', () => {
      const rows = rowsFrom('-first removed', '-second removed', '+one', '+two', '+three');
      rows[1]!.pair = rows[2]!;
      expect(splitRows(rows)).toEqual([
        { left: rows[0], right: null },
        { left: rows[1], right: rows[2] },
        { left: null, right: rows[3] },
        { left: null, right: rows[4] },
      ]);
    });

    it('ignores a pair link to a row outside its own run', () => {
      const rows = rowsFrom('-removed', '+added', ' same', '+elsewhere');
      rows[0]!.pair = rows[3]!;
      expect(splitRows(rows)).toEqual([{ left: rows[0], right: rows[1] }, { left: rows[2], right: rows[2] }, { left: null, right: rows[3] }]);
    });
  });

  it('puts every removed and added row in exactly one cell', () => {
    const rows = rowsFrom('-d1', '-d2', '+a1', ' c', '+a2', '+a3', '-d3');
    const cells = splitRows(rows).flatMap((pair) => [pair.left, pair.right]).filter((cell): cell is Row => cell !== null && cell.op !== 'context');
    expect(cells.map((cell) => cell.text).sort()).toEqual(['a1', 'a2', 'a3', 'd1', 'd2', 'd3']);
  });
});

describe('markPairs', () => {
  it('marks the changed word on both sides of a similar removed and added line', () => {
    const rows = rowsFrom('-const total = items.length;', '+const total = items.size;');
    markPairs(rows);
    expect(changedText(rows[0]!)).toEqual(['length']);
    expect(changedText(rows[1]!)).toEqual(['size']);
  });

  it('keeps the full line text in the segments of a marked line', () => {
    const rows = rowsFrom('-const total = items.length;', '+const total = items.size;');
    markPairs(rows);
    expect(joined(rows[0]!)).toBe('const total = items.length;');
    expect(joined(rows[1]!)).toBe('const total = items.size;');
  });

  it('links a removed line to the added line it was matched with, and only that way round', () => {
    const rows = rowsFrom('-const total = items.length;', '+const total = items.size;');
    markPairs(rows);
    expect(rows[0]!.pair).toBe(rows[1]);
    expect(rows[1]!.pair).toBeUndefined();
  });

  it('links each removed line to its own added line', () => {
    const rows = rowsFrom('-const a = first(1);', '-const b = second(2);', '+const a = first(10);', '+const b = second(20);');
    markPairs(rows);
    expect(rows[0]!.pair).toBe(rows[2]);
    expect(rows[1]!.pair).toBe(rows[3]);
  });

  it('does not link a removed line that found no match', () => {
    const rows = rowsFrom('-foo(bar)', '+completely different text here');
    markPairs(rows);
    expect(rows[0]!.pair).toBeUndefined();
    expect(rows[1]!.pair).toBeUndefined();
  });

  it('leaves a completely rewritten line unmarked', () => {
    const rows = rowsFrom('-foo(bar)', '+completely different text here');
    markPairs(rows);
    expect(rows[0]!.segments).toBeUndefined();
    expect(rows[1]!.segments).toBeUndefined();
  });

  it('marks a pair that is exactly half unchanged', () => {
    const rows = rowsFrom('-a;bc', '+a;xy');
    markPairs(rows);
    expect(changedText(rows[0]!)).toEqual(['bc']);
    expect(changedText(rows[1]!)).toEqual(['xy']);
  });

  it('leaves a pair unmarked when less than half of it is unchanged', () => {
    const rows = rowsFrom('-a;bcd', '+a;xyz');
    markPairs(rows);
    expect(rows[0]!.segments).toBeUndefined();
    expect(rows[1]!.segments).toBeUndefined();
  });

  it('requires both sides to be at least half unchanged, not just one', () => {
    const rows = rowsFrom('-foo bar baz qux', '+foo');
    markPairs(rows);
    expect(rows[0]!.segments).toBeUndefined();
    expect(rows[1]!.segments).toBeUndefined();
  });

  it('marks the first of two equally similar added lines and leaves the other', () => {
    const rows = rowsFrom('-const total = items.length;', '+const total = items.size;', '+const total = items.size;');
    markPairs(rows);
    expect(changedText(rows[1]!)).toEqual(['size']);
    expect(rows[2]!.segments).toBeUndefined();
  });

  it('pairs an added line with at most one removed line', () => {
    const rows = rowsFrom('-const total = items.length;', '-const total = items.length + 1;', '+const total = items.size;');
    markPairs(rows);
    expect(changedText(rows[0]!)).toEqual(['length']);
    expect(rows[1]!.segments).toBeUndefined();
    expect(changedText(rows[2]!)).toEqual(['size']);
  });

  it('does not mark a pair of empty lines', () => {
    const rows = rowsFrom('-', '+');
    markPairs(rows);
    expect(rows.every((r) => r.segments === undefined)).toBe(true);
  });

  it('pairs removed and added lines in order', () => {
    const rows = rowsFrom('-const a = first(1);', '-const b = second(2);', '+const a = first(10);', '+const b = second(20);');
    markPairs(rows);
    expect(changedText(rows[0]!)).toEqual(['1']);
    expect(changedText(rows[2]!)).toEqual(['10']);
    expect(changedText(rows[1]!)).toEqual(['2']);
    expect(changedText(rows[3]!)).toEqual(['20']);
  });

  it('skips an unrelated added line to find the similar one nearby', () => {
    const rows = rowsFrom('-const total = items.length;', '+import x from "y";', '+const total = items.size;');
    markPairs(rows);
    expect(rows[1]!.segments).toBeUndefined();
    expect(changedText(rows[0]!)).toEqual(['length']);
    expect(changedText(rows[2]!)).toEqual(['size']);
  });

  it('reaches a similar added line up to three lines down', () => {
    const rows = rowsFrom('-const total = items.length;', '+one', '+two', '+const total = items.size;');
    markPairs(rows);
    expect(changedText(rows[3]!)).toEqual(['size']);
  });

  it('does not look further than three added lines', () => {
    const rows = rowsFrom('-const total = items.length;', '+one', '+two', '+three', '+const total = items.size;');
    markPairs(rows);
    expect(rows.every((r) => r.segments === undefined)).toBe(true);
  });

  it('pairs a removed line with the most similar of the nearby added lines', () => {
    const rows = rowsFrom('-const total = compute(items, 1);', '+const total = compute(items, 1, 2, 3, 4);', '+const total = compute(items, 2);');
    markPairs(rows);
    expect(rows[1]!.segments).toBeUndefined();
    expect(changedText(rows[2]!)).toEqual(['2']);
  });

  it('marks pairs in a later run after context lines', () => {
    const rows = rowsFrom('-a = 1;', '+a = 2;', ' same', '-b = 10;', '+b = 20;');
    markPairs(rows);
    expect(changedText(rows[3]!)).toEqual(['10']);
    expect(changedText(rows[4]!)).toEqual(['20']);
  });

  it('never marks context rows, lone removed rows or lone added rows', () => {
    const rows = rowsFrom(' keep this line', '-only removed line', ' mid', '+only added line');
    markPairs(rows);
    expect(rows.every((r) => r.segments === undefined)).toBe(true);
  });

  it('leaves similar lines unmarked when they are too long for a word diff', () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    const rows = rowsFrom(`-${long} end`, `+${long} fin`);
    markPairs(rows);
    expect(rows[0]!.segments).toBeUndefined();
    expect(rows[1]!.segments).toBeUndefined();
  });
});

describe('foldOf', () => {
  const blocks = (total: number): Block[] => [block(plainRows(total))];

  it.each<FileKind>(['modified', 'renamed', 'binary'])('never folds a %s file however long', (kind) => {
    expect(foldOf(kind, blocks(5000), 0)).toBeNull();
  });

  it.each<FileKind>(['new', 'deleted'])('does not fold a %s file of 550 rows', (kind) => {
    expect(foldOf(kind, blocks(550), 0)).toBeNull();
  });

  it.each<FileKind>(['new', 'deleted'])('folds a %s file of 551 rows after the first 300', (kind) => {
    expect(foldOf(kind, blocks(551), 0)).toEqual({ visible: 300, hidden: 251, total: 551 });
  });

  it('counts rows across all blocks', () => {
    expect(foldOf('new', [block(plainRows(300), 0), block(plainRows(251), 1)], 0)).toEqual({ visible: 300, hidden: 251, total: 551 });
  });

  it('shows the requested number of rows once it exceeds the initial 300', () => {
    expect(foldOf('new', blocks(2000), 800)).toEqual({ visible: 800, hidden: 1200, total: 2000 });
  });

  it('never shows fewer than 300 rows however small the limit', () => {
    expect(foldOf('new', blocks(2000), 10)).toEqual({ visible: 300, hidden: 1700, total: 2000 });
    expect(foldOf('new', blocks(2000), 299)).toEqual({ visible: 300, hidden: 1700, total: 2000 });
    expect(foldOf('new', blocks(2000), -50)).toEqual({ visible: 300, hidden: 1700, total: 2000 });
  });

  it('shows exactly the limit when it is 301', () => {
    expect(foldOf('new', blocks(2000), 301)).toEqual({ visible: 301, hidden: 1699, total: 2000 });
  });

  it('never shows more rows than the file has and hides nothing then', () => {
    expect(foldOf('new', blocks(600), 99_999)).toEqual({ visible: 600, hidden: 0, total: 600 });
  });

  it('does not fold a file without rows', () => {
    expect(foldOf('deleted', [], 0)).toBeNull();
  });
});

describe('limitRows', () => {
  const two = (): Block[] => [block(plainRows(4), 0), block(plainRows(3), 1)];

  it('returns every block when the limit covers all rows', () => {
    expect(limitRows(two(), 7)).toEqual(two());
    expect(limitRows(two(), 100)).toEqual(two());
  });

  it('cuts inside the first block and drops the rest', () => {
    const out = limitRows(two(), 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.rows.map((r) => r.text)).toEqual(['line 0', 'line 1']);
  });

  it('drops the following block when the limit ends exactly at a block boundary', () => {
    const out = limitRows(two(), 4);
    expect(out.map((b) => b.index)).toEqual([0]);
    expect(out[0]!.rows).toHaveLength(4);
  });

  it('cuts inside a later block and keeps the whole earlier ones', () => {
    const out = limitRows(two(), 5);
    expect(out.map((b) => b.rows.length)).toEqual([4, 1]);
    expect(out[1]!.index).toBe(1);
  });

  it('keeps the other fields of a cut block', () => {
    const [cut] = limitRows([{ ...block(plainRows(5)), header: '@@ h @@', oldStart: 7, newStart: 9, added: 5 }], 2);
    expect(cut).toMatchObject({ header: '@@ h @@', oldStart: 7, newStart: 9, added: 5 });
  });

  it('returns nothing for a limit of zero or less', () => {
    expect(limitRows(two(), 0)).toEqual([]);
    expect(limitRows(two(), -3)).toEqual([]);
  });

  it('does not modify the blocks it is given', () => {
    const input = two();
    limitRows(input, 2);
    expect(input[0]!.rows).toHaveLength(4);
  });
});

describe('diffKind', () => {
  const plain = diff();
  const binary: FileDiff = { ...plain, binary: true };

  it('is binary whatever the hashes say', () => {
    expect(diffKind(binary, null, 'h', 'old.ts')).toBe('binary');
    expect(diffKind(binary, 'a', 'b')).toBe('binary');
  });

  it('is renamed when a rename source is given, even if the file looks new', () => {
    expect(diffKind(plain, null, 'h', 'old.ts')).toBe('renamed');
    expect(diffKind(plain, 'h', 'h', 'old.ts')).toBe('renamed');
  });

  it('is new when there was no before and there is an after', () => {
    expect(diffKind(plain, null, 'h')).toBe('new');
  });

  it('is deleted when there is a before and no after', () => {
    expect(diffKind(plain, 'h', null)).toBe('deleted');
  });

  it('is modified when both sides exist', () => {
    expect(diffKind(plain, 'a', 'b')).toBe('modified');
  });

  it('is modified when neither side exists', () => {
    expect(diffKind(plain, null, null)).toBe('modified');
  });

  it('ignores an empty or null rename source', () => {
    expect(diffKind(plain, 'a', 'b', '')).toBe('modified');
    expect(diffKind(plain, null, 'b', null)).toBe('new');
    expect(diffKind(plain, 'a', null, undefined)).toBe('deleted');
  });
});

describe('hunkAt', () => {
  const tops = [0, 100, 250, 400];

  it('is the first hunk for an empty list', () => {
    expect(hunkAt([], 500)).toBe(0);
  });

  it('is the first hunk when the offset is above every top', () => {
    expect(hunkAt([50, 100], 10)).toBe(0);
    expect(hunkAt([50, 100], -1)).toBe(0);
  });

  it('is the hunk whose top equals the offset', () => {
    expect(hunkAt(tops, 100)).toBe(1);
    expect(hunkAt(tops, 400)).toBe(3);
  });

  it('is still the previous hunk one pixel before the next top', () => {
    expect(hunkAt(tops, 99)).toBe(0);
    expect(hunkAt(tops, 249)).toBe(1);
  });

  it('is the last hunk when the offset is below every top', () => {
    expect(hunkAt(tops, 10_000)).toBe(3);
  });

  it('is the middle hunk between two tops', () => {
    expect(hunkAt(tops, 300)).toBe(2);
  });
});

describe('stepHunk', () => {
  it('moves forward and back by one', () => {
    expect(stepHunk(1, 1, 4)).toBe(2);
    expect(stepHunk(2, -1, 4)).toBe(1);
  });

  it('stays on the last hunk when stepping past the end', () => {
    expect(stepHunk(3, 1, 4)).toBe(3);
  });

  it('stays on the first hunk when stepping before the start', () => {
    expect(stepHunk(0, -1, 4)).toBe(0);
  });

  it('is 0 when there are no hunks', () => {
    expect(stepHunk(0, 1, 0)).toBe(0);
    expect(stepHunk(5, -1, 0)).toBe(0);
  });

  it('pulls an out-of-range current hunk back inside', () => {
    expect(stepHunk(10, -1, 3)).toBe(2);
    expect(stepHunk(-5, 1, 3)).toBe(0);
  });

  it('stays on the only hunk', () => {
    expect(stepHunk(0, 1, 1)).toBe(0);
    expect(stepHunk(0, -1, 1)).toBe(0);
  });
});

describe('anchors', () => {
  it('formats the key as side:line', () => {
    expect(anchorKey('old', 12)).toBe('old:12');
    expect(anchorKey('new', 3)).toBe('new:3');
  });

  it('addresses a removed row by its old number only', () => {
    expect(anchorsOf(row('del', 7, null, 'gone'))).toEqual([{ side: 'old', line: 7, text: 'gone' }]);
    expect(primaryAnchor(row('del', 7, null, 'gone'))).toEqual({ side: 'old', line: 7, text: 'gone' });
  });

  it('addresses an added row by its new number only', () => {
    expect(anchorsOf(row('add', null, 9, 'came'))).toEqual([{ side: 'new', line: 9, text: 'came' }]);
    expect(primaryAnchor(row('add', null, 9, 'came'))).toEqual({ side: 'new', line: 9, text: 'came' });
  });

  it('addresses a context row on both sides but prefers the new number as primary', () => {
    const context = row('context', 4, 6, 'same');
    expect(anchorsOf(context)).toHaveLength(2);
    expect(anchorsOf(context)).toEqual(expect.arrayContaining([{ side: 'old', line: 4, text: 'same' }, { side: 'new', line: 6, text: 'same' }]));
    expect(primaryAnchor(context)).toEqual({ side: 'new', line: 6, text: 'same' });
  });
});

describe('lineTexts', () => {
  it('maps no keys for a diff without hunks', () => {
    expect(lineTexts(diff()).size).toBe(0);
  });

  it('keys removed lines on the old side and added lines on the new side', () => {
    const texts = lineTexts(diff(hunk(5, 5, '-gone', '+came')));
    expect(texts.get('old:5')).toBe('gone');
    expect(texts.get('new:5')).toBe('came');
    expect(texts.size).toBe(2);
  });

  it('keys a context line on both sides', () => {
    const texts = lineTexts(diff(hunk(10, 12, ' same')));
    expect(texts.get('old:10')).toBe('same');
    expect(texts.get('new:12')).toBe('same');
    expect(texts.size).toBe(2);
  });

  it('keeps the text of the old and the new line with the same number apart', () => {
    const texts = lineTexts(diff(hunk(1, 1, '-old one', '+new one')));
    expect(texts.get(anchorKey('old', 1))).toBe('old one');
    expect(texts.get(anchorKey('new', 1))).toBe('new one');
  });

  it('covers every hunk', () => {
    const texts = lineTexts(diff(hunk(1, 1, '+a'), hunk(40, 41, ' b', '-c')));
    expect([...texts.keys()].sort()).toEqual(['new:1', 'new:41', 'old:40', 'old:41']);
    expect(texts.get('old:41')).toBe('c');
  });
});

describe('firstChangedAnchor', () => {
  it('anchors on the first changed line, skipping leading context', () => {
    expect(firstChangedAnchor(diff(hunk(10, 10, ' a', ' b', '+c', '-d')), 0)).toEqual({ side: 'new', line: 12, text: 'c' });
  });

  it('anchors a removed first change on the old side', () => {
    expect(firstChangedAnchor(diff(hunk(10, 20, ' a', '-b', '+c')), 0)).toEqual({ side: 'old', line: 11, text: 'b' });
  });

  it('falls back to the first row when the hunk only has context', () => {
    expect(firstChangedAnchor(diff(hunk(3, 5, ' a', ' b')), 0)).toEqual({ side: 'new', line: 5, text: 'a' });
  });

  it('uses the hunk at the given index', () => {
    const d = diff(hunk(1, 1, '+first'), hunk(50, 60, ' x', '-second'));
    expect(firstChangedAnchor(d, 1)).toEqual({ side: 'old', line: 51, text: 'second' });
  });

  it('is null for a hunk that does not exist', () => {
    expect(firstChangedAnchor(diff(hunk(1, 1, '+a')), 1)).toBeNull();
    expect(firstChangedAnchor(diff(hunk(1, 1, '+a')), -1)).toBeNull();
    expect(firstChangedAnchor(diff(), 0)).toBeNull();
  });

  it('is null for a hunk without lines', () => {
    expect(firstChangedAnchor(diff(hunk(1, 1)), 0)).toBeNull();
  });
});

describe('firstChanged', () => {
  it('is the first row that is not context', () => {
    const rows = rowsFrom(' a', ' b', '-c', '+d');
    expect(firstChanged(block(rows))).toBe(rows[2]);
  });

  it('falls back to the first row of a block with only context', () => {
    const rows = rowsFrom(' a', ' b');
    expect(firstChanged(block(rows))).toBe(rows[0]);
  });

  it('is null for a block without rows', () => {
    expect(firstChanged(block([]))).toBeNull();
  });
});

describe('colorRows', () => {
  const lengths = (rows: Row[]): (number | undefined)[] => rows.map((r) => r.classes?.length);

  it('does not throw and adds no classes for an unknown extension', () => {
    const rows = rowsFrom(' plain text', '-old', '+new');
    expect(() => colorRows('notes.unknownext', rows)).not.toThrow();
    expect(rows.every((r) => r.classes === undefined)).toBe(true);
  });

  it('does not throw and adds no classes for a file without an extension', () => {
    const rows = rowsFrom(' plain text');
    expect(() => colorRows('Makefile', rows)).not.toThrow();
    expect(rows[0]!.classes).toBeUndefined();
  });

  it('does not throw for no rows', () => {
    expect(() => colorRows('a.ts', [])).not.toThrow();
  });

  it('gives every row of a known language one class per character', () => {
    const rows = rowsFrom(' const a = 1;', '-let b = "x";', '+let b = "yy";', ' ');
    colorRows('a.ts', rows);
    expect(lengths(rows)).toEqual([rows[0]!.text.length, rows[1]!.text.length, rows[2]!.text.length, 0]);
  });

  it('classes a keyword differently from plain text', () => {
    const rows = rowsFrom(' const answer = 42;');
    colorRows('a.ts', rows);
    expect(rows[0]!.classes!.slice(0, 5).every((cls) => cls !== null)).toBe(true);
    expect(rows[0]!.classes![6]).toBeNull();
  });

  it('colours each row by its own text, not by a neighbour', () => {
    const rows = rowsFrom(' const a = 1;', ' let b = 2;');
    colorRows('a.ts', rows);
    expect(rows[1]!.classes!.slice(0, 3).every((cls) => cls !== null)).toBe(true);
    expect(rows[1]!.classes![3]).toBeNull();
    expect(rows[1]!.classes![4]).toBeNull();
  });

  it('keeps a multi-line comment together on the removed side', () => {
    const rows = rowsFrom(' /* start', '-middle old', '+middle new', ' end */', ' code()');
    colorRows('a.ts', rows);
    expect(new Set(rows[1]!.classes)).toEqual(new Set(['hljs-comment']));
  });

  it('keeps a multi-line comment together on the added side', () => {
    const rows = rowsFrom(' /* start', '-middle old', '+middle new', ' end */', ' code()');
    colorRows('a.ts', rows);
    expect(new Set(rows[2]!.classes)).toEqual(new Set(['hljs-comment']));
  });

  it('does not let a comment that exists only on the removed side leak into added lines', () => {
    const rows = rowsFrom('-/* gone', '-still gone', '-end */', '+const a = 1;');
    colorRows('a.ts', rows);
    expect(new Set(rows[1]!.classes)).toEqual(new Set(['hljs-comment']));
    expect(rows[3]!.classes!.slice(0, 5).every((cls) => cls !== 'hljs-comment')).toBe(true);
  });

  it('colours a hunk much longer than one highlight slice', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row('add', null, i + 1, `const value${i} = ${i};`));
    colorRows('a.ts', rows);
    expect(rows.every((r) => r.classes?.length === r.text.length)).toBe(true);
  });

  it('keeps a line too long to highlight plain and still colours the lines around it', () => {
    const rows = [row('add', null, 1, 'const a = 1;'), row('add', null, 2, 'x'.repeat(25_000)), row('add', null, 3, 'const b = 2;')];
    colorRows('a.ts', rows);
    expect(rows[0]!.classes).toHaveLength('const a = 1;'.length);
    expect(rows[1]!.classes).toBeUndefined();
    expect(rows[2]!.classes).toHaveLength('const b = 2;'.length);
  });

  it('keeps a long line that is alone in its slice plain even when it would fit highlight.js limit', () => {
    const rows = [row('add', null, 1, 'const a = 1;'), row('add', null, 2, `const s = "${'y'.repeat(13_000)}";`), row('add', null, 3, 'const b = 2;')];
    colorRows('a.ts', rows);
    expect(rows[1]!.classes).toBeUndefined();
    expect(rows[0]!.classes).toBeDefined();
    expect(rows[2]!.classes).toBeDefined();
  });

  it('does not throw when a side is too large to highlight', () => {
    const rows = [row('add', null, 1, 'x'.repeat(25_000))];
    expect(() => colorRows('a.ts', rows)).not.toThrow();
  });
});

describe('blocksOf', () => {
  it('builds one block per hunk with its start lines and index', () => {
    const blocks = blocksOf(diff(hunk(1, 1, '+a'), hunk(40, 45, ' b', '-c')), 'x.unknownext');
    expect(blocks.map((b) => [b.index, b.oldStart, b.newStart])).toEqual([[0, 1, 1], [1, 40, 45]]);
  });

  it('counts added and removed rows of each block', () => {
    const [b] = blocksOf(diff(hunk(1, 1, ' ctx', '-a', '-b', '+c', '+d', '+e')), 'x.unknownext');
    expect([b!.added, b!.removed]).toEqual([3, 2]);
  });

  it('names the hunk ranges in the header', () => {
    const [b] = blocksOf(diff(hunk(10, 12, ' a', '-b', '+c', '+d')), 'x.unknownext');
    expect(b!.header).toMatch(/^@@ .10,2 \+12,3 @@$/);
  });

  it('marks changed words and colours rows', () => {
    const [b] = blocksOf(diff(hunk(1, 1, '-const total = items.length;', '+const total = items.size;')), 'a.ts');
    expect(changedText(b!.rows[0]!)).toEqual(['length']);
    expect(b!.rows[1]!.classes).toHaveLength(b!.rows[1]!.text.length);
  });

  it('returns no blocks for a diff without hunks', () => {
    expect(blocksOf(diff(), 'a.ts')).toEqual([]);
  });
});
