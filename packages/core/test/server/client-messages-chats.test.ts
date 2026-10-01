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
});
