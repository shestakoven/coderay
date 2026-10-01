import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('parseClientMessage fs.list', () => {
  it('accepts a string path', () => {
    expect(parse({ type: 'fs.list', requestId: 'r1', path: '/home/u' })).toEqual({ type: 'fs.list', requestId: 'r1', path: '/home/u' });
  });

  it('accepts a null path meaning the home folder', () => {
    expect(parse({ type: 'fs.list', requestId: 'r1', path: null })).toEqual({ type: 'fs.list', requestId: 'r1', path: null });
  });

  it('rejects a missing requestId', () => {
    expect(parse({ type: 'fs.list', path: '/x' })).toBeNull();
  });

  it('rejects a non-string requestId', () => {
    expect(parse({ type: 'fs.list', requestId: 1, path: '/x' })).toBeNull();
  });

  it('rejects a missing path', () => {
    expect(parse({ type: 'fs.list', requestId: 'r1' })).toBeNull();
  });

  it('rejects a path that is neither string nor null', () => {
    expect([1, true, {}, ['/x']].map((path) => parse({ type: 'fs.list', requestId: 'r1', path }))).toEqual([null, null, null, null]);
  });
});

describe('parseClientMessage project.open', () => {
  it('accepts a non-empty path', () => {
    expect(parse({ type: 'project.open', requestId: 'r1', path: '/work/app' })).toEqual({ type: 'project.open', requestId: 'r1', path: '/work/app' });
  });

  it('accepts a path of exactly 4096 characters', () => {
    const path = '/'.repeat(4096);
    expect(parse({ type: 'project.open', requestId: 'r1', path })).toEqual({ type: 'project.open', requestId: 'r1', path });
  });

  it('rejects a path of 4097 characters', () => {
    expect(parse({ type: 'project.open', requestId: 'r1', path: '/'.repeat(4097) })).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(parse({ type: 'project.open', requestId: 'r1', path: '' })).toBeNull();
  });

  it('rejects a null path, which only fs.list allows', () => {
    expect(parse({ type: 'project.open', requestId: 'r1', path: null })).toBeNull();
  });

  it('rejects a missing path or wrong path type', () => {
    expect([undefined, 5, ['/x'], {}].map((path) => parse({ type: 'project.open', requestId: 'r1', path }))).toEqual([null, null, null, null]);
  });

  it('rejects a missing requestId', () => {
    expect(parse({ type: 'project.open', path: '/x' })).toBeNull();
  });

  it('rejects a non-string requestId', () => {
    expect(parse({ type: 'project.open', requestId: {}, path: '/x' })).toBeNull();
  });
});
