import type { MapProgress, MapStatus } from '@ide/protocol';

export type ChipTone = 'ok' | 'muted' | 'warn' | 'error';

export interface StatusChip {
  text: string;
  tone: ChipTone;
  title?: string;
}

const MIB = 1024 * 1024;

export function describeMapStatus(status: MapStatus): StatusChip[] {
  const chips: StatusChip[] = [];
  if (status.layer === 'folder') {
    chips.push({ text: 'folder map', tone: 'muted', title: 'Components are folders until an AI grouping succeeds' });
  } else if (status.stale) {
    chips.push({ text: 'AI map · stale', tone: 'warn', title: [...status.staleReasons, placementLine(status)].filter(Boolean).join('\n') });
  } else {
    const title = [status.groupedAt ? `Grouped at ${status.groupedAt}` : '', placementLine(status)].filter(Boolean).join('\n');
    chips.push({ text: 'AI map', tone: 'ok', ...(title ? { title } : {}) });
  }
  if (status.grouping === 'running') chips.push(groupingChip(status));
  if (status.grouping === 'failed') {
    chips.push({ text: 'grouping failed', tone: 'error', ...(status.groupingError ? { title: status.groupingError } : {}) });
  }
  if (status.grouping === 'too-large') {
    chips.push({ text: 'AI grouping off', tone: 'muted', ...(status.groupingError ? { title: status.groupingError } : {}) });
  }
  if (status.embeddings === 'downloading') {
    chips.push({ text: `downloading embedding model (${Math.round((status.modelDownloadBytes ?? 0) / MIB)} MB)…`, tone: 'muted' });
  }
  if (status.embeddings === 'unavailable') {
    chips.push({
      text: 'embeddings unavailable',
      tone: 'warn',
      title: `${status.embeddingsError ?? 'Unknown error'}. Grouping uses folder groups, and new files that no rule places stay unassigned.`,
    });
  }
  if (status.pending > 0) chips.push({ text: `${status.pending} waiting for embeddings`, tone: 'muted' });
  if (status.unassigned > 0) chips.push({ text: `${status.unassigned} unassigned`, tone: 'muted' });
  if (status.warnings.length > 0) chips.push({ text: 'map.json warnings', tone: 'warn', title: status.warnings.join('\n') });
  return chips;
}

function placementLine({ embeddingPlacement }: MapStatus): string {
  if (!embeddingPlacement) return '';
  return `Embedding placement: ${embeddingPlacement.on ? 'on' : 'off'} (${embeddingPlacement.detail})`;
}

function groupingChip({ sending }: MapStatus): StatusChip {
  if (!sending) return { text: 'grouping…', tone: 'muted', title: 'Waiting for embeddings before asking Haiku' };
  return {
    text: `grouping… sent ${sending.paths} paths, ${sending.symbols} symbol names, ${sending.links} dependency counts`,
    tone: 'muted',
    title:
      'Haiku receives the project name, file paths, exported symbol names, import counts between groups, and the names and summaries of previous components. File contents are never sent.',
  };
}

export function describeProgress(progress: MapProgress): StatusChip[] {
  const chips: StatusChip[] = [];
  if (progress.indexing) {
    chips.push({
      text: `indexing… ${progress.indexing.indexed} files`,
      tone: 'muted',
      title: 'Reading and parsing source files; the map appears when this finishes',
    });
  }
  if (progress.embedding) {
    chips.push({
      text: `embedding ${progress.embedding.done} / ${progress.embedding.total} files`,
      tone: 'muted',
      title: 'Computing file embeddings with the local model; nothing leaves this machine',
    });
  }
  return chips;
}
