import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (message: unknown) => parseClientMessage(JSON.stringify(message));
const s = (length: number): string => 'x'.repeat(length);

const create = (over: Record<string, unknown> = {}) => ({ type: 'project.create', requestId: 'r1', parent: '/p', name: 'n', ...over });
const clone = (over: Record<string, unknown> = {}) => ({
  type: 'project.clone', requestId: 'r1', url: 'https://host/org/repo.git', parent: '/p', name: null, ...over,
});

describe('parseClientMessage project.create', () => {
  it('accepts a well-formed request unchanged', () => {
    expect(parse(create())).toEqual(create());
  });

  it('accepts a parent of exactly 4096 characters', () => {
    expect(parse(create({ parent: s(4096) }))).toEqual(create({ parent: s(4096) }));
  });

  it('rejects a parent of 4097 characters', () => {
    expect(parse(create({ parent: s(4097) }))).toBeNull();
  });

  it('accepts a name of exactly 1024 characters', () => {
    expect(parse(create({ name: s(1024) }))).toEqual(create({ name: s(1024) }));
  });

  it('rejects a name of 1025 characters', () => {
    expect(parse(create({ name: s(1025) }))).toBeNull();
  });

  it.each([
    ['an empty parent', { parent: '' }],
    ['a numeric parent', { parent: 1 }],
    ['a null parent', { parent: null }],
    ['an empty name', { name: '' }],
    ['a numeric name', { name: 7 }],
    ['a null name', { name: null }],
    ['a numeric requestId', { requestId: 5 }],
  ])('rejects %s', (_label, over) => {
    expect(parse(create(over))).toBeNull();
  });

  it.each(['requestId', 'parent', 'name'])('rejects a request without %s', (field) => {
    const message: Record<string, unknown> = create();
    delete message[field];
    expect(parse(message)).toBeNull();
  });
});

describe('parseClientMessage project.clone', () => {
  it('accepts a request with a null name', () => {
    expect(parse(clone())).toEqual(clone());
  });

  it('accepts a request with a string name', () => {
    expect(parse(clone({ name: 'folder' }))).toEqual(clone({ name: 'folder' }));
  });

  it('accepts a URL of exactly 2048 characters', () => {
    expect(parse(clone({ url: s(2048) }))).toEqual(clone({ url: s(2048) }));
  });

  it('rejects a URL of 2049 characters', () => {
    expect(parse(clone({ url: s(2049) }))).toBeNull();
  });

  it('accepts a parent of exactly 4096 characters', () => {
    expect(parse(clone({ parent: s(4096) }))).toEqual(clone({ parent: s(4096) }));
  });

  it('rejects a parent of 4097 characters', () => {
    expect(parse(clone({ parent: s(4097) }))).toBeNull();
  });

  it('accepts a name of exactly 1024 characters', () => {
    expect(parse(clone({ name: s(1024) }))).toEqual(clone({ name: s(1024) }));
  });

  it('rejects a name of 1025 characters', () => {
    expect(parse(clone({ name: s(1025) }))).toBeNull();
  });

  it.each([
    ['an empty URL', { url: '' }],
    ['a numeric URL', { url: 1 }],
    ['a null URL', { url: null }],
    ['an empty parent', { parent: '' }],
    ['a null parent', { parent: null }],
    ['an empty name', { name: '' }],
    ['a numeric name', { name: 3 }],
    ['a boolean name', { name: false }],
    ['an object name', { name: {} }],
    ['a numeric requestId', { requestId: 2 }],
  ])('rejects %s', (_label, over) => {
    expect(parse(clone(over))).toBeNull();
  });

  it.each(['requestId', 'url', 'parent', 'name'])('rejects a request without %s', (field) => {
    const message: Record<string, unknown> = clone();
    delete message[field];
    expect(parse(message)).toBeNull();
  });
});

describe('parseClientMessage project.clone.cancel and project.close', () => {
  it.each(['project.clone.cancel', 'project.close'])('accepts %s with a requestId', (type) => {
    expect(parse({ type, requestId: 'r9' })).toEqual({ type, requestId: 'r9' });
  });

  it.each(['project.clone.cancel', 'project.close'])('rejects %s without a requestId', (type) => {
    expect(parse({ type })).toBeNull();
  });

  it.each(['project.clone.cancel', 'project.close'])('rejects %s with a numeric requestId', (type) => {
    expect(parse({ type, requestId: 1 })).toBeNull();
  });
});

describe('parseClientMessage malformed input', () => {
  it.each(['', 'not json', '[]', 'null', '"project.close"', '{"type":"project.create"'])('returns null for %j', (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
