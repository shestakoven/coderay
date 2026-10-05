import { describe, expect, it } from 'vitest';
import { AGENT_TERMINAL_ID } from '@ide/protocol';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));
const BAD_IDS: [string, unknown][] = [
  ['empty', ''],
  ['too long', 'a'.repeat(65)],
  ['with a space', 'a b'],
  ['with a slash', 'a/b'],
  ['a number', 5],
  ['null', null],
];
const BAD_DIMS: [string, unknown][] = [
  ['a fraction', 80.5],
  ['a string', '80'],
  ['null', null],
  ['a boolean', true],
];

describe('parseClientMessage terminal.open', () => {
  it('accepts a valid message', () => {
    expect(parse({ type: 'terminal.open', id: 't-1_A', cols: 80, rows: 24 })).toEqual({ type: 'terminal.open', id: 't-1_A', cols: 80, rows: 24 });
  });

  it('accepts a 64-character id', () => {
    const id = 'a'.repeat(64);
    expect(parse({ type: 'terminal.open', id, cols: 80, rows: 24 })).toEqual({ type: 'terminal.open', id, cols: 80, rows: 24 });
  });

  it.each(BAD_IDS)('rejects an id that is %s', (_n, id) => {
    expect(parse({ type: 'terminal.open', id, cols: 80, rows: 24 })).toBeNull();
  });

  it.each(BAD_DIMS)('rejects cols that is %s', (_n, cols) => {
    expect(parse({ type: 'terminal.open', id: 't', cols, rows: 24 })).toBeNull();
  });

  it.each(BAD_DIMS)('rejects rows that is %s', (_n, rows) => {
    expect(parse({ type: 'terminal.open', id: 't', cols: 80, rows })).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(parse({ type: 'terminal.open', cols: 80, rows: 24 })).toBeNull();
    expect(parse({ type: 'terminal.open', id: 't', rows: 24 })).toBeNull();
    expect(parse({ type: 'terminal.open', id: 't', cols: 80 })).toBeNull();
  });

  it('drops unknown extra fields', () => {
    expect(parse({ type: 'terminal.open', id: 't', cols: 80, rows: 24, data: 'x', extra: 1 })).toEqual({ type: 'terminal.open', id: 't', cols: 80, rows: 24 });
  });
});

describe('parseClientMessage terminal.open kind', () => {
  const open = (fields: object) => parse({ type: 'terminal.open', cols: 80, rows: 24, ...fields });

  it('accepts the agent kind for the id of the agent terminal and keeps the kind', () => {
    expect(open({ id: AGENT_TERMINAL_ID, kind: 'agent' })).toEqual({ type: 'terminal.open', id: AGENT_TERMINAL_ID, cols: 80, rows: 24, kind: 'agent' });
  });

  it.each([['an explicit shell kind', { kind: 'shell' }], ['no kind', {}]])('rejects the id of the agent terminal with %s', (_name, fields) => {
    expect(open({ id: AGENT_TERMINAL_ID, ...fields })).toBeNull();
  });

  it.each([['an explicit shell kind', { kind: 'shell' }], ['no kind', {}]])('still opens a shell with %s under another id, even one that looks like the id of the agent terminal', (_name, fields) => {
    for (const id of ['t1', 'agent-2', 'agent_', 'Agent', 'agen', 'xagent']) {
      expect(open({ id, ...fields }), id).toEqual({ type: 'terminal.open', id, cols: 80, rows: 24 });
    }
  });

  it.each([['an unknown kind', 'other'], ['a kind that is a number', 5], ['a null kind', null], ['a kind in other case', 'Agent']])('rejects %s', (_name, kind) => {
    expect(open({ id: 't', kind })).toBeNull();
    expect(open({ id: AGENT_TERMINAL_ID, kind })).toBeNull();
  });
});

describe('parseClientMessage terminal.resize', () => {
  it('accepts a valid message', () => {
    expect(parse({ type: 'terminal.resize', id: 't', cols: 100, rows: 30 })).toEqual({ type: 'terminal.resize', id: 't', cols: 100, rows: 30 });
  });

  it.each(BAD_IDS)('rejects an id that is %s', (_n, id) => {
    expect(parse({ type: 'terminal.resize', id, cols: 80, rows: 24 })).toBeNull();
  });

  it.each(BAD_DIMS)('rejects cols that is %s', (_n, cols) => {
    expect(parse({ type: 'terminal.resize', id: 't', cols, rows: 24 })).toBeNull();
  });

  it.each(BAD_DIMS)('rejects rows that is %s', (_n, rows) => {
    expect(parse({ type: 'terminal.resize', id: 't', cols: 80, rows })).toBeNull();
  });

  it('rejects missing cols or rows', () => {
    expect(parse({ type: 'terminal.resize', id: 't', rows: 24 })).toBeNull();
    expect(parse({ type: 'terminal.resize', id: 't', cols: 80 })).toBeNull();
  });
});

describe('parseClientMessage terminal.input', () => {
  it('accepts a valid message', () => {
    expect(parse({ type: 'terminal.input', id: 't', data: 'ls\r' })).toEqual({ type: 'terminal.input', id: 't', data: 'ls\r' });
  });

  it('accepts empty data', () => {
    expect(parse({ type: 'terminal.input', id: 't', data: '' })).toEqual({ type: 'terminal.input', id: 't', data: '' });
  });

  it('accepts exactly 65536 characters and rejects 65537', () => {
    expect(parse({ type: 'terminal.input', id: 't', data: 'x'.repeat(65536) })).not.toBeNull();
    expect(parse({ type: 'terminal.input', id: 't', data: 'x'.repeat(65537) })).toBeNull();
  });

  it.each([
    ['a number', 5],
    ['null', null],
    ['an array', ['a']],
    ['an object', { a: 1 }],
  ])('rejects data that is %s', (_n, data) => {
    expect(parse({ type: 'terminal.input', id: 't', data })).toBeNull();
  });

  it('rejects missing data', () => {
    expect(parse({ type: 'terminal.input', id: 't' })).toBeNull();
  });

  it.each(BAD_IDS)('rejects an id that is %s', (_n, id) => {
    expect(parse({ type: 'terminal.input', id, data: 'x' })).toBeNull();
  });
});

describe('parseClientMessage terminal.close', () => {
  it('accepts a valid id', () => {
    expect(parse({ type: 'terminal.close', id: 't' })).toEqual({ type: 'terminal.close', id: 't' });
  });

  it.each(BAD_IDS)('rejects an id that is %s', (_n, id) => {
    expect(parse({ type: 'terminal.close', id })).toBeNull();
  });

  it('rejects a missing id', () => {
    expect(parse({ type: 'terminal.close' })).toBeNull();
  });
});
