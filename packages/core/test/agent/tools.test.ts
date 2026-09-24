import { describe, expect, it } from 'vitest';
import { isOlderVersion, summarizeToolInput } from '../../src/agent/tools';

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
