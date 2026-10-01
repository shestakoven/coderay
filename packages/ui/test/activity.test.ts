import { describe, expect, it } from 'vitest';
import type { MapProgress, MapStatus } from '@ide/protocol';
import { elapsedText, mapActivities } from '../src/map/activity';
import { folderStatus } from './snapshot';

const status = (overrides: Partial<MapStatus>): MapStatus => ({ ...folderStatus, ...overrides });
const idle: MapProgress = { indexing: null, embedding: null };
const embedding = (done: number, total: number): MapProgress => ({ indexing: null, embedding: { done, total } });
const only = (progress: MapProgress, s: MapStatus | null) => {
  const list = mapActivities(progress, s);
  expect(list).toHaveLength(1);
  return list[0]!;
};

describe('mapActivities', () => {
  it('returns nothing when nothing is running', () => {
    expect(mapActivities(idle, folderStatus)).toEqual([]);
  });

  it('reports indexing with the number of files read and no fraction', () => {
    expect(only({ indexing: { indexed: 42 }, embedding: null }, null)).toEqual({
      key: 'indexing',
      label: 'Indexing source files',
      detail: '42 files read',
      fraction: null,
    });
  });

  it('reports embedding as done / total files with the matching fraction', () => {
    expect(only(embedding(3, 12), null)).toEqual({
      key: 'embedding',
      label: 'Computing file embeddings',
      detail: '3 / 12 files',
      fraction: 0.25,
    });
  });

  it('caps the embedding fraction at 1 when done exceeds total', () => {
    expect(only(embedding(15, 10), null).fraction).toBe(1);
  });

  it('floors the embedding fraction at 0 when done is negative', () => {
    expect(only(embedding(-5, 10), null).fraction).toBe(0);
  });

  it('gives a null fraction for a zero total instead of NaN or Infinity', () => {
    const item = only(embedding(0, 0), null);
    expect(item.fraction).toBeNull();
    expect(only(embedding(4, 0), null).fraction).toBeNull();
    expect(item.detail).toBe('0 / 0 files');
  });

  it('keeps a complete embedding at exactly 1', () => {
    expect(only(embedding(10, 10), null).fraction).toBe(1);
  });

  it.each([
    [0.4 * 1024 * 1024, '0 MB'],
    [0.6 * 1024 * 1024, '1 MB'],
    [1.5 * 1024 * 1024, '2 MB'],
    [34_726_871, '33 MB'],
    [undefined, '0 MB'],
    [null, '0 MB'],
  ])('shows a model download of %s bytes as %s with no fraction', (bytes, text) => {
    const item = only(idle, status({ embeddings: 'downloading', modelDownloadBytes: bytes as number | null }));
    expect(item).toEqual({ key: 'model', label: 'Downloading the local embedding model', detail: text, fraction: null });
  });

  it('uses 1024 * 1024 bytes per MB', () => {
    expect(only(idle, status({ embeddings: 'downloading', modelDownloadBytes: 10 * 1024 * 1024 })).detail).toBe('10 MB');
  });

  it('ignores a ready or unavailable embedding model', () => {
    expect(mapActivities(idle, status({ embeddings: 'ready' }))).toEqual([]);
    expect(mapActivities(idle, status({ embeddings: 'unavailable' }))).toEqual([]);
  });

  it('names the paths, symbols and dependency counts a running grouping sent and says file contents are never sent', () => {
    const item = only(idle, status({ grouping: 'running', sending: { paths: 92, symbols: 240, links: 31 } }));
    expect(item).toEqual({
      key: 'grouping',
      label: 'Grouping files into components with Haiku',
      detail: 'Sent 92 paths, 240 symbol names, 31 dependency counts. File contents are never sent.',
      fraction: null,
    });
  });

  it('says it waits for embeddings when a running grouping has sent nothing yet', () => {
    expect(only(idle, status({ grouping: 'running', sending: null })).detail).toBe('Waiting for embeddings before asking Haiku');
  });

  it.each(['failed', 'idle', 'too-large'] as const)('shows no grouping item when grouping is %s', (grouping) => {
    expect(mapActivities(idle, status({ grouping, sending: { paths: 1, symbols: 1, links: 1 } }))).toEqual([]);
  });

  it('shows only progress-based items when the status is null', () => {
    const list = mapActivities({ indexing: { indexed: 1 }, embedding: { done: 1, total: 2 } }, null);
    expect(list.map((item) => item.key)).toEqual(['indexing', 'embedding']);
  });

  it('orders items indexing, model, embedding, grouping when all are active', () => {
    const list = mapActivities(
      { indexing: { indexed: 5 }, embedding: { done: 1, total: 2 } },
      status({ embeddings: 'downloading', modelDownloadBytes: 1, grouping: 'running' }),
    );
    expect(list.map((item) => item.key)).toEqual(['indexing', 'model', 'embedding', 'grouping']);
  });

  it('gives every item a unique key', () => {
    const list = mapActivities(
      { indexing: { indexed: 5 }, embedding: { done: 1, total: 2 } },
      status({ embeddings: 'downloading', grouping: 'running' }),
    );
    expect(new Set(list.map((item) => item.key)).size).toBe(list.length);
  });
});

describe('elapsedText', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [1000, '1s'],
    [1999, '1s'],
    [59_000, '59s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [61_000, '1m 01s'],
    [69_000, '1m 09s'],
    [70_000, '1m 10s'],
    [119_000, '1m 59s'],
    [120_000, '2m 00s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '60m 00s'],
  ])('shows %i ms as %s', (ms, text) => {
    expect(elapsedText(1_000_000, 1_000_000 + ms)).toBe(text);
  });

  it('clamps a start in the future to 0s', () => {
    expect(elapsedText(5000, 1000)).toBe('0s');
    expect(elapsedText(5000, 4999)).toBe('0s');
  });
});
