import { describe, expect, it } from 'vitest';
import { averageLinkageGroups } from '../../src/map/cluster';
import { unit } from '../helpers';

describe('averageLinkageGroups', () => {
  it('returns no groups for no vectors', () => {
    expect(averageLinkageGroups([], [], { targetGroups: 3, edgeBonus: 0 })).toEqual([]);
  });

  it('groups similar vectors and stops at the target number of groups', () => {
    const vectors = [unit(1, 0.05, 0), unit(1, 0, 0.05), unit(0.05, 1, 0), unit(1, 0.02, 0.02), unit(0, 1, 0.05), unit(0, 0.05, 1)];
    expect(averageLinkageGroups(vectors, [], { targetGroups: 3, edgeBonus: 0 })).toEqual([[0, 1, 3], [2, 4], [5]]);
  });

  it('lets an import link pull two files into one group', () => {
    const vectors = [unit(1, 0), unit(0.8, 0.6), unit(0.6, 0.8)];
    expect(averageLinkageGroups(vectors, [], { targetGroups: 2, edgeBonus: 0.3 })).toEqual([[0], [1, 2]]);
    expect(averageLinkageGroups(vectors, [[0, 1]], { targetGroups: 2, edgeBonus: 0.3 })).toEqual([[0, 1], [2]]);
  });

  it('keeps every vector apart when the target is at least the number of vectors', () => {
    expect(averageLinkageGroups([unit(1, 0), unit(1, 0.01)], [], { targetGroups: 2, edgeBonus: 0 })).toEqual([[0], [1]]);
  });
});
