import { describe, expect, it } from 'vitest';
import { initialModeSave, modeSaveReducer } from '../src/settings/mode-save';

describe('modeSaveReducer', () => {
  it('shows a failed mode save for five seconds', () => {
    let s = modeSaveReducer(initialModeSave, { type: 'failed', message: 'nope', now: 1000 });
    expect(s).toEqual({ error: 'nope', until: 6000 });
    s = modeSaveReducer(s, { type: 'expire', now: 5999 });
    expect(s.error).toBe('nope');
    s = modeSaveReducer(s, { type: 'expire', now: 6000 });
    expect(s.error).toBeNull();
  });

  it('clears the error when a later save succeeds', () => {
    const failed = modeSaveReducer(initialModeSave, { type: 'failed', message: 'nope', now: 1 });
    expect(modeSaveReducer(failed, { type: 'saved' }).error).toBeNull();
  });
});
