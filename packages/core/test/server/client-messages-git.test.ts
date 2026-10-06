import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (message: object) => parseClientMessage(JSON.stringify(message));

describe('git client messages', () => {
  it.each([
    { type: 'git.refresh' },
    { type: 'git.init', requestId: 'r' },
    { type: 'git.branches', requestId: 'r' },
    { type: 'git.diff', requestId: 'r', path: 'a.ts', side: 'staged' },
    { type: 'git.stage', requestId: 'r', paths: ['a.ts', 'b c.ts'] },
    { type: 'git.unstage', requestId: 'r', paths: 'all' },
    { type: 'git.discard', requestId: 'r', paths: ['a.ts'] },
    { type: 'git.commit', requestId: 'r', message: 'fix' },
    { type: 'git.branch-switch', requestId: 'r', name: 'main' },
  ])('accepts a well-formed $type', (message) => {
    expect(parse(message)).toEqual(message);
  });

  it.each([
    ['an empty path list', { type: 'git.stage', requestId: 'r', paths: [] }],
    ['a path that is not a string', { type: 'git.unstage', requestId: 'r', paths: [1] }],
    ['a missing request id', { type: 'git.stage', paths: ['a'] }],
    ['an empty discard list', { type: 'git.discard', requestId: 'r', paths: [] }],
    ['"all" for discard', { type: 'git.discard', requestId: 'r', paths: 'all' }],
    ['an unknown diff side', { type: 'git.diff', requestId: 'r', path: 'a.ts', side: 'both' }],
    ['a blank commit message', { type: 'git.commit', requestId: 'r', message: '  \n' }],
    ['an empty branch name', { type: 'git.branch-switch', requestId: 'r', name: '' }],
    ['an oversized branch name', { type: 'git.branch-create', requestId: 'r', name: 'x'.repeat(256) }],
  ])('rejects %s', (_, message) => {
    expect(parse(message)).toBeNull();
  });
});
