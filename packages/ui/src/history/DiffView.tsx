import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiff } from '@ide/protocol';
import './review.css';
import { anchorKey, blocksOf, foldOf, FOLD_STEP, limitRows, splitRows, type Block, type DiffMode, type FileKind, type LineAnchor, type Row } from './diff-rows';

export interface DiffViewProps {
  diff: FileDiff;
  path: string;
  mode?: DiffMode;
  kind?: FileKind;
  renamedFrom?: string | null;
  // Anchors (old:N / new:N) that carry a comment, and what to show under their line.
  marked?: ReadonlySet<string>;
  threads?: ReadonlyMap<string, ReactNode>;
  onGutter?: (anchor: LineAnchor) => void;
  activeHunk?: number;
}

const MARK = { add: '+', del: '−', context: '' } as const;
const CHUNK = 60;
const ROW_PX = 19.4;
const EAGER_CHUNKS = 2;

function renderText(row: Row): ReactNode {
  if (!row.classes && !row.segments) return row.text === '' ? ' ' : row.text;
  const changed = row.segments ? row.segments.flatMap((part) => Array.from({ length: part.text.length }, () => part.changed)) : [];
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

interface GutterProps {
  side: 'old' | 'new';
  row: Row;
  marked: boolean;
  onGutter?: (anchor: LineAnchor) => void;
}

function Gutter({ side, row, marked, onGutter }: GutterProps) {
  const line = side === 'old' ? row.oldNo : row.newNo;
  if (line === null) return <span className="diff-no" />;
  // A comment sits on an added or unchanged line by its new number, or on a removed line by its old number.
  if (!onGutter || (side === 'old' && row.op !== 'del')) return <span className="diff-no">{line}</span>;
  return (
    <button
      className={`diff-no commentable${marked ? ' marked' : ''}`}
      tabIndex={-1}
      title={`Comment on line ${line}${side === 'old' ? ' (removed)' : ''}`}
      aria-label={`Comment on line ${line}${side === 'old' ? ', removed' : ''}`}
      onClick={() => onGutter({ side, line, text: row.text })}
    >
      <span className="num">{line}</span>
      <span className="plus" aria-hidden="true">+</span>
    </button>
  );
}

const UnifiedRow = memo(function UnifiedRow({ row, oldMarked, newMarked, onGutter }: { row: Row; oldMarked: boolean; newMarked: boolean; onGutter?: (anchor: LineAnchor) => void }) {
  return (
    <div className={`diff-row ${row.op}`}>
      <Gutter side="old" row={row} marked={oldMarked} onGutter={onGutter} />
      <Gutter side="new" row={row} marked={newMarked} onGutter={onGutter} />
      <span className="diff-mark">{MARK[row.op]}</span>
      <span className="diff-text">{renderText(row)}</span>
    </div>
  );
});

function Cell({ row, side, marked, onGutter }: { row: Row | null; side: 'old' | 'new'; marked: boolean; onGutter?: (anchor: LineAnchor) => void }) {
  if (!row) return <div className="diff-cell blank" />;
  return (
    <div className={`diff-cell ${row.op}`}>
      <Gutter side={side} row={row} marked={marked} onGutter={onGutter} />
      <span className="diff-mark">{MARK[row.op]}</span>
      <span className="diff-text">{renderText(row)}</span>
    </div>
  );
}

const SplitRowView = memo(function SplitRowView({ left, right, leftMarked, rightMarked, onGutter }: { left: Row | null; right: Row | null; leftMarked: boolean; rightMarked: boolean; onGutter?: (anchor: LineAnchor) => void }) {
  return (
    <div className="diff-split-row">
      <Cell row={left} side="old" marked={leftMarked} onGutter={onGutter} />
      <Cell row={right} side="new" marked={rightMarked} onGutter={onGutter} />
    </div>
  );
});

// A long run of rows is cut into chunks that only build their DOM when they come near the scroll viewport.
function Chunk({ rows, eager, children }: { rows: number; eager: boolean; children: () => ReactNode }) {
  const [built, setBuilt] = useState(eager);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (built || !element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setBuilt(true);
      observer.disconnect();
    }, { root: element.closest('.rv-diff'), rootMargin: '1600px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [built]);
  if (eager && rows < CHUNK) return <>{children()}</>;
  return <div ref={box} className="diff-chunk" style={built ? { containIntrinsicSize: `auto ${Math.round(rows * ROW_PX)}px` } : { height: Math.round(rows * ROW_PX) }}>{built ? children() : null}</div>;
}

const chunks = <T,>(items: T[]): T[][] => (items.length <= CHUNK * 2 ? [items] : Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK)));

