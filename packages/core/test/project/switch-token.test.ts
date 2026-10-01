import { describe, expect, it } from 'vitest';
import { LAUNCH_TOKEN_ENV, takeLaunchToken } from '../../src/project/token';
import { successorArgs } from '../../src/project/switch';

describe('takeLaunchToken', () => {
  it('returns the token given in the environment', () => {
    expect(takeLaunchToken({ [LAUNCH_TOKEN_ENV]: 'given' }, () => 'generated')).toBe('given');
  });

  it('deletes the variable from the environment object', () => {
    const env: NodeJS.ProcessEnv = { [LAUNCH_TOKEN_ENV]: 'given', OTHER: 'kept' };
    takeLaunchToken(env, () => 'generated');
    expect(Object.keys(env)).not.toContain(LAUNCH_TOKEN_ENV);
    expect(env.OTHER).toBe('kept');
  });

  it('generates a token when the variable is absent', () => {
    expect(takeLaunchToken({}, () => 'generated')).toBe('generated');
  });

  it('generates a token when the variable is empty and still removes it', () => {
    const env: NodeJS.ProcessEnv = { [LAUNCH_TOKEN_ENV]: '' };
    expect(takeLaunchToken(env, () => 'generated')).toBe('generated');
    expect(Object.keys(env)).not.toContain(LAUNCH_TOKEN_ENV);
  });

  it('does not call the generator when a token is given', () => {
    let calls = 0;
    takeLaunchToken({ [LAUNCH_TOKEN_ENV]: 'given' }, () => `g${(calls += 1)}`);
    expect(calls).toBe(0);
  });

  it('never leaves the variable behind, whichever path is taken', () => {
    for (const env of [{}, { [LAUNCH_TOKEN_ENV]: '' }, { [LAUNCH_TOKEN_ENV]: 'x' }] as NodeJS.ProcessEnv[]) {
      takeLaunchToken(env, () => 'generated');
      expect(LAUNCH_TOKEN_ENV in env).toBe(false);
    }
  });

  it('a second call does not see the first token again', () => {
    const env: NodeJS.ProcessEnv = { [LAUNCH_TOKEN_ENV]: 'given' };
    takeLaunchToken(env, () => 'first');
    expect(takeLaunchToken(env, () => 'second')).toBe('second');
  });
});

describe('successorArgs --token-stdin', () => {
  it('drops --token-stdin so the successor does not wait for a token it is not sent', () => {
    expect(successorArgs(['--token-stdin'], '/new', 1)).toEqual(['--project', '/new', '--port', '1']);
  });

  it('drops --token-stdin but keeps the other arguments in order', () => {
    expect(successorArgs(['--foo', '--token-stdin', '--bar', 'v', '--project', '/old', '--port', '9'], '/new', 2)).toEqual([
      '--foo',
      '--bar',
      'v',
      '--project',
      '/new',
      '--port',
      '2',
    ]);
  });

  it('does not treat the argument after --token-stdin as its value', () => {
    expect(successorArgs(['--token-stdin', 'keep-me'], '/new', 2)).toEqual(['keep-me', '--project', '/new', '--port', '2']);
  });
});
