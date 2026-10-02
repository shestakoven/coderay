import { describe, expect, it } from 'vitest';
import {
  addComment, anchorComments, commentsOf, dropFor, editComment, filesWith, formatRequest, loadComments, markSent, MAX_COMMENT,
  removeComment, saveComments, unsent, type NewComment, type ReviewComment,
} from '../src/history/review-comments';

let seq = 0;
const comment = (o: Partial<ReviewComment> = {}): ReviewComment => ({
  id: `c${++seq}`, path: 'src/a.ts', side: 'new', line: 1, quote: 'const a = 1;', text: 'fix this', at: 100, sentAt: null, ...o,
});
const draft = (o: Partial<NewComment> = {}): NewComment => ({ path: 'src/a.ts', side: 'new', line: 4, quote: 'const a = 1;', text: 'fix this', ...o });
const wellFormed = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
const freeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) Object.values(value).forEach(freeze);
  return Object.freeze(value);
};

describe('addComment', () => {
  it('appends the comment with the given id and time and marks it unsent', () => {
    const out = addComment([], draft(), 'id-1', 555);
    expect(out).toEqual([{ id: 'id-1', path: 'src/a.ts', side: 'new', line: 4, quote: 'const a = 1;', text: 'fix this', at: 555, sentAt: null }]);
  });

  it('keeps the existing comments and adds the new one last', () => {
    const first = comment({ id: 'first' });
    const out = addComment([first], draft({ text: 'second' }), 'second', 1);
    expect(out.map((c) => c.id)).toEqual(['first', 'second']);
    expect(out[0]).toBe(first);
  });

  it('trims the text', () => {
    expect(addComment([], draft({ text: '  \n  hello there \t\n' }), 'x', 1)[0]!.text).toBe('hello there');
  });

  it('keeps line breaks inside the text', () => {
    expect(addComment([], draft({ text: 'one\ntwo' }), 'x', 1)[0]!.text).toBe('one\ntwo');
  });

  it.each(['', ' ', '\n\t  \n'])('ignores the blank text %j and returns the same list', (text) => {
    const list = [comment()];
    expect(addComment(list, draft({ text }), 'x', 1)).toBe(list);
  });

  it('keeps text of exactly the maximum length', () => {
    const text = 'a'.repeat(MAX_COMMENT);
    expect(addComment([], draft({ text }), 'x', 1)[0]!.text).toBe(text);
  });

  it('cuts text longer than the maximum down to the maximum', () => {
    const out = addComment([], draft({ text: 'a'.repeat(MAX_COMMENT + 1) }), 'x', 1)[0]!.text;
    expect(out).toHaveLength(MAX_COMMENT);
  });

  it('trims before it counts the length', () => {
    const text = `  ${'a'.repeat(MAX_COMMENT)}  `;
    expect(addComment([], draft({ text }), 'x', 1)[0]!.text).toBe('a'.repeat(MAX_COMMENT));
  });

  it('allows a maximum of 4000 characters', () => {
    expect(MAX_COMMENT).toBe(4000);
  });

  it('does not cut the text through a character made of two UTF-16 units', () => {
    const text = `${'a'.repeat(MAX_COMMENT - 1)}😀tail`;
    const out = addComment([], draft({ text }), 'x', 1)[0]!.text;
    expect(wellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT);
    expect(out.startsWith('a'.repeat(MAX_COMMENT - 1))).toBe(true);
  });

  it('keeps a two-unit character that ends exactly at the limit', () => {
    const text = `${'a'.repeat(MAX_COMMENT - 2)}😀tail`;
    expect(addComment([], draft({ text }), 'x', 1)[0]!.text).toBe(`${'a'.repeat(MAX_COMMENT - 2)}😀`);
  });

  it('does not modify the list it is given', () => {
    const list = freeze([comment()]);
    expect(() => addComment(list, draft(), 'x', 1)).not.toThrow();
    expect(list).toHaveLength(1);
  });
});

