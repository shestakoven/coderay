import { ENGINE_PRODUCT_NAMES, type BackgroundAiStatus, type MapProgress, type MapStatus } from '@ide/protocol';

export type ChipTone = 'ok' | 'muted' | 'warn' | 'error';

export interface StatusChip {
  text: string;
  tone: ChipTone;
  title?: string;
}

const MIB = 1024 * 1024;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeMapStatus(status: MapStatus): StatusChip[] {
  const chips: StatusChip[] = [];
  const ai = status.backgroundAi;
  const engineLines = ai.state === 'ready' ? [`Background AI: ${ENGINE_PRODUCT_NAMES[ai.engine]}`, ai.note ?? ''] : [];
  if (status.layer === 'folder') {
    chips.push({ text: 'folder map', tone: 'muted', title: ['Components are folders until an AI grouping succeeds', ...engineLines].filter(Boolean).join('\n') });
  } else if (status.stale) {
    chips.push({ text: 'AI map · stale', tone: 'warn', title: [...status.staleReasons, placementLine(status), ...engineLines].filter(Boolean).join('\n') });
  } else {
    const title = [status.groupedAt ? `Grouped at ${status.groupedAt}` : '', placementLine(status), ...engineLines].filter(Boolean).join('\n');
    chips.push({ text: 'AI map', tone: 'ok', ...(title ? { title } : {}) });
  }
  // An off chip says why there is no AI map, so no failure or "AI grouping off" stands beside it.
  if (ai.state === 'off') chips.push(offChip(ai));
  if (status.grouping === 'running') chips.push(groupingChip(status));
  if (status.grouping === 'failed' && ai.state !== 'off') chips.push(failedChip(status, ai));
  if (status.grouping === 'too-large' && ai.state !== 'off') {
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

function offChip(ai: Extract<BackgroundAiStatus, { state: 'off' }>): StatusChip {
  if (ai.reason === 'unavailable') return { text: `AI off · ${ai.engine ? ENGINE_PRODUCT_NAMES[ai.engine] : 'engine'} not ready`, tone: 'warn', title: ai.hint };
  return { text: ai.reason === 'none' ? 'AI off · no engine' : 'AI off', tone: 'muted', title: ai.hint };
}

// Any failed call parks its engine and Auto picks again: with a note, the failure was the passed-over engine's, and the next grouping is the ready one's.
function failedChip({ groupingError }: MapStatus, ai: BackgroundAiStatus): StatusChip {
  if (ai.state === 'ready' && ai.note !== null) {
    const engine = ENGINE_PRODUCT_NAMES[ai.engine];
    return { text: `grouping moves to ${engine}`, tone: 'muted', title: `${ai.note}\nThe next grouping runs on ${engine}; Regroup runs it now.` };
  }
  return { text: 'grouping failed', tone: 'error', ...(groupingError ? { title: groupingError } : {}) };
}

function placementLine({ embeddingPlacement }: MapStatus): string {
  if (!embeddingPlacement) return '';
  return `Embedding placement: ${embeddingPlacement.on ? 'on' : 'off'} (${embeddingPlacement.detail})`;
}

function groupingChip({ sending }: MapStatus): StatusChip {
  if (!sending) return { text: 'grouping…', tone: 'muted', title: 'Waiting for embeddings' };
  return {
    text: `grouping… sent ${plural(sending.paths, 'path')}, ${plural(sending.symbols, 'symbol name')}, ${plural(sending.links, 'dependency count')}`,
    tone: 'muted',
    title: 'Grouping files into components',
  };
}

export function describeProgress(progress: MapProgress): StatusChip[] {
  const chips: StatusChip[] = [];
  if (progress.indexing) {
    chips.push({
      text: `indexing… ${plural(progress.indexing.indexed, 'file')}`,
      tone: 'muted',
      title: 'Reading and parsing source files; the map appears when this finishes',
    });
  }
  if (progress.embedding) {
    chips.push({
      text: `embedding ${progress.embedding.done} / ${plural(progress.embedding.total, 'file')}`,
      tone: 'muted',
      title: 'Computing file embeddings with the local model; nothing leaves this machine',
    });
  }
  return chips;
}
