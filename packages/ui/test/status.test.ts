import { describe, expect, it } from 'vitest';
import type { MapStatus } from '@ide/protocol';
import { describeMapStatus } from '../src/map/status';
import { folderStatus } from './snapshot';

const status = (overrides: Partial<MapStatus>): MapStatus => ({ ...folderStatus, ...overrides });

describe('describeMapStatus', () => {
  it('shows a fresh AI map with its grouping time', () => {
    expect(describeMapStatus(status({ layer: 'ai', groupedAt: '2026-09-24T10:00:00.000Z' }))).toEqual([
      { text: 'AI map', tone: 'ok', title: 'Grouped at 2026-09-24T10:00:00.000Z' },
    ]);
  });

  it('says in the AI map tooltip whether new files may be placed by embedding', () => {
    const placement = { on: false, detail: 'no calibrated setting' };
    expect(describeMapStatus(status({ layer: 'ai', groupedAt: 'T1', embeddingPlacement: placement }))[0]?.title).toBe(
      'Grouped at T1\nEmbedding placement: off (no calibrated setting)',
    );
  });

  it('lists the reasons of a stale map in its tooltip', () => {
    const reasons = ['3 of 9 files are not in any component', 'ai:api changed a lot since the grouping'];
    expect(describeMapStatus(status({ layer: 'ai', stale: true, staleReasons: reasons }))[0]).toEqual({
      text: 'AI map · stale',
      tone: 'warn',
      title: reasons.join('\n'),
    });
  });

  it('announces the embedding model download with its size', () => {
    const chips = describeMapStatus(status({ embeddings: 'downloading', modelDownloadBytes: 34_726_871 }));
    expect(chips.map((chip) => chip.text)).toContain('downloading embedding model (33 MB)…');
  });

  it('explains what changes while embeddings are unavailable', () => {
    const chips = describeMapStatus(status({ embeddings: 'unavailable', embeddingsError: 'offline' }));
    expect(chips.find((chip) => chip.text === 'embeddings unavailable')).toEqual({
      text: 'embeddings unavailable',
      tone: 'warn',
      title: 'offline. Grouping uses folder groups, and new files that no rule places stay unassigned.',
    });
  });

  it('says what a running grouping sent to Haiku and that file contents are never sent', () => {
    const chips = describeMapStatus(status({ grouping: 'running', sending: { paths: 92, symbols: 240, links: 31 } }));
    expect(chips[1]).toEqual({
      text: 'grouping… sent 92 paths, 240 symbol names, 31 dependency counts',
      tone: 'muted',
      title: 'Haiku receives file paths, exported symbol names and import counts between groups. File contents are never sent.',
    });
  });

  it('explains why AI grouping is off for a project above the file limit', () => {
    const message = 'AI grouping is limited to 10000 files; this project has 12000';
    expect(describeMapStatus(status({ grouping: 'too-large', groupingError: message }))[1]).toEqual({
      text: 'AI grouping off',
      tone: 'muted',
      title: message,
    });
  });

  it('shows a failed grouping with its error next to the folder map', () => {
    const failed = status({ grouping: 'failed', groupingError: 'not logged in', stale: true, staleReasons: ['the last grouping failed: not logged in'] });
    expect(describeMapStatus(failed)).toEqual([
      { text: 'folder map', tone: 'muted', title: 'Components are folders until an AI grouping succeeds' },
      { text: 'grouping failed', tone: 'error', title: 'not logged in' },
    ]);
  });
});
