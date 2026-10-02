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

describe('parseClientMessage project.create', () => {
  const valid = { type: 'project.create', requestId: 'r1', parent: '/work', name: 'app' };

  it('accepts a parent and a name', () => {
    expect(parse(valid)).toEqual(valid);
  });

  it('rejects a missing or non-string parent, name or requestId', () => {
    for (const field of ['parent', 'name', 'requestId']) {
      expect(parse({ ...valid, [field]: undefined })).toBeNull();
      expect(parse({ ...valid, [field]: 1 })).toBeNull();
    }
  });

  it('rejects an empty parent or name', () => {
    expect(parse({ ...valid, parent: '' })).toBeNull();
    expect(parse({ ...valid, name: '' })).toBeNull();
  });

  it('bounds the lengths of parent (4096) and name (1024)', () => {
    expect(parse({ ...valid, parent: '/'.repeat(4096) })).not.toBeNull();
    expect(parse({ ...valid, parent: '/'.repeat(4097) })).toBeNull();
    expect(parse({ ...valid, name: 'a'.repeat(1024) })).not.toBeNull();
    expect(parse({ ...valid, name: 'a'.repeat(1025) })).toBeNull();
  });
});

describe('parseClientMessage project.clone', () => {
  const valid = { type: 'project.clone', requestId: 'r1', url: 'https://h/o/r.git', parent: '/work', name: 'r' };

  it('accepts a url, a parent and a name', () => {
    expect(parse(valid)).toEqual(valid);
  });

  it('accepts a null name meaning "derive it from the url"', () => {
    expect(parse({ ...valid, name: null })).toEqual({ ...valid, name: null });
  });

  it('rejects a missing name', () => {
    const { name: _name, ...rest } = valid;
    expect(parse(rest)).toBeNull();
  });

  it('rejects a missing, empty or non-string url, parent or requestId', () => {
    for (const field of ['url', 'parent', 'requestId']) {
      expect(parse({ ...valid, [field]: undefined })).toBeNull();
      expect(parse({ ...valid, [field]: 1 })).toBeNull();
    }
    expect(parse({ ...valid, url: '' })).toBeNull();
  });

  it('bounds the url at 2048 characters', () => {
    expect(parse({ ...valid, url: 'u'.repeat(2048) })).not.toBeNull();
    expect(parse({ ...valid, url: 'u'.repeat(2049) })).toBeNull();
  });
});

describe('parseClientMessage project.clone.cancel and project.close', () => {
  it.each(['project.clone.cancel', 'project.close'])('%s needs only a requestId', (type) => {
    expect(parse({ type, requestId: 'r1' })).toEqual({ type, requestId: 'r1' });
    expect(parse({ type })).toBeNull();
    expect(parse({ type, requestId: 1 })).toBeNull();
  });
});
