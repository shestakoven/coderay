import { describe, expect, it } from 'vitest';
import { pickEvictions, type CachedImage } from '../src/chat/image-cache';

const image = (id: string, bytes: number, usedAt: number, users = 0): CachedImage => ({ id, bytes, users, usedAt });

describe('pickEvictions', () => {
  it('drops the least recently used images nobody shows until the bytes and the count fit, keeping shown ones whatever the budget', () => {
    expect([
      pickEvictions([image('new', 40, 3), image('old', 40, 1), image('mid', 40, 2)], 100, 10),
      pickEvictions([image('a', 1, 1), image('b', 1, 2), image('c', 1, 3)], 100, 2),
      pickEvictions([image('shown', 500, 1, 1), image('idle', 10, 2)], 100, 10),
      pickEvictions([image('a', 50, 1), image('b', 50, 2)], 100, 2),
    ]).toEqual([['old'], ['a'], ['idle'], []]);
  });
});
