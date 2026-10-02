import { describe, expect, it } from 'vitest';
import { projectNameFromUrl, validateProjectName } from '@ide/protocol';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('validateProjectName accepts one path segment', () => {
  it.each([
    ['a plain name', 'app'],
    ['a name with an inner space', 'my app'],
    ['a name with dots inside', 'a.b.c'],
    ['a name that starts with a dot', '.config'],
    ['three dots, which is neither . nor ..', '...'],
    ['a cyrillic name', 'проект'],
    ['an emoji name', '🚀'],
    ['a name with a backslash, legal on POSIX', 'a\\b'],
  ])('accepts %s', (_label, name) => {
    expect(validateProjectName(name)).toBeNull();
  });

  it('accepts a name of exactly 255 ASCII bytes', () => {
    expect(validateProjectName('a'.repeat(255))).toBeNull();
  });

  it('accepts a multibyte name of exactly 255 bytes', () => {
    const name = 'é'.repeat(127) + 'a';
    expect(bytes(name)).toBe(255);
    expect(validateProjectName(name)).toBeNull();
  });

  it('accepts a 4-byte-character name of exactly 255 bytes', () => {
    const name = '😀'.repeat(63) + 'abc';
    expect(bytes(name)).toBe(255);
    expect(validateProjectName(name)).toBeNull();
  });
});

describe('validateProjectName rejects', () => {
  it.each([
    ['an empty name', ''],
    ['only spaces', '   '],
    ['only a tab and a newline', '\t\n'],
    ['a single dot', '.'],
    ['two dots', '..'],
    ['a single dot padded with spaces', ' . '],
    ['two dots padded with spaces', '  ..  '],
    ['a slash inside', 'a/b'],
    ['a leading slash', '/a'],
    ['a trailing slash', 'a/'],
    ['a lone slash', '/'],
    ['a NUL inside', 'a\0b'],
    ['a lone NUL', '\0'],
    ['a parent traversal', '../evil'],
  ])('%s with a non-empty message', (_label, name) => {
    const message = validateProjectName(name);
    expect(typeof message).toBe('string');
    expect(message!.length).toBeGreaterThan(0);
  });

  it('a name of 256 ASCII bytes', () => {
    expect(validateProjectName('a'.repeat(256))).toEqual(expect.any(String));
  });

  it('a name of 128 two-byte characters, 256 bytes but only 128 chars', () => {
    const name = 'é'.repeat(128);
    expect(name.length).toBe(128);
    expect(validateProjectName(name)).toEqual(expect.any(String));
  });

  it('a name of 64 four-byte characters, 256 bytes but only 128 UTF-16 units', () => {
    const name = '😀'.repeat(64);
    expect(bytes(name)).toBe(256);
    expect(validateProjectName(name)).toEqual(expect.any(String));
  });
});

describe('projectNameFromUrl', () => {
  it.each([
    ['https://github.com/org/repo.git', 'repo'],
    ['https://github.com/org/repo', 'repo'],
    ['https://github.com/org/repo/', 'repo'],
    ['https://github.com/org/repo.git/', 'repo'],
    ['git@github.com:org/repo.git', 'repo'],
    ['git@github.com:org/repo', 'repo'],
    ['ssh://git@host:2222/org/repo.git', 'repo'],
    ['git://host/org/repo.git', 'repo'],
    ['file:///tmp/x/bare.git', 'bare'],
    ['/srv/git/bare.git', 'bare'],
    ['https://gitlab.com/group/sub/deep/project.git', 'project'],
  ])('%s -> %s', (url, name) => {
    expect(projectNameFromUrl(url)).toBe(name);
  });

  it('takes the segment after the colon of an scp-like URL without an org', () => {
    expect(projectNameFromUrl('git@host:repo.git')).toBe('repo');
  });

  it('strips .git only as a suffix, not from the middle of the name', () => {
    expect(projectNameFromUrl('https://github.com/org/user.github.io')).toBe('user.github.io');
    expect(projectNameFromUrl('https://github.com/org/my.github.tools.git')).toBe('my.github.tools');
  });

  it('keeps dots and dashes of the repository name', () => {
    expect(projectNameFromUrl('https://github.com/org/my-repo.v2.git')).toBe('my-repo.v2');
  });

  it('returns an empty name for an empty URL', () => {
    expect(projectNameFromUrl('')).toBe('');
  });

  it('ignores whitespace around a pasted URL (assumption: the URL is trimmed)', () => {
    expect(projectNameFromUrl('  https://github.com/org/repo.git \n')).toBe('repo');
  });

  it.each([
    'https://github.com',
    'https://host/org/repo.git?ref=main',
    'https://host/org/repo#readme',
    'https://host/org/repo.',
    'git@host:',
    'https://host/a/b/',
  ])('never yields a name with a slash or a colon for %s', (url) => {
    const name = projectNameFromUrl(url);
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
  });
});
