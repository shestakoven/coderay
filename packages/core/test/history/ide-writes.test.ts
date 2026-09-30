import { describe, expect, it } from 'vitest';
import { IdeWrites } from '../../src/history/ide-writes';

describe('IdeWrites', () => {
  it('claims an expected write once', () => {
    const writes = new IdeWrites(() => 0);
    writes.expect('.ide/map.json', 'h1');
    expect(writes.claim('.ide/map.json', 'h2')).toBe(false);
    expect(writes.claim('.ide/map.json', 'h1')).toBe(true);
    expect(writes.claim('.ide/map.json', 'h1')).toBe(false);
  });

  it('does not claim for another path', () => {
    const writes = new IdeWrites(() => 0);
    writes.expect('a', 'h');
    expect(writes.claim('b', 'h')).toBe(false);
    expect(writes.claim('a', 'h')).toBe(true);
  });

  it('expires after the ttl, default 10 seconds', () => {
    let now = 0;
    const writes = new IdeWrites(() => now);
    writes.expect('a', 'h');
    now = 10_001;
    expect(writes.claim('a', 'h')).toBe(false);
    writes.expect('b', 'h');
    now = 10_000 + 10_000;
    expect(writes.claim('b', 'h')).toBe(true);
    writes.expect('c', 'h', 50);
    now += 51;
    expect(writes.claim('c', 'h')).toBe(false);
  });

  it('keeps two expectations for the same path apart, and a null hash means deletion', () => {
    const writes = new IdeWrites(() => 0);
    writes.expect('a', 'h1');
    writes.expect('a', null);
    expect(writes.claim('a', null)).toBe(true);
    expect(writes.claim('a', null)).toBe(false);
    expect(writes.claim('a', 'h1')).toBe(true);
  });
});