describe('editComment', () => {
  it('replaces the text of the comment with the trimmed new text', () => {
    const list = [comment({ id: 'a', text: 'old' }), comment({ id: 'b', text: 'other' })];
    const out = editComment(list, 'a', '  new text \n');
    expect(out.map((c) => c.text)).toEqual(['new text', 'other']);
  });

  it('keeps everything else of the edited comment', () => {
    const original = comment({ id: 'a', at: 7, sentAt: 9, side: 'old', line: 3, quote: 'q' });
    expect(editComment([original], 'a', 'changed')[0]).toEqual({ ...original, text: 'changed' });
  });

  it('caps the new text at the maximum length', () => {
    expect(editComment([comment({ id: 'a' })], 'a', 'z'.repeat(MAX_COMMENT + 50))[0]!.text).toHaveLength(MAX_COMMENT);
  });

  it.each(['', '   ', '\n'])('deletes the comment when the new text is blank (%j)', (text) => {
    const list = [comment({ id: 'a' }), comment({ id: 'b' })];
    expect(editComment(list, 'a', text).map((c) => c.id)).toEqual(['b']);
  });

  it('leaves the comments as they are when the id is unknown', () => {
    const list = [comment({ id: 'a', text: 'keep' })];
    expect(editComment(list, 'nope', 'changed')).toEqual(list);
  });

  it('does not cut the new text through a character made of two UTF-16 units', () => {
    const text = `${'a'.repeat(MAX_COMMENT - 1)}😀tail`;
    const out = editComment([comment({ id: 'a' })], 'a', text)[0]!.text;
    expect(wellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT);
  });

  it('does not modify the list it is given', () => {
    const list = freeze([comment({ id: 'a', text: 'old' })]);
    expect(() => editComment(list, 'a', 'new')).not.toThrow();
    expect(list[0]!.text).toBe('old');
  });
});

