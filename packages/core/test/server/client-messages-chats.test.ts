import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '@ide/protocol';
import { parseClientMessage } from '../../src/server/client-messages';

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('parseClientMessage session.list', () => {
  it('accepts the bare message', () => {
    expect(parse({ type: 'session.list' })).toEqual({ type: 'session.list' });
  });

  it('drops extra fields instead of passing them on', () => {
    expect(parse({ type: 'session.list', id: 'x', limit: 5 })).toEqual({ type: 'session.list' });
  });
});

describe('parseClientMessage session.switch', () => {
  it('accepts a non-empty id', () => {
    expect(parse({ type: 'session.switch', id: 'b0a1-uuid' })).toEqual({ type: 'session.switch', id: 'b0a1-uuid' });
  });

  it('accepts an id of exactly 100 characters and rejects 101', () => {
    expect([parse({ type: 'session.switch', id: 'x'.repeat(100) }), parse({ type: 'session.switch', id: 'x'.repeat(101) })]).toEqual([
      { type: 'session.switch', id: 'x'.repeat(100) },
      null,
    ]);
  });

  it('rejects a missing id', () => {
    expect(parse({ type: 'session.switch' })).toBeNull();
  });

  it('rejects an empty id', () => {
    expect(parse({ type: 'session.switch', id: '' })).toBeNull();
  });

  it('rejects an id that is not a string', () => {
    expect([1, true, null, {}, ['a'], { toString: 'a' }].map((id) => parse({ type: 'session.switch', id }))).toEqual([null, null, null, null, null, null]);
  });

  it('keeps only the type and the id', () => {
    expect(parse({ type: 'session.switch', id: 'a', modelChoice: 'opus', requestId: 'r' })).toEqual({ type: 'session.switch', id: 'a' });
  });
});

describe('parseClientMessage session.configure', () => {
  it('accepts a model and an effort', () => {
    expect(parse({ type: 'session.configure', modelChoice: 'opus', effort: 'high' })).toEqual({ type: 'session.configure', modelChoice: 'opus', effort: 'high' });
  });

  it('accepts null for both, meaning the defaults', () => {
    expect(parse({ type: 'session.configure', modelChoice: null, effort: null })).toEqual({ type: 'session.configure', modelChoice: null, effort: null });
  });

  it('accepts a full model id and every effort level', () => {
    const parsed = EFFORT_LEVELS.map((effort) => parse({ type: 'session.configure', modelChoice: 'claude-haiku-4-5-20251001', effort }));
    expect(parsed).toEqual(EFFORT_LEVELS.map((effort) => ({ type: 'session.configure', modelChoice: 'claude-haiku-4-5-20251001', effort })));
  });

  it('rejects a model that is not a string or null', () => {
    expect([1, true, {}, ['opus']].map((modelChoice) => parse({ type: 'session.configure', modelChoice, effort: null }))).toEqual([null, null, null, null]);
  });

  it('rejects a missing model or a missing effort', () => {
    expect([parse({ type: 'session.configure', effort: null }), parse({ type: 'session.configure', modelChoice: null })]).toEqual([null, null]);
  });

  it('rejects a model that could be read as a flag or carries shell characters', () => {
    const bad = ['--evil', '-x', '', 'opus sonnet', 'opus;ls', 'opus\n', 'a'.repeat(65)];
    expect(bad.map((modelChoice) => parse({ type: 'session.configure', modelChoice, effort: null }))).toEqual(bad.map(() => null));
  });

  it('rejects an effort that is not a known level', () => {
    const bad = ['ultra', 'HIGH', '', 'default', 1, true, {}, ['high']];
    expect(bad.map((effort) => parse({ type: 'session.configure', modelChoice: null, effort }))).toEqual(bad.map(() => null));
  });

  it('rejects a valid effort next to an invalid model and the other way round', () => {
    expect([
      parse({ type: 'session.configure', modelChoice: '--evil', effort: 'high' }),
      parse({ type: 'session.configure', modelChoice: 'opus', effort: 'ultra' }),
    ]).toEqual([null, null]);
  });

  it('keeps only the type, the model and the effort', () => {
    expect(parse({ type: 'session.configure', modelChoice: 'opus', effort: 'low', id: 'a', text: 'x' })).toEqual({ type: 'session.configure', modelChoice: 'opus', effort: 'low' });
  });

  it('takes a model of any engine with an effort that engine names, and refuses one its engine does not', () => {
    expect([
      parse({ type: 'session.configure', modelChoice: 'codex:gpt-6-luna', effort: 'minimal' }),
      parse({ type: 'session.configure', modelChoice: 'opencode:openrouter/anthropic/claude-3.5:beta', effort: null }),
      parse({ type: 'session.configure', modelChoice: 'opus', effort: 'minimal' }),
      parse({ type: 'session.configure', modelChoice: 'codex:', effort: null }),
    ]).toEqual([
      { type: 'session.configure', modelChoice: 'codex:gpt-6-luna', effort: 'minimal' },
      { type: 'session.configure', modelChoice: 'opencode:openrouter/anthropic/claude-3.5:beta', effort: null },
      null, null,
    ]);
  });
});

