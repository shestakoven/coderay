import { describe, expect, it } from 'vitest';
import { covers, escapeGlob } from '../../src/gate/scope';

const file = (rel: string) => ({ rel, dir: false, mkdir: false });

describe('escapeGlob', () => {
  it.each(['a!(b)', 'a+(b)', 'a@(b)', 'a(b)', 'a{b}', 'a?b', 'a*b', '!lead.ts'])('a plan path %s covers itself and not its glob reading', (path) => {
    const scope = { paths: [], globs: [escapeGlob(path)] };
    expect(covers(scope, file(path))).toBe(true);
    for (const other of ['ab', 'b', 'lead.ts', 'axb', 'ac']) expect(covers(scope, file(other))).toBe(false);
  });

  it('a directory named app/[id] is not a character class', () => {
    const scope = { paths: [], globs: [`${escapeGlob('app/[id]')}/**`] };
    expect(covers(scope, file('app/[id]/page.ts'))).toBe(true);
    expect(covers(scope, file('app/i/page.ts'))).toBe(false);
    expect(covers(scope, file('app/d/page.ts'))).toBe(false);
  });

  it('a directory with a brace, a paren or a bang keeps covering its files and dot files', () => {
    for (const dir of ['src/{a,b}', 'src/a(b)', 'src/a!(b)', 'src/!x']) {
      const scope = { paths: [], globs: [`${escapeGlob(dir)}/**`] };
      expect([`${dir}/x.ts`, `${dir}/.env`].map((rel) => covers(scope, file(rel)))).toEqual([true, true]);
      expect(covers(scope, { rel: dir, dir: true, mkdir: false })).toBe(true);
    }
  });
});

describe('covers a dir/** glob', () => {
  const scope = { paths: [], globs: ['src/lib/**'] };

  it('covers dotfiles and dot directories under it', () => {
    for (const rel of ['src/lib/.env', 'src/lib/.d/x', 'src/lib/a/b.ts', 'src/lib/a/.hidden/y']) expect(covers(scope, file(rel))).toBe(true);
  });

  it('does not cover a sibling that shares the prefix, or the directory itself as a file path elsewhere', () => {
    for (const rel of ['src/libx/a', 'src/libx', 'src/.env', 'other/src/lib/a']) expect(covers(scope, file(rel))).toBe(false);
  });

  it('covers dotfiles under a root ** glob', () => {
    expect(covers({ paths: [], globs: ['**'] }, file('.env'))).toBe(true);
  });

  it('keeps matching a pattern in the directory part the ordinary way', () => {
    const wild = { paths: [], globs: ['src/*/gen/**'] };
    expect([covers(wild, file('src/a/gen/x.ts')), covers(wild, file('src/a/b/gen/x.ts'))]).toEqual([true, false]);
  });

  it('covers a dot directory when making it', () => {
    expect(covers(scope, { rel: 'src/lib/.d', dir: false, mkdir: true })).toBe(true);
  });
});
