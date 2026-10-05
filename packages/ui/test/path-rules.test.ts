import { describe, expect, it } from 'vitest';
import { addPattern, checkPattern, removePattern, replacePattern, type PathListField } from '../src/settings/path-rules';

const GITIGNORE_FIELDS: PathListField[] = ['guarded', 'harness'];
const ALL_FIELDS: PathListField[] = ['guarded', 'harness', 'outsideAllowed'];

function expectRejected(field: PathListField, raw: string): string {
  const message = checkPattern(field, raw);
  expect(message, `${field} ${JSON.stringify(raw)}`).toEqual(expect.any(String));
  expect(message!.trim()).not.toBe('');
  return message!;
}

describe('checkPattern for every list', () => {
  it.each(ALL_FIELDS)('rejects an empty %s entry', (field) => {
    expectRejected(field, '');
    expectRejected(field, '   ');
    expectRejected(field, '\t \n');
  });

  it.each(ALL_FIELDS.flatMap((field) => ['\n', '\u0000', '\t', '\r', '\u001b', '\u007f'].map((control) => [field, control] as const)))(
    'rejects a %s entry with the control character %j inside',
    (field, control) => {
      const valid = field === 'outsideAllowed' ? '/var/tmp/x' : 'src/a';
      expect(checkPattern(field, valid)).toBeNull();
      expectRejected(field, `${valid}${control}b`);
    },
  );

  it.each(ALL_FIELDS)('trims a %s entry before checking it', (field) => {
    expect(checkPattern(field, field === 'outsideAllowed' ? '  /var/tmp/x\n' : '\t.env*  \n')).toBeNull();
  });
});

describe('checkPattern for gitignore lists', () => {
  it.each(GITIGNORE_FIELDS.flatMap((field) => [
    '.env*', 'secrets/**', '/build', '!keep.txt', 'src/**/*.test.ts', '\\#hash', '**/node_modules/',
    'a..b', '...', 'a/.../b', '..hidden', 'name..', '**', '[a]', 'file[0-9].log', 'a\\\\', '.env', '.claude/',
  ].map((pattern) => [field, pattern] as const)))('accepts the %s pattern %j', (field, pattern) => {
    expect(checkPattern(field, pattern)).toBeNull();
  });

  it.each(GITIGNORE_FIELDS.flatMap((field) => ([
    ['#comment','a leading # is a comment'],
    ['  #x', 'a leading # after trimming'],
    ['!', 'a lone !'],
    [' ! ', 'a lone ! after trimming'],
    ['~', 'a lone ~'],
    ['~/notes', 'a home path'],
    ['~foo', 'a leading ~'],
    ['./src', 'a leading ./'],
    ['..', 'a lone ..'],
    ['../x', 'a leading .. segment'],
    ['a/../b', 'an inner .. segment'],
    ['a/..', 'a trailing .. segment'],
    ['a\\', 'one trailing backslash'],
    ['\\', 'a lone backslash'],
    ['a\\\\\\', 'three trailing backslashes'],
    ['***', 'three asterisks'],
    ['a/****/b', 'four asterisks'],
    ['x***y', 'three asterisks inside a name'],
    ['[a', 'an unclosed ['],
    ['a[', 'a trailing ['],
    ['[]', 'an empty [] that never closes'],
    ['[]a', 'an empty [] followed by text'],
  ] as [string, string][]).map(([pattern, why]) => [field, pattern, why] as const)))('rejects the %s pattern %j (%s)', (field, pattern) => {
    expectRejected(field, pattern);
  });
});

describe('checkPattern for negated gitignore patterns', () => {
  it.each(GITIGNORE_FIELDS.flatMap((field) => ['!keep.txt', '!src/**', '!#x', '!.env*', '!/build'].map((pattern) => [field, pattern] as const)))(
    'accepts the %s pattern %j',
    (field, pattern) => {
      expect(checkPattern(field, pattern)).toBeNull();
    },
  );

  it.each(GITIGNORE_FIELDS.flatMap((field) => ['!../x', '!a/../b', '!./x', '!~/x', '!~', '!a\\', '!a***b', '![a', '!x[a]y['].map((pattern) => [field, pattern] as const)))(
    'checks what follows the ! in the %s pattern %j',
    (field, pattern) => {
      expectRejected(field, pattern);
    },
  );

  it.each(GITIGNORE_FIELDS.flatMap((field) => ['!', ' ! ', '#x', '#!x'].map((pattern) => [field, pattern] as const)))(
    'still rejects the %s pattern %j',
    (field, pattern) => {
      expectRejected(field, pattern);
    },
  );
});

describe('checkPattern for bracket expressions', () => {
  it.each(GITIGNORE_FIELDS.flatMap((field) => [
    '[a][b]', 'x[a]y[bc]', '[]]', '[]a]', '[\\]]', '[a\\]b]', '\\[', '\\[a', 'a\\[b\\]', '[!a]', 'x[0-9]',
  ].map((pattern) => [field, pattern] as const)))('accepts the %s pattern %j', (field, pattern) => {
    expect(checkPattern(field, pattern)).toBeNull();
  });

  // gitignore reads a [ inside a class as a member, so it needs no ] of its own.
  it.each(GITIGNORE_FIELDS.flatMap((field) => ['[[]', '[a[]', 'x[[]y'].map((pattern) => [field, pattern] as const)))('accepts the %s pattern %j', (field, pattern) => {
    expect(checkPattern(field, pattern)).toBeNull();
  });

  it.each(GITIGNORE_FIELDS.flatMap((field) => [
    'x[a]y[', '[a][', '[a]b[c', '[a\\]', '[\\]', '[]', 'a\\[b][c', '[a\\]\\]',
  ].map((pattern) => [field, pattern] as const)))('rejects the %s pattern %j with an unclosed [', (field, pattern) => {
    expect(expectRejected(field, pattern)).toBe(checkPattern(field, '[a'));
  });
});

