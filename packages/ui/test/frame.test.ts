import { describe, expect, it } from 'vitest';
import { fitsFrame } from '../src/net/socket';

describe('fitsFrame', () => {
  it('accepts a chat message whose frame fits in 64 KiB', () => {
    expect(fitsFrame({ type: 'chat.send', text: 'x'.repeat(60_000) })).toBe(true);
  });

  it('refuses a chat message whose UTF-8 frame exceeds 64 KiB although it has fewer characters', () => {
    expect(fitsFrame({ type: 'chat.send', text: 'ж'.repeat(40_000) })).toBe(false);
  });
});
