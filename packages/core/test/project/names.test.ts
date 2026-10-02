import { describe, expect, it } from 'vitest';
import { projectNameFromUrl, validateProjectName } from '@ide/protocol';

describe('validateProjectName', () => {
  it.each(['app', 'my-app', 'my app', 'app.v2', '.hidden', '-dash', 'проект', '日本語', 'a'.repeat(255), 'я'.repeat(127)])('accepts %j', (name) => {
    expect(validateProjectName(name)).toBeNull();
  });

  it.each(['', '   ', '.', '..', ' .. ', 'a/b', '/abs', 'a\0b', 'a'.repeat(256), 'я'.repeat(128)])('rejects %j with a message', (name) => {
    expect(validateProjectName(name)).toEqual(expect.any(String));
  });

  it('trims before judging', () => {
    expect(validateProjectName('  app  ')).toBeNull();
  });

  it('gives different messages for different causes', () => {
    const messages = new Set(['', '..', 'a/b', 'a'.repeat(256)].map((name) => validateProjectName(name)));
    expect(messages.size).toBe(4);
  });
});

describe('projectNameFromUrl', () => {
  it.each([
    ['https://github.com/org/repo.git', 'repo'],
    ['https://github.com/org/repo', 'repo'],
    ['https://github.com/org/repo/', 'repo'],
    ['https://github.com/org/repo.git/', 'repo'],
    ['git@github.com:org/repo.git', 'repo'],
    ['git@host:repo.git', 'repo'],
    ['ssh://git@host:22/org/repo.git', 'repo'],
    ['/srv/git/lib.git', 'lib'],
    ['  https://h/o/r.git  ', 'r'],
    ['https://h/o/REPO.GIT', 'REPO'],
    ['repo', 'repo'],
    ['', ''],
  ])('names %j as %j', (url, name) => {
    expect(projectNameFromUrl(url)).toBe(name);
  });
});
