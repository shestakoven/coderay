import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../layout/Icon';
import { DiffView } from './DiffView';
import { anchorKey, diffKind, firstChangedAnchor, hunkAt, lineTexts, stepHunk, type DiffMode, type LineAnchor } from './diff-rows';
import { anchorComments, type NewComment, type ReviewComment } from './review-comments';
import type { FileState } from './review-flow';
import { focusIsHere, keyOf, typing } from './review-keys';
import { kindOf, type ReviewItem } from './review-model';
import { FilePath } from './ReviewPanel';
import { FileIcon, Kbd, KindBadge, Stat, STATE_LABEL } from './ReviewParts';
import type { DiffResult } from './WatchdogDialog';

const NARROW = 760;

export interface ReviewDiffProps {
  file: ReviewItem;
  state: FileState;
  result: DiffResult | undefined;
  noRequest: boolean;
  onRetry: () => void;
  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
  comments: ReviewComment[];
  draft: { anchor: LineAnchor; text: string } | null;
  onDraft: (path: string, next: { anchor: LineAnchor; text: string } | null) => void;
  onAddComment: (draft: NewComment) => void;
  onEditComment: (id: string, text: string) => void;
  onRemoveComment: (id: string) => void;
  onAccept: () => void;
  onUndo: () => void;
  onRevert: () => void;
  onUndoRevert: () => void;
  onMap: () => void;
  reverting: boolean;
  error: string | null;
  onDismissError: () => void;
  active: boolean;
  children?: ReactNode;
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ReviewDiff({ file, state, result, noRequest, onRetry, mode, onMode, comments, draft, onDraft, onAddComment, onEditComment, onRemoveComment, onAccept, onUndo, onRevert, onUndoRevert, onMap, reverting, error, onDismissError, active, children }: ReviewDiffProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const width = useWidth(scroller);
  const narrow = width > 0 && width < NARROW;
  const [activeHunk, setActiveHunk] = useState(0);
  const composing = draft?.anchor ?? null;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [editing, setEditing] = useState<string | null>(null);
  const pinned = useRef(false);

  const diff = result && !result.error && result.diff && !result.diff.binary && !result.diff.missing ? result.diff : null;
  const hunks = diff?.hunks.length ?? 0;
  const kind = result?.diff?.binary ? 'binary' : diff ? diffKind(diff, file.before, file.after, file.renamedFrom) : kindOf(file);
  const whole = kind === 'new' || kind === 'deleted';
  const shownMode: DiffMode = narrow || whole ? 'unified' : mode;
  const texts = useMemo(() => (diff ? lineTexts(diff) : new Map<string, string>()), [diff]);
  const anchored = useMemo(() => anchorComments(comments, texts), [comments, texts]);

  const toHunk = (index: number): void => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-hunk="${index}"]`);
    if (!root || !target) return;
    pinned.current = true;
    setActiveHunk(index);
    root.scrollTo({ top: target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 1, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const moveHunk = (delta: 1 | -1): void => toHunk(stepHunk(activeHunk, delta, hunks));
  const path = file.path;
  const compose = useCallback((anchor: LineAnchor | null): void => {
    if (!anchor) return;
    const open = draftRef.current;
    if (!open || open.anchor.side !== anchor.side || open.anchor.line !== anchor.line) onDraft(path, { anchor, text: open?.text ?? '' });
  }, [onDraft, path]);

  const unpin = (): void => {
    pinned.current = false;
  };
  const onScroll = (): void => {
    const root = scroller.current;
    if (!root || pinned.current) return;
    const origin = root.getBoundingClientRect().top - root.scrollTop;
    const tops = [...root.querySelectorAll<HTMLElement>('[data-hunk]')].map((element) => element.getBoundingClientRect().top - origin);
    const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2 && root.scrollTop > 0;
    const next = atBottom ? tops.length - 1 : hunkAt(tops, root.scrollTop + root.clientHeight * 0.4);
    setActiveHunk((current) => (current === next ? current : next));
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey || !focusIsHere(scroller.current?.closest('.rv') ?? null, event.target)) return;
      const key = keyOf(event);
      if (key === 'n') moveHunk(1);
      else if (key === 'p') moveHunk(-1);
      else if (key === 'c' && diff) compose(firstChangedAnchor(diff, Math.min(activeHunk, hunks - 1)));
      else if (key === 's') onMode(mode === 'split' ? 'unified' : 'split');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const marked = useMemo(() => new Set(anchored.inline.keys()), [anchored]);
  const threads = useMemo(() => {
    const map = new Map<string, ReactNode>();
    const composingKey = composing ? anchorKey(composing.side, composing.line) : null;
    for (const key of new Set([...anchored.inline.keys(), ...(composingKey ? [composingKey] : [])])) {
      map.set(key, (
        <div className="rv-thread" key={key}>
          {(anchored.inline.get(key) ?? []).map((comment) => (
            editing === comment.id
              ? <Composer key={comment.id} label={`Edit comment on line ${comment.line}`} initial={comment.text} onSave={(text) => { onEditComment(comment.id, text); setEditing(null); }} onCancel={() => setEditing(null)} />
              : <CommentCard key={comment.id} comment={comment} onEdit={() => setEditing(comment.id)} onRemove={() => onRemoveComment(comment.id)} />
          ))}
          {draft && composingKey === key && (
            <Composer
              label={`Comment on line ${draft.anchor.line}${draft.anchor.side === 'old' ? ' (removed)' : ''}`}
              text={draft.text}
              onText={(text) => onDraft(path, { anchor: draft.anchor, text })}
              onSave={(text) => { onAddComment({ path, side: draft.anchor.side, line: draft.anchor.line, quote: draft.anchor.text, text }); onDraft(path, null); }}
              onCancel={() => onDraft(path, null)}
            />
          )}
        </div>
      ));
    }
    return map;
  }, [anchored, composing, draft, editing, path, onDraft, onAddComment, onEditComment, onRemoveComment]);

  const finished = state === 'accepted';
  const reverted = state === 'reverted';
  const rename = file.renamedFrom;

  return (
    <>
      <header className="rv-file-head">
        <div className="rv-file-top">
          <div className="rv-file-title">
            <span className="rv-file-name"><FileIcon path={file.path} /><FilePath path={file.path} /></span>
            <KindBadge kind={kind} long />
            <Stat added={file.added} removed={file.removed} />
            {state !== 'pending' && <span className={`rv-tag ${state}`}>{STATE_LABEL[state]}</span>}
          </div>
          <div className="rv-decide">
            {reverted ? (
              <button className="rv-btn primary" onClick={onUndoRevert}><Icon name="undo" size={14} />Undo revert</button>
            ) : (
              <>
                <button className="rv-btn danger" disabled={reverting} onClick={onRevert} title="Revert this file (r)">{reverting ? 'Reverting…' : 'Revert'}<Kbd>r</Kbd></button>
                {finished
                  ? <button className="rv-btn" onClick={onUndo} title="Take the accept back (u)"><Icon name="undo" size={14} />Undo accept<Kbd>u</Kbd></button>
                  : <button className="rv-btn primary" onClick={onAccept} title="Accept (a)"><Icon name="check" size={14} />Accept<Kbd>a</Kbd></button>}
              </>
            )}
          </div>
        </div>
        {rename && <div className="rv-rename"><Icon name="arrow-up-right" size={12} /> moved from <code>{rename}</code></div>}
        <div className="rv-file-bar">
          {hunks > 0 && (
            <div className="rv-hunks" role="group" aria-label="Hunks">
              <button className="rv-icon" onClick={() => moveHunk(-1)} disabled={activeHunk <= 0} title="Previous hunk (p)" aria-label="Previous hunk"><Icon name="chevron-up" size={15} /></button>
              <span className="rv-hunk-label">Hunk {Math.min(activeHunk, hunks - 1) + 1} / {hunks}</span>
              <button className="rv-icon" onClick={() => moveHunk(1)} disabled={activeHunk >= hunks - 1} title="Next hunk (n)" aria-label="Next hunk"><Icon name="chevron-down" size={15} /></button>
            </div>
          )}
          <div className="rv-mode" role="group" aria-label="Diff layout">
            <button className={shownMode === 'unified' ? 'on' : ''} aria-pressed={shownMode === 'unified'} onClick={() => onMode('unified')} title="Unified"><Icon name="view-unified" size={15} /></button>
            <button className={shownMode === 'split' ? 'on' : ''} aria-pressed={shownMode === 'split'} onClick={() => onMode('split')} disabled={narrow || whole} title={narrow ? 'Split needs a wider pane' : whole ? 'A whole file has nothing to compare side by side' : 'Split (s)'}><Icon name="view-split" size={15} /></button>
          </div>
          <span className="rv-spacer" />
          {diff && <button className="rv-btn ghost" onClick={() => compose(firstChangedAnchor(diff, Math.min(activeHunk, hunks - 1)))} title="Comment on this hunk (c)"><Icon name="comment" size={14} /><span className="rv-label">Comment</span><Kbd>c</Kbd></button>}
          <button className="rv-btn ghost" onClick={onMap} title="Show on the map"><Icon name="map" size={14} /><span className="rv-label">Map</span></button>
        </div>
      </header>
      {error && <div className="rv-error" role="alert"><Icon name="alert" size={14} /><span>{error}</span><button className="rv-icon" onClick={onDismissError} aria-label="Dismiss"><Icon name="close" size={13} /></button></div>}
      {children}
      <div className="rv-diff" ref={scroller} onScroll={onScroll} onWheel={unpin} onPointerDown={unpin} onTouchMove={unpin} onKeyDown={unpin} role="region" aria-label={`Diff of ${file.path}`} tabIndex={0}>
        <Body file={file} result={result} noRequest={noRequest} onRetry={onRetry}>
          {diff && (
            <>
              {anchored.outdated.length > 0 && <Outdated comments={anchored.outdated} onRemove={onRemoveComment} />}
              <DiffView key={`${file.before}:${file.after}`} diff={diff} path={file.path} mode={shownMode} kind={kind === 'binary' ? 'binary' : kind} renamedFrom={rename} marked={marked} threads={threads} onGutter={compose} activeHunk={activeHunk} />
            </>
          )}
        </Body>
      </div>
    </>
  );
}

function Body({ file, result, noRequest, onRetry, children }: { file: ReviewItem; result: DiffResult | undefined; noRequest: boolean; onRetry: () => void; children: ReactNode }) {
  if (noRequest) return <Notice icon="alert" title="Not connected to the core" text="The diff could not be requested. Check the connection in the status bar." action={{ label: 'Try again', run: onRetry }} />;
  if (!result) return <Skeleton rows={Math.min(28, Math.max(8, file.added + file.removed + 4))} />;
  if (result.error) return <Notice icon="alert" title="Could not load the diff" text={result.error} action={{ label: 'Try again', run: onRetry }} />;
  const diff = result.diff;
  if (!diff) return null;
  if (diff.binary) return <Notice icon="file-kind" title="Binary file" text={kindOf(file) === 'new' ? 'The agent added a file that is not text, so there is no diff to read.' : kindOf(file) === 'deleted' ? 'The agent deleted a file that is not text.' : 'This file is not text, so there is no diff to read. Accept or revert it as a whole.'} />;
  if (diff.missing) return <Notice icon="info" title="The saved copy is gone" text="CodeRay no longer holds this version of the file, so it cannot show the diff. Accepting still works." />;
  return <>{children}</>;
}

function Notice({ icon, title, text, action }: { icon: 'alert' | 'info' | 'file-kind'; title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="rv-notice" role={icon === 'alert' ? 'alert' : 'status'}>
      <Icon name={icon} size={22} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action && <button className="rv-btn" onClick={action.run}>{action.label}</button>}
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="rv-skeleton" aria-busy="true" aria-label="Loading the diff">
      {Array.from({ length: rows }, (_, i) => <i key={i} style={{ width: `${28 + ((i * 37) % 55)}%` }} />)}
    </div>
  );
}

function CommentCard({ comment, onEdit, onRemove }: { comment: ReviewComment; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className={`rv-comment${comment.sentAt !== null ? ' sent' : ''}`}>
      <div className="rv-comment-head">
        <Icon name="comment" size={12} />
        <span>Line {comment.line}{comment.side === 'old' ? ' (removed)' : ''}</span>
        {comment.sentAt !== null && <span className="rv-sent">Sent to the agent</span>}
        <span className="rv-spacer" />
        {comment.sentAt === null && <button className="rv-icon" onClick={onEdit} title="Edit the comment" aria-label="Edit the comment"><Icon name="pencil" size={13} /></button>}
        <button className="rv-icon" onClick={onRemove} title="Delete the comment" aria-label="Delete the comment"><Icon name="close" size={13} /></button>
      </div>
      <p>{comment.text}</p>
    </div>
  );
}

function Composer({ label, initial = '', text: controlled, onText, onSave, onCancel }: { label: string; initial?: string; text?: string; onText?: (text: string) => void; onSave: (text: string) => void; onCancel: () => void }) {
  const [own, setOwn] = useState(initial);
  const text = controlled ?? own;
  const setText = onText ?? setOwn;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollIntoView({ block: 'nearest' });
  }, []);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(240, element.scrollHeight)}px`;
  }, [text]);
  const save = (): void => {
    if (text.trim() !== '') onSave(text);
  };
  return (
    <div className="rv-composer">
      <textarea
        ref={field}
        rows={2}
        value={text}
        placeholder="Tell the agent what to change here"
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="rv-composer-bar">
        <span className="rv-composer-hint"><Kbd>esc</Kbd> cancel</span>
        <span className="rv-spacer" />
        <button className="rv-btn" onClick={onCancel}>Cancel</button>
        <button className="rv-btn primary" disabled={text.trim() === ''} onClick={save}>Save comment<Kbd>⌘↵</Kbd></button>
      </div>
    </div>
  );
}

function Outdated({ comments, onRemove }: { comments: ReviewComment[]; onRemove: (id: string) => void }) {
  return (
    <section className="rv-outdated" aria-label="Comments on an earlier version">
      <p><Icon name="info" size={13} />{comments.length} {comments.length === 1 ? 'comment is' : 'comments are'} on lines that changed since you wrote {comments.length === 1 ? 'it' : 'them'}.</p>
      <ul>
        {comments.map((comment) => (
          <li key={comment.id}>
            <span className="rv-outdated-where">Line {comment.line}{comment.quote.trim() ? <code>{comment.quote.trim().slice(0, 60)}</code> : null}</span>
            <span className="rv-outdated-text">{comment.text}</span>
            <button className="rv-icon" onClick={() => onRemove(comment.id)} aria-label="Delete the comment" title="Delete the comment"><Icon name="close" size={13} /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}
