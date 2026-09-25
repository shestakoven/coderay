import { describe, expect, it } from 'vitest';
import { changedFiles, componentEdges, staleness, type GroupingBaseline, type StalenessInput } from '../../src/map/staleness';
import { unit } from '../helpers';

const baseline: GroupingBaseline = {
  mapKey: 'key',
  centroids: { 'ai:a': [1, 0, 0], 'ai:b': Array.from(unit(0.8, 0.6, 0)) },
  componentEdges: ['ai:a -> ai:b'],
  members: {},
  complete: true,
};

const input = (overrides: Partial<StalenessInput>): StalenessInput => ({
  totalFiles: 20,
  unassigned: 0,
  centroids: new Map([
    ['ai:a', unit(1, 0, 0)],
    ['ai:b', unit(0.8, 0.6, 0)],
  ]),
  changedFiles: new Map(),
  baseline,
  componentEdges: new Set(['ai:a -> ai:b']),
  ...overrides,
});

const moved = new Map([
  ['ai:a', unit(1, 0, 0.6)],
  ['ai:b', unit(0.8, 0.6, 0)],
]);

describe('staleness', () => {
  it('is fresh when nothing drifted and few files are unassigned', () => {
    expect(staleness(input({ unassigned: 2 }))).toEqual({ reasons: [], driftedComponents: [] });
  });

  it('is stale when more than a tenth of the files are unassigned', () => {
    expect(staleness(input({ unassigned: 3 })).reasons).toEqual(['3 of 20 files are not in any component']);
  });

  it('ignores fewer than three unassigned files, even in a tiny project', () => {
    expect(staleness(input({ totalFiles: 5, unassigned: 2 })).reasons).toEqual([]);
  });

  it('flags a component whose centroid moved past halfway to its nearest neighbour after several of its files changed', () => {
    const result = staleness(input({ centroids: moved, changedFiles: new Map([['ai:a', 3]]) }));
    expect(result).toEqual({ reasons: ['ai:a changed a lot since the grouping'], driftedComponents: ['ai:a'] });
  });

  it('does not flag a component when fewer than three of its files changed, however far its centroid moved', () => {
    expect(staleness(input({ centroids: moved, changedFiles: new Map([['ai:a', 2]]) })).driftedComponents).toEqual([]);
  });

  it('is stale when more than 30% of the dependencies between components changed', () => {
    const before = { ...baseline, componentEdges: ['ai:a -> ai:b', 'ai:b -> ai:c', 'ai:c -> ai:d'] };
    const after = new Set(['ai:a -> ai:b', 'ai:b -> ai:c', 'ai:d -> ai:a']);
    expect(staleness(input({ baseline: before, componentEdges: after })).reasons).toEqual([
      '50% of the dependencies between components changed',
    ]);
  });

  it('skips drift and dependency checks without a baseline', () => {
    const result = staleness(
      input({ baseline: null, centroids: moved, changedFiles: new Map([['ai:a', 5]]), componentEdges: new Set(['ai:x -> ai:y']) }),
    );
    expect(result.reasons).toEqual([]);
  });
});

describe('componentEdges', () => {
  it('aggregates file edges into component edges without self edges or unowned files', () => {
    const owner = new Map([
      ['a1.ts', 'ai:a'],
      ['a2.ts', 'ai:a'],
      ['b1.ts', 'ai:b'],
    ]);
    const edges = [
      { from: 'a1.ts', to: 'b1.ts', kind: 'import' as const },
      { from: 'a2.ts', to: 'b1.ts', kind: 'import' as const },
      { from: 'a1.ts', to: 'a2.ts', kind: 'import' as const },
      { from: 'x.ts', to: 'b1.ts', kind: 'import' as const },
    ];
    expect([...componentEdges(edges, owner)]).toEqual(['ai:a -> ai:b']);
  });
});

describe('changedFiles', () => {
  it('counts the removed, modified, moved and added files of each component since the baseline', () => {
    const members: GroupingBaseline['members'] = {
      'a/kept.ts': ['ai:a', 'h1'],
      'a/edited.ts': ['ai:a', 'h2'],
      'a/deleted.ts': ['ai:a', 'h3'],
      'a/moved.ts': ['ai:a', 'h4'],
    };
    const owner = new Map([
      ['a/kept.ts', 'ai:a'],
      ['a/edited.ts', 'ai:a'],
      ['a/moved.ts', 'ai:b'],
      ['a/new.ts', 'ai:a'],
    ]);
    const hashes = new Map([
      ['a/kept.ts', 'h1'],
      ['a/edited.ts', 'changed'],
      ['a/moved.ts', 'h4'],
      ['a/new.ts', 'h5'],
    ]);
    expect(changedFiles(members, owner, hashes)).toEqual(
      new Map([
        ['ai:a', 4],
        ['ai:b', 1],
      ]),
    );
  });
});
