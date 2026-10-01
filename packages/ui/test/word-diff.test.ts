import { describe, expect, it } from 'vitest';
import { wordDiff, type Segment } from '../src/history/word-diff';

const joined = (segments: Segment[]): string => segments.map((s) => s.text).join('');
const changed = (segments: Segment[]): string[] => segments.filter((s) => s.changed).map((s) => s.text);
const unchanged = (segments: Segment[]): string => joined(segments.filter((s) => !s.changed));
const diff = (before: string, after: string) => {
  const result = wordDiff(before, after);
  if (!result) throw new Error('expected a diff, got null');
  return result;
};

describe('wordDiff', () => {
  it('marks nothing as changed for identical lines', () => {
    const { before, after } = diff('foo(a, b)', 'foo(a, b)');
    expect(changed(before)).toEqual([]);
    expect(changed(after)).toEqual([]);
  });

  it('merges neighbouring unchanged tokens into one segment', () => {
    const { before, after } = diff('foo(a, b)', 'foo(a, b)');
    expect(before).toEqual([{ text: 'foo(a, b)', changed: false }]);
    expect(after).toEqual([{ text: 'foo(a, b)', changed: false }]);
  });

  it('holds exactly the old and the new identifier when one identifier is replaced', () => {
    const { before, after } = diff('const foo = 1;', 'const bar = 1;');
    expect(changed(before)).toEqual(['foo']);
    expect(changed(after)).toEqual(['bar']);
  });

  it('keeps the full original line on each side when one identifier is replaced', () => {
    const { before, after } = diff('const foo = 1;', 'const bar = 1;');
    expect(joined(before)).toBe('const foo = 1;');
    expect(joined(after)).toBe('const bar = 1;');
  });

  it('marks only the occurrence that changed when the identifier appears twice', () => {
    const { before, after } = diff('foo(foo, x)', 'foo(bar, x)');
    expect(before[0]).toEqual({ text: 'foo(', changed: false });
    expect(changed(before)).toEqual(['foo']);
    expect(changed(after)).toEqual(['bar']);
  });

  it('marks only the inserted text on the after side for a pure insertion', () => {
    const { before, after } = diff('foo(a)', 'foo(a, b)');
    expect(changed(before)).toEqual([]);
    expect(changed(after)).toEqual([', b']);
    expect(joined(after)).toBe('foo(a, b)');
  });

  it('marks only the removed text on the before side for a pure deletion', () => {
    const { before, after } = diff('foo(a, b)', 'foo(a)');
    expect(changed(before)).toEqual([', b']);
    expect(changed(after)).toEqual([]);
    expect(joined(before)).toBe('foo(a, b)');
  });

  it('marks a removed middle word on the before side only', () => {
    const { before, after } = diff('a b c d', 'a c d');
    expect(changed(before).join('').trim()).toBe('b');
    expect(changed(after)).toEqual([]);
  });

  it('marks only the whitespace when only the whitespace changed', () => {
    const { before, after } = diff('a  b', 'a b');
    expect(changed(before)).toEqual(['  ']);
    expect(changed(after)).toEqual([' ']);
    expect(joined(before)).toBe('a  b');
    expect(joined(after)).toBe('a b');
  });

  it('merges adjacent changed tokens into one segment', () => {
    const { before, after } = diff('x = foo bar baz;', 'x = qux;');
    expect(changed(before)).toEqual(['foo bar baz']);
    expect(changed(after)).toEqual(['qux']);
  });

  it('merges a changed word and the space next to it into one segment', () => {
    const { before } = diff('a foo bar b', 'a x b');
    expect(changed(before)).toEqual(['foo bar']);
  });

  it('puts the whole line on the after side as changed when the before line is empty', () => {
    expect(diff('', 'abc')).toEqual({ before: [], after: [{ text: 'abc', changed: true }] });
  });

  it('puts the whole line on the before side as changed when the after line is empty', () => {
    expect(diff('abc', '')).toEqual({ before: [{ text: 'abc', changed: true }], after: [] });
  });

  it('returns no segments when both lines are empty', () => {
    expect(diff('', '')).toEqual({ before: [], after: [] });
  });

  it('returns null when the before line has more than 300 tokens', () => {
    expect(wordDiff('a '.repeat(150) + 'a', 'a')).toBeNull();
  });

  it('returns null when the after line has more than 300 tokens', () => {
    expect(wordDiff('a', 'a '.repeat(150) + 'a')).toBeNull();
  });

  it('still diffs a line of exactly 300 tokens', () => {
    const line = 'a '.repeat(150);
    const result = wordDiff(line, line.replace('a ', 'b '));
    expect(result).not.toBeNull();
    expect(changed(result!.before)).toEqual(['a']);
    expect(changed(result!.after)).toEqual(['b']);
  });

  describe.each([
    ['replacement', 'const foo = bar(1, 2);', 'const baz = bar(1, 3);'],
    ['insertion at the start', 'return x;', 'async return x;'],
    ['insertion at the end', 'import a from "a"', 'import a from "a";'],
    ['unrelated lines', 'alpha beta', 'gamma delta epsilon'],
    ['punctuation only', 'a.b.c', 'a->b->c'],
    ['repeated tokens', 'a a a a', 'a a b a'],
  ])('invariants for %s', (_name, from, to) => {
    it('reproduces each original line from its segments', () => {
      const { before, after } = diff(from, to);
      expect(joined(before)).toBe(from);
      expect(joined(after)).toBe(to);
    });

    it('keeps the same unchanged text on both sides', () => {
      const { before, after } = diff(from, to);
      expect(unchanged(before)).toBe(unchanged(after));
    });

    it('never leaves two neighbouring segments with the same changed flag', () => {
      const { before, after } = diff(from, to);
      for (const side of [before, after]) {
        side.slice(1).forEach((segment, i) => expect(segment.changed).not.toBe(side[i]!.changed));
      }
    });
  });
});
