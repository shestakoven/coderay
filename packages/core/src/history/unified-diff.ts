import type { DiffHunk, DiffLine, FileDiff } from '@ide/protocol';

export const MAX_DIFF_LINES = 2000;

export const EMPTY_DIFF: FileDiff = { binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] };

export function parseHunks(text: string): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let lines = 0;
  for (const raw of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    const op: DiffLine['op'] | null = marker === ' ' ? 'context' : marker === '+' ? 'add' : marker === '-' ? 'del' : null;
    if (op === null) continue;
    if (lines === MAX_DIFF_LINES) return { hunks, truncated: true };
    current.lines.push({ op, text: raw.slice(1) });
    lines++;
  }
  return { hunks, truncated: false };
}