describe('parseClientMessage session.new', () => {
  it('opens a new chat on a model when one is named, plain otherwise, and refuses an invalid or missing model', () => {
    expect([
      parse({ type: 'session.new' }),
      parse({ type: 'session.new', modelChoice: 'codex:gpt-6-luna', effort: 'minimal' }),
      parse({ type: 'session.new', modelChoice: 'opus' }),
      parse({ type: 'session.new', modelChoice: '--evil', effort: null }),
      parse({ type: 'session.new', effort: 'high' }),
    ]).toEqual([
      { type: 'session.new' },
      { type: 'session.new', modelChoice: 'codex:gpt-6-luna', effort: 'minimal' },
      { type: 'session.new', modelChoice: 'opus', effort: null },
      null, null,
    ]);
  });
});

describe('parseClientMessage session.delete', () => {
  it('accepts a chat id and the delete-all request', () => {
    expect([parse({ type: 'session.delete', id: 'b0a1-uuid' }), parse({ type: 'session.delete-all' })]).toEqual([
      { type: 'session.delete', id: 'b0a1-uuid' },
      { type: 'session.delete-all' },
    ]);
  });

  it('rejects a missing, empty, non-string or oversized id', () => {
    expect([
      parse({ type: 'session.delete' }), parse({ type: 'session.delete', id: '' }), parse({ type: 'session.delete', id: 7 }), parse({ type: 'session.delete', id: 'x'.repeat(101) }),
    ]).toEqual([null, null, null, null]);
  });
});

describe('parseClientMessage image.get', () => {
  const id = 'ab'.repeat(32);

  it('accepts a key with exactly one of a blob id or a path, and drops extra fields', () => {
    expect([
      parse({ type: 'image.get', key: 'i:x#1', id, extra: true }),
      parse({ type: 'image.get', key: 'p:x#2', path: '../docs/shot.png' }),
      parse({ type: 'image.get', key: 'k'.repeat(4096), path: 'p'.repeat(4096) }),
    ]).toEqual([
      { type: 'image.get', key: 'i:x#1', id },
      { type: 'image.get', key: 'p:x#2', path: '../docs/shot.png' },
      { type: 'image.get', key: 'k'.repeat(4096), path: 'p'.repeat(4096) },
    ]);
  });

  it('rejects a request that names both or neither, an id that is not 64 lowercase hex, and a missing, empty or oversized key or path', () => {
    const malformed = {
      both: { key: 'k', id, path: 'a.png' },
      neither: { key: 'k' },
      'short id': { key: 'k', id: id.slice(1) },
      'uppercase id': { key: 'k', id: id.toUpperCase() },
      'path-like id': { key: 'k', id: `../${id}` },
      'numeric id': { key: 'k', id: 7 },
      'no key': { id },
      'empty key': { key: '', id },
      'huge key': { key: 'k'.repeat(4097), id },
      'empty path': { key: 'k', path: '' },
      'huge path': { key: 'k', path: 'p'.repeat(4097) },
      'path not a string': { key: 'k', path: ['a.png'] },
    };
    expect(Object.fromEntries(Object.entries(malformed).map(([name, fields]) => [name, parse({ type: 'image.get', ...fields })])))
      .toEqual(Object.fromEntries(Object.keys(malformed).map((name) => [name, null])));
  });
});