describe('checkPattern for places outside the project', () => {
  it.each(['~/.claude/plans/', '/var/tmp/x', '/tmp', '~/notes/a..b', '/a/.../b', '~/#drafts'])('accepts %j', (path) => {
    expect(checkPattern('outsideAllowed', path)).toBeNull();
  });

  it.each(['relative/path', '~foo', '.env', './x', 'tmp/', '..', '#x'])('rejects the relative path %j', (path) => {
    expectRejected('outsideAllowed', path);
  });

  it.each(['/', '~/', '  /  '])('refuses %j because it would allow every path', (path) => {
    expect(expectRejected('outsideAllowed', path)).toMatch(/every path/i);
  });

  it.each(['/a/../b', '~/..', '/..', '~/x/../y'])('rejects the parent segment in %j', (path) => {
    expectRejected('outsideAllowed', path);
  });

  it('applies its own rules, not the gitignore ones', () => {
    expect(checkPattern('outsideAllowed', '~/.claude/plans/')).toBeNull();
    expectRejected('guarded', '~/.claude/plans/');
    expect(checkPattern('guarded', 'secrets/**')).toBeNull();
    expectRejected('outsideAllowed', 'secrets/**');
  });
});

describe('addPattern', () => {
  it('appends the trimmed pattern to a new list and leaves the old one alone', () => {
    const list = ['.env*'];
    const result = addPattern('guarded', list, '  secrets/**  ');
    expect(result).toEqual({ list: ['.env*', 'secrets/**'] });
    expect(list).toEqual(['.env*']);
    expect('list' in result && result.list).not.toBe(list);
  });

  it('adds to an empty list', () => {
    expect(addPattern('outsideAllowed', [], '~/notes/')).toEqual({ list: ['~/notes/'] });
  });

  it('returns the rule error for an invalid pattern', () => {
    expect(addPattern('guarded', ['.env*'], '#x')).toEqual({ error: checkPattern('guarded', '#x') });
    expect(addPattern('outsideAllowed', [], '/')).toEqual({ error: checkPattern('outsideAllowed', '/') });
  });

  it('refuses a pattern already in the list, after trimming', () => {
    const list = ['.env*', 'secrets/**'];
    const result = addPattern('guarded', list, ' secrets/** ');
    expect(result).toEqual({ error: expect.any(String) });
    expect('error' in result && result.error.trim()).not.toBe('');
    expect(list).toEqual(['.env*', 'secrets/**']);
  });

  it('takes a pattern that only resembles an existing one', () => {
    expect(addPattern('guarded', ['.env'], '.env*')).toEqual({ list: ['.env', '.env*'] });
  });
});

describe('replacePattern', () => {
  it('changes only the item at the index, trimmed, in a new list', () => {
    const list = ['a', 'b', 'c'];
    const result = replacePattern('harness', list, 1, ' d ');
    expect(result).toEqual({ list: ['a', 'd', 'c'] });
    expect(list).toEqual(['a', 'b', 'c']);
    expect('list' in result && result.list).not.toBe(list);
  });

  it('replaces the first and the last item', () => {
    expect(replacePattern('guarded', ['a', 'b', 'c'], 0, 'x')).toEqual({ list: ['x', 'b', 'c'] });
    expect(replacePattern('guarded', ['a', 'b', 'c'], 2, 'x')).toEqual({ list: ['a', 'b', 'x'] });
  });

  it('lets an item keep its own text', () => {
    expect(replacePattern('guarded', ['a', 'b'], 0, 'a')).toEqual({ list: ['a', 'b'] });
    expect(replacePattern('guarded', ['a', 'b'], 1, '  b ')).toEqual({ list: ['a', 'b'] });
  });

  it('refuses the text of another item', () => {
    const result = replacePattern('guarded', ['a', 'b'], 0, ' b ');
    expect(result).toEqual({ error: expect.any(String) });
    expect('error' in result && result.error.trim()).not.toBe('');
  });

  it('returns the rule error for an invalid pattern', () => {
    expect(replacePattern('guarded', ['a'], 0, '../a')).toEqual({ error: checkPattern('guarded', '../a') });
    expect(replacePattern('outsideAllowed', ['/tmp'], 0, 'tmp')).toEqual({ error: checkPattern('outsideAllowed', 'tmp') });
  });
});

describe('removePattern', () => {
  it.each([
    [0, ['b', 'c']],
    [1, ['a', 'c']],
    [2, ['a', 'b']],
  ])('drops index %i into a new list', (index, expected) => {
    const list = ['a', 'b', 'c'];
    const result = removePattern(list, index);
    expect(result).toEqual(expected);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
