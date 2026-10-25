import { describe, expect, it } from 'vitest';
import type { MapStatus } from '@ide/protocol';
import { describeMapStatus, describeProgress } from '../src/map/status';
import { folderStatus } from './snapshot';

const status = (overrides: Partial<MapStatus>): MapStatus => ({ ...folderStatus, backgroundAi: { state: 'checking' }, ...overrides });

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

  it('says how much a running grouping sent', () => {
    const chips = describeMapStatus(status({ grouping: 'running', sending: { paths: 92, symbols: 240, links: 31 } }));
    expect(chips[1]).toEqual({
      text: 'grouping… sent 92 paths, 240 symbol names, 31 dependency counts',
      tone: 'muted',
      title: 'Grouping files into components',
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

  it('shows an off background AI as one calm chip per reason, never "grouping failed" or "AI grouping off"', () => {
    const rows = ([
      [{ reason: 'none', engine: null }, 'failed'],
      [{ reason: 'choice', engine: null }, 'too-large'],
      [{ reason: 'unavailable', engine: 'codex' }, 'failed'],
    ] as const).map(([off, grouping]) => describeMapStatus(status({ grouping, groupingError: 'x', backgroundAi: { state: 'off', hint: 'The hint.', ...off } })));
    expect(rows).toEqual([
      [{ text: 'folder map', tone: 'muted', title: 'Components are folders until an AI grouping succeeds' }, { text: 'AI off · no engine', tone: 'muted', title: 'The hint.' }],
      [{ text: 'folder map', tone: 'muted', title: 'Components are folders until an AI grouping succeeds' }, { text: 'AI off', tone: 'muted', title: 'The hint.' }],
      [{ text: 'folder map', tone: 'muted', title: 'Components are folders until an AI grouping succeeds' }, { text: 'AI off · Codex not ready', tone: 'warn', title: 'The hint.' }],
    ]);
  });

  it('names the engine behind a ready AI map, and a grouping that failed on an engine Auto has since passed over is calm', () => {
    const note = 'Claude Code failed: Not logged in';
    const ready = { state: 'ready', engine: 'codex', modelId: 'codex:x', note } as const;
    const [chip] = describeMapStatus(status({ layer: 'ai', groupedAt: 'T1', backgroundAi: ready }));
    expect(chip!.title).toBe(`Grouped at T1\nBackground AI: Codex\n${note}`);
    expect(describeMapStatus(status({ grouping: 'failed', groupingError: 'Not logged in', backgroundAi: ready }))).toEqual([
      { text: 'folder map', tone: 'muted', title: `Components are folders until an AI grouping succeeds\nBackground AI: Codex\n${note}` },
      { text: 'grouping moves to Codex', tone: 'muted', title: `${note}\nThe next grouping runs on Codex; Regroup runs it now.` },
    ]);
    expect(describeMapStatus(status({ grouping: 'failed', groupingError: 'Not logged in', backgroundAi: { ...ready, note: null } }))[1]).toEqual({ text: 'grouping failed', tone: 'error', title: 'Not logged in' });
  });
});

describe('describeProgress', () => {
  it('shows nothing when nothing runs', () => {
    expect(describeProgress({ indexing: null, embedding: null })).toEqual([]);
  });

  it('shows the running file count while indexing and the embedded share during a pass', () => {
    expect(describeProgress({ indexing: { indexed: 1234 }, embedding: null })).toEqual([
      { text: 'indexing… 1234 files', tone: 'muted', title: 'Reading and parsing source files; the map appears when this finishes' },
    ]);
    expect(describeProgress({ indexing: null, embedding: { done: 640, total: 2879 } })).toEqual([
      { text: 'embedding 640 / 2879 files', tone: 'muted', title: 'Computing file embeddings with the local model; nothing leaves this machine' },
    ]);
  });

  it('counts one file as a file', () => {
    expect(describeProgress({ indexing: { indexed: 1 }, embedding: { done: 0, total: 1 } }).map((chip) => chip.text)).toEqual(['indexing… 1 file', 'embedding 0 / 1 file']);
  });
});
