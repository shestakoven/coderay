import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOlderVersion, MIN_CLAUDE_VERSION, summarizeToolInput } from '../../src/agent/tools';

describe('summarizeToolInput', () => {
  it('summarizes a shell call by the first line of its command and marks background runs', () => {
    expect(summarizeToolInput({ command: 'npm test\necho done', run_in_background: true }, '/p')).toBe('& npm test');
  });

  it('shows a file path relative to the project root', () => {
    expect(summarizeToolInput({ file_path: '/p/src/a.ts', content: 'x' }, '/p')).toBe('src/a.ts');
  });

  it('summarizes a Skill call by the skill name, not its args', () => {
    expect(summarizeToolInput({ skill: 'repo-probe', args: 'x' }, '/p')).toBe('repo-probe');
  });

  it('keeps the plugin prefix of a Skill name', () => {
    expect(summarizeToolInput({ skill: 'superpowers:brainstorming' }, '/p')).toBe('superpowers:brainstorming');
  });

  it('prefers the skill name over every other summary field', () => {
    const input = { command: 'ls', file_path: '/p/a.ts', notebook_path: '/p/n.ipynb', description: 'd', pattern: 'p', url: 'u', query: 'q', prompt: 'pr' };
    expect([summarizeToolInput({ ...input, skill: 'repo-probe' }, '/p'), summarizeToolInput(input, '/p')]).toEqual(['repo-probe', 'ls']);
  });

  it('ignores a skill field that is not a string', () => {
    expect(summarizeToolInput({ skill: 3, command: 'ls' }, '/p')).toBe('ls');
  });

  it.each([
    ['notebook_path', { notebook_path: '/p/n.ipynb', description: 'd', pattern: 'x' }, 'n.ipynb'],
    ['description', { description: 'd', pattern: 'x', url: 'u' }, 'd'],
    ['pattern', { pattern: 'x', url: 'u', query: 'q' }, 'x'],
    ['url', { url: 'u', query: 'q', prompt: 'pr' }, 'u'],
    ['query', { query: 'q', prompt: 'pr' }, 'q'],
    ['prompt', { prompt: 'pr' }, 'pr'],
  ])('keeps summarizing by %s when there is no skill', (_field, input, expected) => {
    expect(summarizeToolInput(input, '/p')).toBe(expected);
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

describe('MIN_CLAUDE_VERSION', () => {
  it('is the claude version the installed agent SDK was released with', () => {
    const sdk = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
    const { claudeCodeVersion } = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as { claudeCodeVersion: string };
    expect(MIN_CLAUDE_VERSION).toBe(claudeCodeVersion);
  });
});
