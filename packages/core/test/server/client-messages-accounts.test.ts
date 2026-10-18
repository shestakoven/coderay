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

  it('parses a sign-in, a choice and a removal for an engine, with the way to sign in and the key that way needs', () => {
    const messages = [
      { type: 'account.login.start', requestId: 'r1', engine: 'codex', method: 'device-code' },
      { type: 'account.login.start', requestId: 'r2', engine: 'codex', method: 'api-key', apiKey: 'sk-proj-AbC_123-xyz' },
      { type: 'account.select', requestId: 'r3', engine: 'codex', id },
      { type: 'account.remove', requestId: 'r4', engine: 'codex', id },
      { type: 'account.login.start', requestId: 'r5', engine: 'codex', method: 'api-key', apiKey: 'k'.repeat(512) },
    ];
    expect(messages.map(parse)).toEqual(messages);
  });

  it.each([
    ['an unknown engine', { type: 'account.login.start', requestId: 'r', engine: 'gemini', method: 'browser' }],
    ['a way the engine does not offer', { type: 'account.login.start', requestId: 'r', engine: 'claude', method: 'api-key', apiKey: 'sk-x' }],
    ['a key without the API-key way', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'browser', apiKey: 'sk-x' }],
    ['the API-key way without a key', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'api-key' }],
    ['a key with a space', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'api-key', apiKey: 'sk x' }],
    ['a key of 513 characters', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'api-key', apiKey: 'k'.repeat(513) }],
    ['an empty key', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'api-key', apiKey: '' }],
    ['a key given as a number', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: 'api-key', apiKey: 1234 }],
    ['a way given as a list', { type: 'account.login.start', requestId: 'r', engine: 'codex', method: ['browser'] }],
    ['the API-key way without an engine, which makes it Claude\'s', { type: 'account.login.start', requestId: 'r', method: 'api-key', apiKey: 'sk-x' }],
    ['a choice for an unknown engine', { type: 'account.select', requestId: 'r', engine: 'gemini', id: null }],
    ['a removal for an engine given as a number', { type: 'account.remove', requestId: 'r', engine: 1, id }],
  ])('rejects %s', (_, message) => {
    expect(parse(message)).toBeNull();
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

describe('parseClientMessage opencode profiles', () => {
  // A name or a key the core refuses still reaches it, which answers with the rule; only what no rule can answer is dropped here.
  it('passes a profile name trimmed, a name or a key the core answers with its rule, and the provider requests', () => {
    const messages = [
      { type: 'account.login.start', requestId: 'r1', engine: 'opencode', method: 'profile', apiKey: '  Work ' },
      { type: 'account.login.start', requestId: 'r2', engine: 'opencode', method: 'profile', apiKey: 'a\u0007b' },
      { type: 'account.providers', requestId: 'r3', id },
      { type: 'account.provider.set', requestId: 'r4', id, providerID: 'amazon-bedrock', apiKey: 'has space' },
      { type: 'account.provider.remove', requestId: 'r5', id, providerID: 'openai' },
    ];
    expect(messages.map(parse)).toEqual([{ ...messages[0], apiKey: 'Work' }, ...messages.slice(1)]);
  });

  it.each([
    ['a profile without a name', { type: 'account.login.start', requestId: 'r', engine: 'opencode', method: 'profile' }],
    ['a profile name given as a number', { type: 'account.login.start', requestId: 'r', engine: 'opencode', method: 'profile', apiKey: 7 }],
    ['a profile for Claude', { type: 'account.login.start', requestId: 'r', method: 'profile', apiKey: 'Work' }],
    ['a profile name of 4097 characters', { type: 'account.login.start', requestId: 'r', engine: 'opencode', method: 'profile', apiKey: 'x'.repeat(4097) }],
    ['the providers of an id that is no uuid', { type: 'account.providers', requestId: 'r', id: '../x' }],
    ['a key for a provider id with a slash', { type: 'account.provider.set', requestId: 'r', id, providerID: 'openai/../x', apiKey: 'sk-x' }],
    ['a removal for the provider id ..', { type: 'account.provider.remove', requestId: 'r', id, providerID: '..' }],
    ['a key that is not a string', { type: 'account.provider.set', requestId: 'r', id, providerID: 'openai', apiKey: null }],
    ['a key of 4097 characters', { type: 'account.provider.set', requestId: 'r', id, providerID: 'openai', apiKey: 'k'.repeat(4097) }],
    ['the providers without a request id', { type: 'account.providers', id }],
  ])('rejects %s', (_, message) => {
    expect(parse(message)).toBeNull();
  });
});
