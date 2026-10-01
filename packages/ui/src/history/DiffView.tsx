import type { ReactNode } from 'react';
import type { DiffHunk, FileDiff } from '@ide/protocol';
import { tokenClasses } from './highlight';
import { wordDiff, type Segment } from './word-diff';

interface Row {
  op: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
  segments?: Segment[];
  classes?: (string | null)[];
}

function rowsOf(hunk: DiffHunk): Row[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
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
function markPairs(rows: Row[]): void {
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
      rows[best.at]!.segments = best.pair.after;
      next = best.at + 1;
    }
    start = end - 1;
  }
}

// Highlighting each side of the hunk as one block keeps multi-line comments and strings intact.
function colorRows(path: string, rows: Row[]): void {
  const side = (keep: (row: Row) => boolean): void => {
    const picked = rows.filter(keep);
    const classes = tokenClasses(path, picked.map((row) => row.text).join('\n'));
    if (!classes) return;
    let at = 0;
    for (const row of picked) {
      row.classes = classes.slice(at, at + row.text.length);
      at += row.text.length + 1;
    }
  };
  side((row) => row.op !== 'add');
  const oldClasses = new Map(rows.filter((row) => row.classes).map((row) => [row, row.classes]));
  side((row) => row.op !== 'del');
  for (const row of rows) if (row.op === 'del') row.classes = oldClasses.get(row);
}

function changedMask(row: Row): boolean[] {
  if (!row.segments) return [];
  return row.segments.flatMap((part) => Array.from({ length: part.text.length }, () => part.changed));
}

function renderRow(row: Row): ReactNode {
  if (!row.classes && !row.segments) return row.text;
  const changed = changedMask(row);
  const pieces: ReactNode[] = [];
  let from = 0;
  for (let i = 1; i <= row.text.length; i++) {
    const boundary = i === row.text.length || row.classes?.[i] !== row.classes?.[from] || changed[i] !== changed[from];
    if (!boundary) continue;
    const text = row.text.slice(from, i);
    const cls = row.classes?.[from] ?? undefined;
    const node = cls ? <span className={cls}>{text}</span> : text;
    pieces.push(changed[from] ? <mark key={from}>{node}</mark> : <span key={from}>{node}</span>);
    from = i;
  }
  return pieces;
}

const MARK = { add: '+', del: '−', context: '' } as const;

export function DiffView({ diff, path }: { diff: FileDiff; path: string }) {
  return (
    <div className="diff-view">
      {diff.hunks.map((hunk) => {
        const rows = rowsOf(hunk);
        markPairs(rows);
        colorRows(path, rows);
        return (
          <div key={`${hunk.oldStart}:${hunk.newStart}`} className="diff-hunk">
            <div className="diff-hunk-head">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
            {rows.map((row, i) => (
              <div key={i} className={`diff-row ${row.op}`}>
                <span className="diff-no">{row.oldNo}</span>
                <span className="diff-no">{row.newNo}</span>
                <span className="diff-mark">{MARK[row.op]}</span>
                <span className="diff-text">{renderRow(row)}</span>
              </div>
            ))}
          </div>
        );
      })}
      {diff.truncated && <div className="diff-hunk-head">… truncated</div>}
    </div>
  );
}