export function DiffView({ diff, path, mode = 'unified', kind = 'modified', renamedFrom = null, marked, threads, onGutter, activeHunk }: DiffViewProps) {
  const blocks = useMemo(() => blocksOf(diff, path), [diff, path]);
  const [limit, setLimit] = useState(0);
  const fold = foldOf(kind, blocks, limit);
  const shown = useMemo(() => (fold ? limitRows(blocks, fold.visible) : blocks), [blocks, fold?.visible]);
  const isMarked = (side: 'old' | 'new', line: number | null): boolean => line !== null && marked?.has(anchorKey(side, line)) === true;
  const thread = (anchor: Row | null, side: 'old' | 'new'): ReactNode => {
    const line = side === 'old' ? anchor?.oldNo : anchor?.newNo;
    return line == null ? null : threads?.get(anchorKey(side, line)) ?? null;
  };

  if (blocks.length === 0) {
    return (
      <div className="diff-view bare" data-kind={kind}>
        <p className="diff-note">{renamedFrom ? <>Moved from <code>{renamedFrom}</code>. The content did not change.</> : 'No textual changes.'}</p>
      </div>
    );
  }

  return (
    <div className={`diff-view ${mode}`} data-kind={kind}>
      {shown.map((block) => (
        <HunkBlock key={`${block.oldStart}:${block.newStart}`} block={block} count={blocks.length} active={activeHunk === block.index} mode={mode}>
          {mode === 'split'
            ? chunks(splitRows(block.rows)).map((group, g) => (
              <Chunk key={g} rows={group.length} eager={g < EAGER_CHUNKS || group.length < CHUNK}>
                {() => group.map((pair, i) => (
                  <Fragment key={i}>
                    <SplitRowView left={pair.left} right={pair.right} leftMarked={isMarked('old', pair.left?.oldNo ?? null)} rightMarked={isMarked('new', pair.right?.newNo ?? null)} onGutter={onGutter} />
                    {thread(pair.left, 'old')}
                    {thread(pair.right, 'new')}
                  </Fragment>
                ))}
              </Chunk>
            ))
            : chunks(block.rows).map((group, g) => (
              <Chunk key={g} rows={group.length} eager={g < EAGER_CHUNKS || group.length < CHUNK}>
                {() => group.map((row, i) => (
                  <Fragment key={i}>
                    <UnifiedRow row={row} oldMarked={isMarked('old', row.oldNo)} newMarked={isMarked('new', row.newNo)} onGutter={onGutter} />
                    {thread(row, 'old')}
                    {thread(row, 'new')}
                  </Fragment>
                ))}
              </Chunk>
            ))}
        </HunkBlock>
      ))}
      {fold && fold.hidden > 0 && (
        <div className="diff-fold">
          <span>{fold.hidden.toLocaleString()} more {kind === 'new' ? 'added' : 'deleted'} lines are hidden</span>
          <button onClick={() => setLimit(fold.visible + FOLD_STEP)}>Show {Math.min(FOLD_STEP, fold.hidden).toLocaleString()} more</button>
          <button onClick={() => setLimit(fold.total)}>Show all {fold.total.toLocaleString()} lines</button>
        </div>
      )}
      {diff.truncated && <div className="diff-fold"><span>The diff is cut here: the file is too large to show in full.</span></div>}
    </div>
  );
}

function HunkBlock({ block, count, active, mode, children }: { block: Block; count: number; active: boolean; mode: DiffMode; children: ReactNode }) {
  return (
    <section className={`diff-hunk${active ? ' active' : ''}`} data-hunk={block.index} aria-label={`Hunk ${block.index + 1} of ${count}`}>
      <div className="diff-hunk-head">
        {count > 1 && <span className="diff-hunk-no">{block.index + 1}/{count}</span>}
        <span className="diff-hunk-range">{block.header}</span>
        <span className="review-stat">{block.added > 0 && <span className="add">+{block.added}</span>} {block.removed > 0 && <span className="del">−{block.removed}</span>}</span>
      </div>
      <div className={`diff-body ${mode}`}>{children}</div>
    </section>
  );
}
