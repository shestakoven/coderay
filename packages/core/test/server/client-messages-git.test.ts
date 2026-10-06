import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (message: object) => parseClientMessage(JSON.stringify(message));

describe('git client messages', () => {
  it('parses a refresh without a request id', () => {
    expect(parse({ type: 'git.refresh' })).toEqual({ type: 'git.refresh' });
  });

  it.each(['git.stage', 'git.unstage'])('parses %s with a path list or "all"', (type) => {
    expect(parse({ type, requestId: 'r', paths: ['a.ts', 'b c.ts'] })).toEqual({ type, requestId: 'r', paths: ['a.ts', 'b c.ts'] });
    expect(parse({ type, requestId: 'r', paths: 'all' })).toEqual({ type, requestId: 'r', paths: 'all' });
  });

  it.each(['git.stage', 'git.unstage', 'git.discard'])('rejects %s with an empty list, a non-string path or no request id', (type) => {
    expect(parse({ type, requestId: 'r', paths: [] })).toBeNull();
    expect(parse({ type, requestId: 'r', paths: [1] })).toBeNull();
    expect(parse({ type, paths: ['a'] })).toBeNull();
  });

  it('does not accept "all" for discard', () => {
    expect(parse({ type: 'git.discard', requestId: 'r', paths: 'all' })).toBeNull();
  });

  it('parses a diff request only with a known side', () => {
    expect(parse({ type: 'git.diff', requestId: 'r', path: 'a.ts', side: 'staged' })).toEqual({ type: 'git.diff', requestId: 'r', path: 'a.ts', side: 'staged' });
    expect(parse({ type: 'git.diff', requestId: 'r', path: 'a.ts', side: 'both' })).toBeNull();
  });

  it('rejects a blank commit message and an unnamed or oversized branch', () => {
    expect(parse({ type: 'git.commit', requestId: 'r', message: 'fix' })).toEqual({ type: 'git.commit', requestId: 'r', message: 'fix' });
    expect(parse({ type: 'git.commit', requestId: 'r', message: '  \n' })).toBeNull();
    expect(parse({ type: 'git.branch-switch', requestId: 'r', name: '' })).toBeNull();
    expect(parse({ type: 'git.branch-create', requestId: 'r', name: 'x'.repeat(256) })).toBeNull();
  });
});
