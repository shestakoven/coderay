import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_FRAME_BYTES } from '@ide/protocol';
import { fitsFrame } from '../src/net/socket';

describe('fitsFrame', () => {
  it('accepts a chat message whose frame fits the limit', () => {
    expect(fitsFrame({ type: 'chat.send', text: 'x'.repeat(MAX_CLIENT_FRAME_BYTES - 100) })).toBe(true);
  });

  it('refuses a chat message whose UTF-8 frame exceeds the limit although it has fewer characters', () => {
    expect(fitsFrame({ type: 'chat.send', text: 'ж'.repeat(MAX_CLIENT_FRAME_BYTES * 0.6) })).toBe(false);
  });
});
