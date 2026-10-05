import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));
const s = (length: number): string => 'x'.repeat(length);
const BAD_IDS = [undefined, null, '', s(101), 7, true, {}, ['p1']];

describe('parseClientMessage hub.activate', () => {
  it('accepts an id', () => {
    expect(parse({ type: 'hub.activate', id: 'p0123456789' })).toEqual({ type: 'hub.activate', id: 'p0123456789' });
  });

  it('accepts an id of exactly 100 characters', () => {
    expect(parse({ type: 'hub.activate', id: s(100) })).toEqual({ type: 'hub.activate', id: s(100) });
  });

  it.each(BAD_IDS.map((id) => [JSON.stringify(id) ?? 'missing', id]))('rejects the id %s', (_label, id) => {
    expect(parse({ type: 'hub.activate', id })).toBeNull();
  });

  it('drops unknown fields', () => {
    expect(parse({ type: 'hub.activate', id: 'p1', extra: 'x' })).toEqual({ type: 'hub.activate', id: 'p1' });
  });
});

describe('parseClientMessage hub.order', () => {
  it('accepts a list of ids, keeping their order', () => {
    expect(parse({ type: 'hub.order', ids: ['p2', 'p1', 'p3'] })).toEqual({ type: 'hub.order', ids: ['p2', 'p1', 'p3'] });
  });

  it('accepts an empty list', () => {
    expect(parse({ type: 'hub.order', ids: [] })).toEqual({ type: 'hub.order', ids: [] });
  });

  it('accepts 100 ids of 100 characters', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(100, 'x'));
    expect(parse({ type: 'hub.order', ids })).toEqual({ type: 'hub.order', ids });
  });

  it('rejects more than 100 ids', () => {
    expect(parse({ type: 'hub.order', ids: Array.from({ length: 101 }, (_, i) => `p${i}`) })).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'p1'],
    ['an object', { 0: 'p1' }],
  ])('rejects ids that are %s', (_label, ids) => {
    expect(parse({ type: 'hub.order', ids })).toBeNull();
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['an empty string', ''],
    ['a 101-character string', s(101)],
    ['an array', ['p1']],
    ['an object', { id: 'p1' }],
  ])('rejects a list with %s among valid ids', (_label, bad) => {
    expect(parse({ type: 'hub.order', ids: ['p1', bad, 'p2'] })).toBeNull();
  });
});

describe.each(['hub.close', 'hub.restart'] as const)('parseClientMessage %s', (type) => {
  const valid = { type, requestId: 'r1', id: 'p0123456789' };

  it('accepts a request id and a project id', () => {
    expect(parse(valid)).toEqual(valid);
  });

  it('accepts a project id of exactly 100 characters', () => {
    expect(parse({ ...valid, id: s(100) })).toEqual({ ...valid, id: s(100) });
  });

  it.each(BAD_IDS.map((id) => [JSON.stringify(id) ?? 'missing', id]))('rejects the project id %s', (_label, id) => {
    expect(parse({ ...valid, id })).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['a number', 1],
    ['null', null],
    ['an object', {}],
  ])('rejects a request id that is %s', (_label, requestId) => {
    expect(parse({ ...valid, requestId })).toBeNull();
  });
});
