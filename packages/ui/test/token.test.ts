import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/net/token';

describe('hashToken', () => {
  it('reads the token from a URL hash', () => {
    expect(hashToken('#token=abc123')).toBe('abc123');
  });

  it('returns null when the hash carries no token', () => {
    expect(hashToken('#foo=bar')).toBeNull();
  });
});
