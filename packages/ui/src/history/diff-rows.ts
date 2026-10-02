import type { DiffHunk, FileDiff } from '@ide/protocol';
import { tokenClasses } from './highlight';
import { wordDiff, type Segment } from './word-diff';

export type DiffMode = 'unified' | 'split';
export type Side = 'old' | 'new';

export interface Row {
  op: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
  segments?: Segment[];
  classes?: (string | null)[];
  // On a removed line: the added line it was matched with for word-level marks.
  pair?: Row;
}

export interface SplitRow {
  left: Row | null;
  right: Row | null;
}

export interface Block {
  index: number;
  header: string;
  oldStart: number;
  newStart: number;
  rows: Row[];
  added: number;
  removed: number;
}

export type FileKind = 'new' | 'deleted' | 'modified' | 'binary' | 'renamed';

export interface LineAnchor {
  side: Side;
  line: number;
  text: string;
}

export const anchorKey = (side: Side, line: number): string => `${side}:${line}`;

// A removed line is addressed by its old number; everything else by its new number.
export function anchorsOf(row: Row): LineAnchor[] {
  const anchors: LineAnchor[] = [];
  if (row.oldNo !== null) anchors.push({ side: 'old', line: row.oldNo, text: row.text });
  if (row.newNo !== null) anchors.push({ side: 'new', line: row.newNo, text: row.text });
  return anchors;
}

export const primaryAnchor = (row: Row): LineAnchor => (row.op === 'del' ? { side: 'old', line: row.oldNo!, text: row.text } : { side: 'new', line: row.newNo!, text: row.text });

export function rowsOf(hunk: DiffHunk): Row[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line): Row => {
    if (line.op === 'del') return { op: 'del', oldNo: oldNo++, newNo: null, text: line.text };
    if (line.op === 'add') return { op: 'add', oldNo: null, newNo: newNo++, text: line.text };
    return { op: 'context', oldNo: oldNo++, newNo: newNo++, text: line.text };
  });
}

const MIN_SIMILARITY = 0.5;
const LOOKAHEAD = 3;

const similarity = (segments: Segment[]): number => {
  const total = segments.reduce((sum, part) => sum + part.text.length, 0);
  return total === 0 ? 0 : segments.filter((part) => !part.changed).reduce((sum, part) => sum + part.text.length, 0) / total;
};

// A run of deleted lines followed by added lines: each deleted line is paired, in order, with the
// most similar added line nearby; only similar pairs get word-level marks, a rewritten line stays plain.
export function markPairs(rows: Row[]): void {
  for (let start = 0; start < rows.length; start++) {
    if (rows[start]!.op !== 'del') continue;
    let mid = start;
    while (mid < rows.length && rows[mid]!.op === 'del') mid++;
    let end = mid;
    while (end < rows.length && rows[end]!.op === 'add') end++;
    let next = mid;
    for (let del = start; del < mid && next < end; del++) {
      let best: { at: number; pair: NonNullable<ReturnType<typeof wordDiff>>; score: number } | null = null;
      for (let add = next; add < Math.min(end, next + LOOKAHEAD); add++) {
        const pair = wordDiff(rows[del]!.text, rows[add]!.text);
        const score = pair ? Math.min(similarity(pair.before), similarity(pair.after)) : 0;
        if (pair && score >= MIN_SIMILARITY && (!best || score > best.score)) best = { at: add, pair, score };
      }
      if (!best) continue;
      rows[del]!.segments = best.pair.before;
      rows[del]!.pair = rows[best.at]!;
      rows[best.at]!.segments = best.pair.after;
      next = best.at + 1;
    }
    start = end - 1;
  }
}

// highlight.js refuses long inputs, so a long side is highlighted in slices of lines. It also slows down badly on one
// very long line (a minified bundle), so such a line stays plain rather than freezing the review.
const SLICE_CHARS = 12_000;
const LONG_LINE = 3_000;

function sliceClasses(path: string, texts: string[]): ((string | null)[] | undefined)[] | null {
  const out: ((string | null)[] | undefined)[] = [];
  let from = 0;
  while (from < texts.length) {
    let to = from;
    let chars = 0;
    while (to < texts.length && (to === from || chars + texts[to]!.length + 1 <= SLICE_CHARS)) chars += texts[to++]!.length + 1;
    if (to - from === 1 && texts[from]!.length > LONG_LINE) {
      out.push(undefined);
      from = to;
      continue;
    }
    const classes = tokenClasses(path, texts.slice(from, to).join('\n'));
    if (!classes) return null;
    let at = 0;
    for (let i = from; i < to; i++) {
      out.push(classes.slice(at, at + texts[i]!.length));
      at += texts[i]!.length + 1;
    }
    from = to;
  }
  return out;
}