describe('removeComment', () => {
  it('removes only the comment with that id', () => {
    const list = [comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })];
    expect(removeComment(list, 'b').map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('keeps all comments for an unknown id', () => {
    const list = [comment({ id: 'a' })];
    expect(removeComment(list, 'zzz')).toEqual(list);
  });
});

describe('unsent and markSent', () => {
  it('lists only the comments that were not sent', () => {
    const list = [comment({ id: 'a', sentAt: null }), comment({ id: 'b', sentAt: 5 }), comment({ id: 'c', sentAt: null })];
    expect(unsent(list).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('counts a comment sent at time zero as sent', () => {
    expect(unsent([comment({ sentAt: 0 })])).toEqual([]);
  });

  it('stamps the listed comments with the send time', () => {
    const list = [comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })];
    const out = markSent(list, ['a', 'c'], 42);
    expect(out.map((c) => [c.id, c.sentAt])).toEqual([['a', 42], ['b', null], ['c', 42]]);
  });

  it('removes the sent comments from the unsent ones', () => {
    const list = [comment({ id: 'a' }), comment({ id: 'b' })];
    expect(unsent(markSent(list, ['a'], 1)).map((c) => c.id)).toEqual(['b']);
  });

  it('ignores ids that are not in the list', () => {
    const list = [comment({ id: 'a' })];
    expect(markSent(list, ['zzz'], 1)).toEqual(list);
  });

  it('does not modify the list it is given', () => {
    const list = freeze([comment({ id: 'a' })]);
    expect(() => markSent(list, ['a'], 1)).not.toThrow();
    expect(list[0]!.sentAt).toBeNull();
  });
});

describe('commentsOf, dropFor and filesWith', () => {
  const list = [comment({ id: 'a', path: 'x.ts' }), comment({ id: 'b', path: 'y.ts' }), comment({ id: 'c', path: 'x.ts' }), comment({ id: 'd', path: 'z.ts' })];

  it('lists the comments of one file in order', () => {
    expect(commentsOf(list, 'x.ts').map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('has no comments for a file without any', () => {
    expect(commentsOf(list, 'nope.ts')).toEqual([]);
  });

  it('does not match a path that only shares a prefix', () => {
    expect(commentsOf(list, 'x.t')).toEqual([]);
  });

  it('drops the comments of the given files', () => {
    expect(dropFor(list, ['x.ts', 'z.ts']).map((c) => c.id)).toEqual(['b']);
  });

  it('drops nothing for no paths or unknown paths', () => {
    expect(dropFor(list, [])).toEqual(list);
    expect(dropFor(list, ['nope.ts'])).toEqual(list);
  });

  it('lists each commented file once in the order first seen', () => {
    expect(filesWith(list)).toEqual(['x.ts', 'y.ts', 'z.ts']);
  });

  it('lists no files when there are no comments', () => {
    expect(filesWith([])).toEqual([]);
  });
});

describe('anchorComments', () => {
  it('has nothing for no comments', () => {
    const out = anchorComments([], new Map([['new:1', 'x']]));
    expect(out.inline.size).toBe(0);
    expect(out.outdated).toEqual([]);
  });

  it('puts a comment inline under its side and line when the line text is unchanged', () => {
    const c = comment({ side: 'new', line: 7, quote: 'let x = 1;' });
    const out = anchorComments([c], new Map([['new:7', 'let x = 1;']]));
    expect(out.inline.get('new:7')).toEqual([c]);
    expect(out.outdated).toEqual([]);
  });

  it('anchors a comment on a removed line under the old side', () => {
    const c = comment({ side: 'old', line: 3, quote: 'gone();' });
    const out = anchorComments([c], new Map([['old:3', 'gone();']]));
    expect([...out.inline.keys()]).toEqual(['old:3']);
  });

  it('keeps comments on the same line together in their order', () => {
    const a = comment({ id: 'a', line: 2, quote: 'q' });
    const b = comment({ id: 'b', line: 2, quote: 'q' });
    const other = comment({ id: 'o', line: 9, quote: 'r' });
    const out = anchorComments([a, other, b], new Map([['new:2', 'q'], ['new:9', 'r']]));
    expect(out.inline.get('new:2')!.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.inline.get('new:9')!.map((c) => c.id)).toEqual(['o']);
  });

  it('marks a comment outdated when the line text changed', () => {
    const c = comment({ line: 2, quote: 'before' });
    const out = anchorComments([c], new Map([['new:2', 'after']]));
    expect(out.outdated).toEqual([c]);
    expect(out.inline.size).toBe(0);
  });

  it('marks a comment outdated when the line no longer exists', () => {
    const c = comment({ line: 50, quote: 'x' });
    expect(anchorComments([c], new Map([['new:2', 'x']])).outdated).toEqual([c]);
  });

  it('compares the line text exactly, whitespace and case included', () => {
    const texts = new Map([['new:1', 'Foo bar']]);
    for (const quote of ['foo bar', 'Foo bar ', ' Foo bar', 'Foo  bar']) {
      const c = comment({ line: 1, quote });
      expect(anchorComments([c], texts).outdated, quote).toEqual([c]);
    }
  });

  it('does not match a line of the other side with the same number', () => {
    const c = comment({ side: 'old', line: 4, quote: 'same text' });
    expect(anchorComments([c], new Map([['new:4', 'same text']])).outdated).toEqual([c]);
  });

  it('anchors a blank quote on a blank line', () => {
    const c = comment({ line: 3, quote: '' });
    expect(anchorComments([c], new Map([['new:3', '']])).inline.get('new:3')).toEqual([c]);
  });

  it('splits a mixed list into inline and outdated, keeping the order of the outdated ones', () => {
    const fresh = comment({ id: 'fresh', line: 1, quote: 'a' });
    const stale1 = comment({ id: 's1', line: 2, quote: 'old' });
    const stale2 = comment({ id: 's2', line: 3, quote: 'old' });
    const out = anchorComments([stale1, fresh, stale2], new Map([['new:1', 'a'], ['new:2', 'new'], ['new:3', 'new']]));
    expect(out.outdated.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(out.inline.get('new:1')!.map((c) => c.id)).toEqual(['fresh']);
  });
});

describe('formatRequest', () => {
  const lines = (text: string): string[] => text.split('\n');

  describe('header', () => {
    it('says 1 comment on 1 file in the singular', () => {
      const header = lines(formatRequest([comment()]))[0]!;
      expect(header).toContain('1 comment on 1 file');
      expect(header).not.toContain('1 comments');
      expect(header).not.toContain('1 files');
    });

    it('says 2 comments on 1 file when both are on the same file', () => {
      const header = lines(formatRequest([comment({ line: 1 }), comment({ line: 2 })]))[0]!;
      expect(header).toContain('2 comments on 1 file');
      expect(header).not.toContain('1 files');
    });

    it('says 3 comments on 2 files in the plural', () => {
      const header = lines(formatRequest([comment({ path: 'a.ts' }), comment({ path: 'b.ts' }), comment({ path: 'a.ts', line: 5 })]))[0]!;
      expect(header).toContain('3 comments on 2 files');
    });

    it('counts a file once however many comments it has', () => {
      const many = Array.from({ length: 5 }, (_, i) => comment({ path: 'only.ts', line: i + 1 }));
      expect(lines(formatRequest(many))[0]).toContain('5 comments on 1 file');
    });
  });

  describe('files and comments', () => {
    it('lists files in the order they were first commented on', () => {
      const out = formatRequest([comment({ path: 'src/b.ts' }), comment({ path: 'src/a.ts' }), comment({ path: 'src/b.ts', line: 9 })]);
      expect(out.indexOf('src/b.ts:1')).toBeGreaterThan(-1);
      expect(out.indexOf('src/b.ts:1')).toBeLessThan(out.indexOf('src/a.ts:1'));
      expect(out.indexOf('src/b.ts:9')).toBeLessThan(out.indexOf('src/a.ts:1'));
    });

    it('groups all comments of a file together even when the input interleaves files', () => {
      const out = formatRequest([comment({ path: 'a.ts', line: 1 }), comment({ path: 'b.ts', line: 1 }), comment({ path: 'a.ts', line: 2 })]);
      expect(out.indexOf('a.ts:2')).toBeLessThan(out.indexOf('b.ts:1'));
    });

    it('sorts the comments of a file by line number, not as text', () => {
      const out = formatRequest([
        comment({ path: 'a.ts', line: 10, text: 'ten' }),
        comment({ path: 'a.ts', line: 9, text: 'nine' }),
        comment({ path: 'a.ts', line: 100, text: 'hundred' }),
        comment({ path: 'a.ts', line: 2, text: 'two' }),
      ]);
      const order = ['two', 'nine', 'ten', 'hundred'].map((word) => out.indexOf(`\n  ${word}`));
      expect(order.every((index) => index > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('keeps the input order for comments on the same line', () => {
      const out = formatRequest([comment({ line: 4, text: 'first remark' }), comment({ line: 4, text: 'second remark' })]);
      expect(out.indexOf('first remark')).toBeLessThan(out.indexOf('second remark'));
    });

    it('shows each comment as path:line', () => {
      const out = formatRequest([comment({ path: 'src/deep/file.ts', line: 42 })]);
      expect(out).toContain('src/deep/file.ts:42');
    });

    it('does not say a new-side line was removed', () => {
      expect(formatRequest([comment({ side: 'new' })])).not.toContain('a line you removed');
    });

    it('says a comment on the old side is about a line you removed', () => {
      const out = formatRequest([comment({ side: 'old', line: 8, path: 'a.ts' })]);
      expect(out).toMatch(/a\.ts:8\b[^\n]*a line you removed/);
    });

    it('says it only for the old-side comments of a mixed file', () => {
      const out = lines(formatRequest([comment({ side: 'new', line: 1, text: 'N' }), comment({ side: 'old', line: 2, text: 'O' })]));
      expect(out.find((line) => line.includes('src/a.ts:1'))).not.toContain('a line you removed');
      expect(out.find((line) => line.includes('src/a.ts:2'))).toContain('a line you removed');
    });

    it('does not change the order of the comments it is given', () => {
      const input = freeze([comment({ id: 'z', line: 9 }), comment({ id: 'y', line: 1 })]);
      expect(() => formatRequest(input)).not.toThrow();
      expect(input.map((c) => c.id)).toEqual(['z', 'y']);
    });
  });

  describe('quoted line', () => {
    it('shows the line text in backticks', () => {
      expect(formatRequest([comment({ quote: 'const answer = 42;' })])).toContain('`const answer = 42;`');
    });

    it('shows a quote of exactly 80 characters in full', () => {
      const quote = 'q'.repeat(80);
      const out = formatRequest([comment({ quote })]);
      expect(out).toContain(`\`${quote}\``);
      expect(out).not.toContain('…');
    });

    it('cuts a quote of 81 characters to 80 followed by an ellipsis', () => {
      const out = formatRequest([comment({ quote: 'q'.repeat(81) })]);
      expect(out).toContain(`\`${'q'.repeat(80)}…\``);
      expect(out).not.toContain('q'.repeat(81));
    });

    it('cuts a much longer quote the same way', () => {
      const out = formatRequest([comment({ quote: `${'a'.repeat(80)}${'b'.repeat(500)}` })]);
      expect(out).toContain(`\`${'a'.repeat(80)}…\``);
      expect(out).not.toContain('b');
    });

    it.each(['', '   ', '\t'])('leaves out the backticks for the blank quote %j', (quote) => {
      expect(formatRequest([comment({ quote })])).not.toContain('`');
    });

    it('does not show the indentation of the quoted line', () => {
      expect(formatRequest([comment({ quote: '      indented();' })])).toContain('`indented();`');
    });

    it('does not cut a quote through a character made of two UTF-16 units', () => {
      const out = formatRequest([comment({ quote: `${'a'.repeat(79)}😀${'b'.repeat(10)}` })]);
      expect(wellFormed(out)).toBe(true);
    });

    it('keeps non-latin quotes intact', () => {
      expect(formatRequest([comment({ quote: 'const имя = "значение";' })])).toContain('`const имя = "значение";`');
    });
  });

  describe('comment text', () => {
    it('shows the comment text under its location', () => {
      const out = lines(formatRequest([comment({ path: 'a.ts', line: 3, quote: 'x', text: 'rename this' })]));
      const at = out.findIndex((line) => line.includes('a.ts:3'));
      expect(out[at + 1]!.trim()).toBe('rename this');
    });

    it('indents every continuation line of a multi-line comment', () => {
      const out = lines(formatRequest([comment({ text: 'first line\nsecond line\nthird line' })]));
      const at = out.findIndex((line) => line.trim() === 'first line');
      expect(out.slice(at, at + 3)).toEqual(['  first line', '  second line', '  third line']);
    });

    it('keeps blank lines inside a multi-line comment', () => {
      const text = formatRequest([comment({ text: 'para one\n\npara two' })]);
      expect(text).toMatch(/ {2}para one\n {2}\n {2}para two/);
    });

    it('does not leak a continuation line into the next comment', () => {
      const out = formatRequest([comment({ line: 1, text: 'a\nb' }), comment({ line: 2, text: 'c' })]);
      expect(out.indexOf('b')).toBeLessThan(out.indexOf('src/a.ts:2'));
    });

    it('keeps unicode text intact', () => {
      const out = formatRequest([comment({ text: 'Переименуй это 🙂 — «пожалуйста»' })]);
      expect(out).toContain('Переименуй это 🙂 — «пожалуйста»');
      expect(wellFormed(out)).toBe(true);
    });
  });

  describe('message', () => {
    it('is a single message that ends by asking to leave everything else as it is', () => {
      const out = formatRequest([comment(), comment({ path: 'b.ts' })]);
      expect(lines(out).at(-1)).toMatch(/leave everything else as it is/i);
    });

    it('separates the header, each file and the closing sentence with a blank line', () => {
      const out = formatRequest([comment({ path: 'a.ts', text: 'one' }), comment({ path: 'b.ts', text: 'two' })]);
      const blocks = out.split('\n\n');
      expect(blocks).toHaveLength(4);
      expect(blocks[1]).toContain('a.ts:1');
      expect(blocks[2]).toContain('b.ts:1');
    });

    it('lists the comments of one file with no blank line between them', () => {
      const out = formatRequest([comment({ line: 1 }), comment({ line: 2 })]);
      expect(out.split('\n\n')).toHaveLength(3);
    });
  });
});

describe('loadComments and saveComments', () => {
  const memory = (): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
  };
  const valid = (o: Partial<ReviewComment> = {}): ReviewComment => comment({ id: `v${++seq}`, ...o });

  it('returns what was saved', () => {
    const store = memory();
    const list = [valid({ sentAt: null }), valid({ side: 'old', sentAt: 123, text: 'ünï\ncode' })];
    saveComments(store, '/proj', list);
    expect(loadComments(store, '/proj')).toEqual(list);
  });

  it('returns an empty list when nothing was saved', () => {
    expect(loadComments(memory(), '/proj')).toEqual([]);
  });

  it('saves an empty list and loads it back as empty', () => {
    const store = memory();
    saveComments(store, '/proj', [valid()]);
    saveComments(store, '/proj', []);
    expect(loadComments(store, '/proj')).toEqual([]);
  });

  it('replaces the earlier save of the same project', () => {
    const store = memory();
    saveComments(store, '/proj', [valid({ id: 'old' })]);
    saveComments(store, '/proj', [valid({ id: 'new' })]);
    expect(loadComments(store, '/proj').map((c) => c.id)).toEqual(['new']);
  });

  it('keeps projects apart', () => {
    const store = memory();
    saveComments(store, '/proj/a', [valid({ id: 'a' })]);
    saveComments(store, '/proj/b', [valid({ id: 'b' })]);
    expect(loadComments(store, '/proj/a').map((c) => c.id)).toEqual(['a']);
    expect(loadComments(store, '/proj/b').map((c) => c.id)).toEqual(['b']);
    expect(loadComments(store, '/proj/c')).toEqual([]);
  });

  it('does not let a project whose path is a prefix of another read its comments', () => {
    const store = memory();
    saveComments(store, '/proj/app', [valid()]);
    expect(loadComments(store, '/proj')).toEqual([]);
    expect(loadComments(store, '/proj/app/sub')).toEqual([]);
  });

  it('stores the comments under a key that names the project', () => {
    const store = memory();
    saveComments(store, '/work/my-project', [valid()]);
    expect([...store.data.keys()].every((key) => key.includes('/work/my-project'))).toBe(true);
    expect(store.data.size).toBe(1);
  });

  it('stores the comments as a JSON array', () => {
    const store = memory();
    const list = [valid()];
    saveComments(store, '/proj', list);
    expect(JSON.parse([...store.data.values()][0]!)).toEqual(list);
  });

  describe('bad stored data', () => {
    const loadRaw = (raw: string): ReviewComment[] => {
      const store = memory();
      saveComments(store, '/proj', []);
      store.data.set([...store.data.keys()][0]!, raw);
      return loadComments(store, '/proj');
    };

    it.each(['{not json', '', '[', 'undefined', '[1, 2'])('gives an empty list for unparsable data %j', (raw) => {
      expect(loadRaw(raw)).toEqual([]);
    });

    it.each(['{}', '"text"', '5', 'null', 'true', '{"id":"x"}'])('gives an empty list when the data is not an array: %s', (raw) => {
      expect(loadRaw(raw)).toEqual([]);
    });

    it.each([
      ['a missing id', { id: undefined }],
      ['a numeric id', { id: 5 }],
      ['a missing path', { path: undefined }],
      ['an unknown side', { side: 'both' }],
      ['a missing side', { side: undefined }],
      ['a string line', { line: '4' }],
      ['a null line', { line: null }],
      ['a missing quote', { quote: undefined }],
      ['a numeric text', { text: 7 }],
      ['a string time', { at: '1' }],
      ['a missing sentAt', { sentAt: undefined }],
      ['a string sentAt', { sentAt: 'now' }],
    ])('drops an entry with %s', (_name, patch) => {
      const raw = JSON.stringify([{ ...valid(), ...patch }]);
      expect(loadRaw(raw)).toEqual([]);
    });

    it.each(['null', '5', '"x"', '[]', 'true'])('drops the non-object entry %s', (entry) => {
      expect(loadRaw(`[${entry}]`)).toEqual([]);
    });

    it('keeps the valid entries when others in the list are broken', () => {
      const good1 = valid({ id: 'g1' });
      const good2 = valid({ id: 'g2', sentAt: 9 });
      const raw = JSON.stringify([good1, { id: 1 }, null, good2, 'x']);
      expect(loadRaw(raw)).toEqual([good1, good2]);
    });
  });

  describe('unavailable storage', () => {
    it('loads an empty list without storage', () => {
      expect(loadComments(undefined, '/proj')).toEqual([]);
    });

    it('saves without storage without throwing', () => {
      expect(() => saveComments(undefined, '/proj', [valid()])).not.toThrow();
    });

    it('loads an empty list when reading throws', () => {
      const broken = { getItem: (): string => { throw new Error('denied'); } };
      expect(loadComments(broken, '/proj')).toEqual([]);
    });

    it('does not throw when writing fails', () => {
      const full = { setItem: (): void => { throw new Error('quota'); } };
      expect(() => saveComments(full, '/proj', [valid()])).not.toThrow();
    });
  });
});
