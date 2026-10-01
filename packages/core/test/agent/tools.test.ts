import { describe, expect, it } from 'vitest';
import { isModelChoice, isOlderVersion, summarizeToolInput } from '../../src/agent/tools';

describe('summarizeToolInput', () => {
  it('summarizes a shell call by the first line of its command and marks background runs', () => {
    expect(summarizeToolInput({ command: 'npm test\necho done', run_in_background: true }, '/p')).toBe('& npm test');
  });

  it('shows a file path relative to the project root', () => {
    expect(summarizeToolInput({ file_path: '/p/src/a.ts', content: 'x' }, '/p')).toBe('src/a.ts');
  });

  it('falls back to JSON cut to 200 characters', () => {
    const summary = summarizeToolInput({ other: 'y'.repeat(300) }, '/p');
    expect([summary.length, summary.endsWith('…')]).toEqual([200, true]);
  });
});

describe('isOlderVersion', () => {
  it('compares CLI versions number by number, not as text', () => {
    expect([
      isOlderVersion('2.1.99', '2.1.280'),
      isOlderVersion('2.1.281', '2.1.280'),
      isOlderVersion('2.10.0', '2.9.0'),
      isOlderVersion('2.1.280', '2.1.280'),
    ]).toEqual([true, false, false, false]);
  });
});

describe('isModelChoice', () => {
  it('accepts model aliases and full model ids, including a context suffix in brackets', () => {
    const accepted = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'opus[1m]', 'claude-sonnet-5[1m]', 'a', '9lives', 'us.anthropic.model-v1:0'];
    expect(accepted.filter((value) => !isModelChoice(value))).toEqual([]);
  });

  it('rejects an empty value', () => {
    expect(isModelChoice('')).toBe(false);
  });

  it('rejects a value that starts with a dash, which claude would read as a flag', () => {
    expect(['-x', '--evil', '--dangerously-skip-permissions', '-'].filter(isModelChoice)).toEqual([]);
  });

  it('rejects a value that starts with a dot or a bracket', () => {
    expect(['.hidden', '[1m]', ':x'].filter(isModelChoice)).toEqual([]);
  });

  it('rejects spaces, tabs and newlines anywhere in the value', () => {
    expect(['opus 4', ' opus', 'opus ', 'op\tus', 'opus\n', 'opus\nsonnet', 'opus\r'].filter(isModelChoice)).toEqual([]);
  });

  it('rejects shell metacharacters, quotes and path separators', () => {
    const rejected = ['opus;ls', 'opus&&ls', 'opus|cat', '$(id)', 'opus`id`', 'opus>x', 'opus<x', 'a/b', 'a\\b', "o'pus", 'o"pus', 'opus*', 'opus?', 'opus#', 'opus!', 'opus=1', 'opus,x'];
    expect(rejected.filter(isModelChoice)).toEqual([]);
  });

  it('rejects non-ASCII letters', () => {
    expect(['opuś', 'модель'].filter(isModelChoice)).toEqual([]);
  });

  it('accepts exactly 64 characters and rejects 65', () => {
    expect([isModelChoice('a'.repeat(64)), isModelChoice('a'.repeat(65))]).toEqual([true, false]);
  });
});
