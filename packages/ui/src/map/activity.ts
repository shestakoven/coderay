import type { MapProgress, MapStatus } from '@ide/protocol';

export type ActivityKey = 'indexing' | 'embedding' | 'model' | 'grouping';

export interface Activity {
  key: ActivityKey;
  label: string;
  detail: string | null;
  fraction: number | null;
}

const MIB = 1024 * 1024;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function mapActivities(progress: MapProgress, status: MapStatus | null): Activity[] {
  const list: Activity[] = [];
  if (progress.indexing) {
    list.push({ key: 'indexing', label: 'Indexing source files', detail: `${plural(progress.indexing.indexed, 'file')} read`, fraction: null });
  }
  if (status?.embeddings === 'downloading') {
    list.push({ key: 'model', label: 'Downloading the local embedding model', detail: `${Math.round((status.modelDownloadBytes ?? 0) / MIB)} MB`, fraction: null });
  }
  if (progress.embedding) {
    const { done, total } = progress.embedding;
    list.push({ key: 'embedding', label: 'Computing file embeddings', detail: `${done} / ${plural(total, 'file')}`, fraction: total > 0 ? Math.min(1, Math.max(0, done / total)) : null });
  }
  if (status?.grouping === 'running') {
    const sending = status.sending;
    list.push({
      key: 'grouping',
      label: 'Grouping files into components with Haiku',
      detail: sending
        ? `Sent ${plural(sending.paths, 'path')}, ${plural(sending.symbols, 'symbol name')}, ${plural(sending.links, 'dependency count')}. File contents are never sent.`
        : 'Waiting for embeddings before asking Haiku',
      fraction: null,
    });
  }
  return list;
}

export function elapsedText(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
