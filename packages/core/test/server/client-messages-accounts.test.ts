import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (message: object) => parseClientMessage(JSON.stringify(message));
const id = randomUUID();

describe('parseClientMessage account requests', () => {
  it('parses the login start, code and cancel requests with their request ids', () => {
    const messages = [
      { type: 'account.login.start', requestId: 'r1' },
      { type: 'account.login.code', requestId: 'r2', code: 'abc-123#state' },
      { type: 'account.login.cancel', requestId: 'r3' },
    ];
    expect(messages.map(parse)).toEqual(messages);
  });

  it('parses selecting an account by uuid and selecting System as null', () => {
    const messages = [
      { type: 'account.select', requestId: 'r1', id },
      { type: 'account.select', requestId: 'r2', id: null },
    ];
    expect(messages.map(parse)).toEqual(messages);
  });

  it('parses removing an account by uuid', () => {
    expect(parse({ type: 'account.remove', requestId: 'r1', id })).toEqual({ type: 'account.remove', requestId: 'r1', id });
  });

  it('accepts a code of exactly 4096 characters', () => {
    const code = 'c'.repeat(4096);
    expect(parse({ type: 'account.login.code', requestId: 'r', code })).toEqual({ type: 'account.login.code', requestId: 'r', code });
  });

  it.each([
    ['without a request id', { type: 'account.login.start' }],
    ['with a numeric request id', { type: 'account.login.cancel', requestId: 1 }],
  ])('rejects a login request %s', (_, message) => {
    expect(parse(message)).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['a number', { code: 123 }],
    ['null', { code: null }],
    ['empty', { code: '' }],
    ['only whitespace', { code: ' \t\n ' }],
    ['4097 characters long', { code: 'c'.repeat(4097) }],
    ['a list', { code: ['abc'] }],
  ])('rejects a login code that is %s', (_, fields) => {
    expect(parse({ type: 'account.login.code', requestId: 'r', ...fields })).toBeNull();
  });

  it('rejects a login code without a request id', () => {
    expect(parse({ type: 'account.login.code', code: 'abc' })).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['not a uuid', { id: 'work' }],
    ['a path', { id: '../x' }],
    ['an empty string', { id: '' }],
    ['a number', { id: 7 }],
    ['a uuid with a path after it', { id: `${id}/..` }],
  ])('rejects selecting an account whose id is %s', (_, fields) => {
    expect(parse({ type: 'account.select', requestId: 'r', ...fields })).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['null', { id: null }],
    ['not a uuid', { id: 'work' }],
    ['a path', { id: '../x' }],
    ['an empty string', { id: '' }],
    ['a number', { id: 7 }],
  ])('rejects removing an account whose id is %s', (_, fields) => {
    expect(parse({ type: 'account.remove', requestId: 'r', ...fields })).toBeNull();
  });

  it('rejects select and remove without a request id', () => {
    expect([parse({ type: 'account.select', id }), parse({ type: 'account.remove', id })]).toEqual([null, null]);
  });
});