// Highlighting each side of the hunk as one block keeps multi-line comments and strings intact.
export function colorRows(path: string, rows: Row[]): void {
  const side = (keep: (row: Row) => boolean): void => {
    const picked = rows.filter(keep);
    const classes = sliceClasses(path, picked.map((row) => row.text));
    if (!classes) return;
    picked.forEach((row, i) => { row.classes = classes[i]; });
  };
  side((row) => row.op !== 'add');
  const oldClasses = new Map(rows.filter((row) => row.classes).map((row) => [row, row.classes]));
  side((row) => row.op !== 'del');
  for (const row of rows) if (row.op === 'del') row.classes = oldClasses.get(row);
}

export function blocksOf(diff: FileDiff, path: string): Block[] {
  return diff.hunks.map((hunk, index) => {
    const rows = rowsOf(hunk);
    markPairs(rows);
    colorRows(path, rows);
    return {
      index,
      header: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows,
      added: rows.filter((row) => row.op === 'add').length,
      removed: rows.filter((row) => row.op === 'del').length,
    };
  });
}

// Deleted lines face the added lines that replace them, side by side; a surplus on either side faces an empty cell.
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!;
    if (row.op === 'context') {
      out.push({ left: row, right: row });
      i++;
      continue;
    }
    const dels: Row[] = [];
    const adds: Row[] = [];
    while (i < rows.length && rows[i]!.op === 'del') dels.push(rows[i++]!);
    while (i < rows.length && rows[i]!.op === 'add') adds.push(rows[i++]!);
    const claimed = new Set(dels.flatMap((del) => (del.pair ? [del.pair] : [])));
    let next = 0;
    for (const del of dels) {
      const at = del.pair ? adds.indexOf(del.pair) : -1;
      if (at >= next) {
        while (next < at) out.push({ left: null, right: adds[next++]! });
        out.push({ left: del, right: adds[next++]! });
      } else if (next < adds.length && !claimed.has(adds[next]!)) out.push({ left: del, right: adds[next++]! });
      else out.push({ left: del, right: null });
    }
    while (next < adds.length) out.push({ left: null, right: adds[next++]! });
  }
  return out;
}

export function diffKind(diff: FileDiff, before: string | null, after: string | null, renamedFrom?: string | null): FileKind {
  if (diff.binary) return 'binary';
  if (renamedFrom) return 'renamed';
  if (before === null && after !== null) return 'new';
  if (after === null && before !== null) return 'deleted';
  return 'modified';
}

export const FOLD_AFTER = 300;
export const FOLD_STEP = 500;

export interface Fold {
  visible: number;
  hidden: number;
  total: number;
}

// Whole added or deleted files are folded after a screenful: nobody reviews 2,400 generated lines line by line.
export function foldOf(kind: FileKind, blocks: Block[], limit: number): Fold | null {
  if (kind !== 'new' && kind !== 'deleted') return null;
  const total = blocks.reduce((sum, block) => sum + block.rows.length, 0);
  if (total <= FOLD_AFTER + FOLD_STEP / 2) return null;
  const visible = Math.min(total, Math.max(limit, FOLD_AFTER));
  return { visible, hidden: total - visible, total };
}

export function limitRows(blocks: Block[], visible: number): Block[] {
  let left = visible;
  const out: Block[] = [];
  for (const block of blocks) {
    if (left <= 0) break;
    out.push(left >= block.rows.length ? block : { ...block, rows: block.rows.slice(0, left) });
    left -= block.rows.length;
  }
  return out;
}

export const firstChanged = (block: Block): Row | null => block.rows.find((row) => row.op !== 'context') ?? block.rows[0] ?? null;

// The hunk whose top is the last one at or above `offset`; the first hunk before any is reached.
export function hunkAt(tops: number[], offset: number): number {
  let found = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i]! <= offset) found = i;
  return found;
}

export const stepHunk = (current: number, delta: 1 | -1, count: number): number => (count === 0 ? 0 : Math.min(count - 1, Math.max(0, current + delta)));

// anchorKey -> the text of that line, for every line of the diff that can carry a comment.
export function lineTexts(diff: FileDiff): Map<string, string> {
  const texts = new Map<string, string>();
  for (const hunk of diff.hunks) {
    for (const row of rowsOf(hunk)) {
      if (row.oldNo !== null) texts.set(anchorKey('old', row.oldNo), row.text);
      if (row.newNo !== null) texts.set(anchorKey('new', row.newNo), row.text);
    }
  }
  return texts;
}

// Where `c` starts a comment: the first line of the hunk that actually changed.
export function firstChangedAnchor(diff: FileDiff, hunkIndex: number): LineAnchor | null {
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) return null;
  const rows = rowsOf(hunk);
  const row = rows.find((candidate) => candidate.op !== 'context') ?? rows[0];
  return row ? primaryAnchor(row) : null;
}
