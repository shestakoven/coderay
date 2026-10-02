import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ChatItem, ClientMessage, HistoryView, PlanView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Resizer } from '../layout/Resizer';
import type { DiffMode, LineAnchor } from './diff-rows';
import { addComment, dropFor, editComment, filesWith, formatRequest, loadComments, markSent, removeComment, saveComments, unsent, type NewComment, type ReviewComment } from './review-comments';
import { contextOf } from './review-context';
import { acceptFiles, fileState, isOpen, nextOpen, requestChanges, step, tally as tallyOf, undoAccept, type Decisions, type FileState, type Position } from './review-flow';
import { focusIsHere, keyOf, typing } from './review-keys';
import { filterSections, type ListFilter } from './review-list';
import { reviewSections, sectionFiles, type ReviewItem, type ReviewSection } from './review-model';
import { loadReviewed, saveReviewed } from './review-progress';
import { clampListWidth, LIST_WIDTH, loadPrefs, loadRequested, savePrefs, saveRequested, type ReviewPrefs } from './review-store';
import { ConfirmRevert, ShortcutHelp } from './ReviewDialogs';
import { ReviewContextStrip } from './ReviewContextStrip';
import { ReviewDiff } from './ReviewDiff';
import { ReviewFinish } from './ReviewFinish';
import { ReviewList } from './ReviewList';
import { Kbd } from './ReviewParts';
import type { DiffResult } from './WatchdogDialog';

interface Props {
  history: HistoryView;
  plans: PlanView[];
  results: Record<string, DiffResult | undefined>;
  chatItems: Record<string, ChatItem | undefined>;
  requestDiff: (path: string, before: string | null, after: string | null) => string | null;
  send: (message: ClientMessage) => boolean;
  root: string;
  onShowOnMap: (paths: string[]) => void;
  onShowInChat: (toolUseId: string) => void;
  onExit: () => void;
}

interface Toast {
  id: number;
  text: string;
  undo?: () => void;
}

const COMPACT = 720;
const PREFETCH = 2;
const diffKey = (file: ReviewItem): string => `${file.path}:${file.before}:${file.after}`;

export function ReviewMode({ history, plans, results, chatItems, requestDiff, send, root, onShowOnMap, onShowInChat, onExit }: Props) {
  const sections = useMemo(() => reviewSections(history, plans), [history, plans]);
  const [decisions, setDecisions] = useState<Decisions>(() => ({ reviewed: loadReviewed(window.localStorage, root), requested: loadRequested(window.localStorage, root) }));
  const [comments, setComments] = useState<ReviewComment[]>(() => loadComments(window.localStorage, root));
  const [prefs, setPrefs] = useState<ReviewPrefs>(() => loadPrefs(window.localStorage));
  const [selected, setSelected] = useState<Position | null>(null);
  const [filter, setFilter] = useState<ListFilter>({ query: '', onlyPending: false });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  const [help, setHelp] = useState(false);
  const [ops, setOps] = useState<{ requestId: string; kind: 'revert' | 'undo'; path: string; at: number }[]>([]);
  const [watch, setWatch] = useState<{ path: string; since: number }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { anchor: LineAnchor; text: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [width, setWidth] = useState(0);
  const [, rerender] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const requests = useRef<Record<string, string | null>>({});
  const accepted = useRef<string[][]>([]);
  const initialized = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => saveReviewed(window.localStorage, root, decisions.reviewed), [root, decisions.reviewed]);
  useEffect(() => saveRequested(window.localStorage, root, decisions.requested), [root, decisions.requested]);
  useEffect(() => saveComments(window.localStorage, root, comments), [root, comments]);
  useEffect(() => savePrefs(window.localStorage, prefs), [prefs]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const compact = width > 0 && width < COMPACT;
  const listWidth = width > 0 && !compact ? Math.min(prefs.listWidth, Math.max(LIST_WIDTH.min, width - 380)) : prefs.listWidth;

  const files = useMemo(() => sectionFiles(sections), [sections]);
  const latest = useRef({ files, sections });
  latest.current = { files, sections };
  const tally = useMemo(() => tallyOf(sections, decisions), [sections, decisions]);
  const totals = useMemo(() => Object.fromEntries(sections.map((section) => {
    const decided = section.files.filter((file) => !isOpen(fileState(decisions.reviewed, decisions.requested, file))).length;
    return [section.key, { decided, total: section.files.length }];
  })), [sections, decisions]);
  const visible = useMemo(() => filterSections(sections, filter, decisions), [sections, filter, decisions]);
  const navigable = useMemo<ReviewSection[]>(() => visible.map((section) => (collapsed[section.key] ? { ...section, files: [] } : section)), [visible, collapsed]);

  const current = useMemo(() => {
    const section = sections.find((entry) => entry.key === selected?.group);
    const file = section?.files.find((entry) => entry.path === selected?.path);
    return section && file ? { section, file } : null;
  }, [sections, selected]);
  const state: FileState | null = current ? fileState(decisions.reviewed, decisions.requested, current.file) : null;

  useEffect(() => {
    if (current) return;
    if (selected !== null) setSelected(nextOpen(sections, decisions, selected));
    else if (!initialized.current && sections.length > 0) setSelected(nextOpen(sections, decisions, null) ?? step(sections, null, 1));
    initialized.current = initialized.current || sections.length > 0;
  }, [current, sections, decisions, selected]);

  const ensure = useCallback((file: ReviewItem): void => {
    const key = diffKey(file);
    if (key in requests.current) return;
    requests.current[key] = requestDiff(file.path, file.before, file.after);
    rerender((count) => count + 1);
  }, [requestDiff]);
  useEffect(() => {
    if (!current) return;
    ensure(current.file);
    const rows = sectionFiles(navigable);
    const at = rows.findIndex((file) => file.path === current.file.path);
    for (const file of at < 0 ? [] : rows.slice(Math.max(0, at - 1), at + 1 + PREFETCH)) ensure(file);
  }, [current, navigable, ensure]);
  const retry = (file: ReviewItem): void => {
    delete requests.current[diffKey(file)];
    ensure(file);
  };

  useEffect(() => {
    const done = ops.filter((op) => results[op.requestId] !== undefined);
    if (done.length === 0) return;
    setOps((existing) => existing.filter((op) => !done.includes(op)));
    for (const op of done) {
      const failure = results[op.requestId]?.error ?? null;
      if (failure) setError(failure);
      else if (op.kind === 'revert') setWatch((existing) => [...existing, { path: op.path, since: op.at }]);
      else announce(`Revert undone for ${op.path}`);
    }
  }, [results, ops]);

  // The core answers a revert before the record shows up in the history; the record says whether the file was really restored.
  useEffect(() => {
    if (watch.length === 0) return;
    const settled: typeof watch = [];
    for (const entry of watch) {
      const record = history.reverts.filter((candidate) => candidate.kind === 'review' && candidate.ts >= entry.since - 5000 && candidate.files.some((file) => file.path === entry.path)).at(-1);
      const outcome = record?.files.find((file) => file.path === entry.path);
      if (!outcome) continue;
      settled.push(entry);
      if (outcome.outcome === 'conflict' || outcome.outcome === 'not-rolled-back') setError(`${entry.path} was not reverted${outcome.reason ? `: ${outcome.reason}` : ''}.`);
      else notify(`Reverted ${entry.path}`, `Reverted ${entry.path}`, () => undoRevert(entry.path));
    }
    if (settled.length > 0) setWatch((existing) => existing.filter((entry) => !settled.includes(entry)));
  }, [history.reverts, watch]);

  const announce = (text: string): void => setAnnouncement((previous) => (previous === text ? `${text} ` : text));
  const notify = (text: string, spoken: string = text, undo?: () => void): void => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, undo });
    announce(spoken);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  // The next file that still needs a decision and is on screen (filter, collapsed groups), in list order after `from`.
  const pickNext = (next: Decisions, from: Position | null): Position | null => {
    const shown = new Set(sectionFiles(filterSections(sections, filter, next).filter((section) => !collapsed[section.key])).map((file) => file.path));
    const rows = sections.flatMap((section) => section.files.map((file) => ({ position: { group: section.key, path: file.path }, file })));
    const start = from ? rows.findIndex((row) => row.position.group === from.group && row.position.path === from.path) : -1;
    for (let at = 1; at <= rows.length; at++) {
      const row = rows[(start + at + rows.length) % rows.length]!;
      if (isOpen(fileState(next.reviewed, next.requested, row.file)) && shown.has(row.file.path)) return row.position;
    }
    return nextOpen(sections, next, from);
  };
  const commit = (next: Decisions, from: Position | null, moveOn: boolean): void => {
    setDecisions(next);
    if (moveOn || nextOpen(sections, next, null) === null) setSelected(pickNext(next, from));
  };
  const accept = (targets: ReviewItem[], moveOn: boolean): void => {
    const open = targets.filter((file) => fileState(decisions.reviewed, decisions.requested, file) !== 'accepted' && !file.reverted);
    if (open.length === 0) return;
    commit(acceptFiles(decisions, open), selected, moveOn);
    const withUnsent = new Set(unsent(comments).map((comment) => comment.path));
    setComments((existing) => dropFor(existing, open.map((file) => file.path).filter((path) => !withUnsent.has(path))));
    accepted.current.push(open.map((file) => file.path));
    const kept = open.filter((file) => withUnsent.has(file.path)).length;
    const text = `${open.length === 1 ? `Accepted ${open[0]!.path}` : `Accepted ${open.length} files`}${kept > 0 ? `. ${kept === 1 ? 'It still has' : 'Some still have'} comments you have not sent` : ''}`;
    notify(text, `${text}. ${tally.accepted + open.length} of ${tally.total} accepted.`, () => unaccept(open));
  };
  const unaccept = (targets: ReviewItem[]): void => {
    setDecisions((existing) => undoAccept(existing, targets));
    accepted.current = accepted.current.map((paths) => paths.filter((path) => !targets.some((file) => file.path === path))).filter((paths) => paths.length > 0);
    const first = targets[0];
    if (first) setSelected(latest.current.sections.flatMap((section) => section.files.map((file) => ({ group: section.key, path: file.path }))).find((position) => position.path === first.path) ?? null);
    announce(targets.length === 1 ? `Accept undone for ${targets[0]!.path}` : `Accept undone for ${targets.length} files`);
    setToast(null);
  };
  const undoLast = (): void => {
    if (current && state === 'accepted') return unaccept([current.file]);
    const lastPaths = [...accepted.current].reverse().find((paths) => paths.some((path) => files.some((file) => file.path === path && fileState(decisions.reviewed, decisions.requested, file) === 'accepted')));
    if (!lastPaths) return;
    unaccept(files.filter((file) => lastPaths.includes(file.path) && fileState(decisions.reviewed, decisions.requested, file) === 'accepted'));
  };
  const undoRevert = (path: string): void => {
    const file = latest.current.files.find((entry) => entry.path === path);
    if (!file?.revertId) return;
    setError(null);
    const requestId = crypto.randomUUID();
    if (!send({ type: 'revert.undo', requestId, revertId: file.revertId })) setError('Not connected to the core.');
    else {
      setOps((existing) => [...existing, { requestId, kind: 'undo', path, at: Date.now() }]);
      setToast(null);
    }
  };
  const revert = (): void => {
    if (!current) return;
    const requestId = crypto.randomUUID();
    setConfirming(false);
    setError(null);
    if (send({ type: 'change.revert', requestId, changeIds: current.file.ids })) {
      setOps((existing) => [...existing, { requestId, kind: 'revert', path: current.file.path, at: Date.now() }]);
      setSelected(pickNext(decisions, selected) ?? selected);
    } else setError('Not connected to the core.');
  };
  const onMark = (file: ReviewItem, markState: FileState): void => {
    if (markState === 'accepted') unaccept([file]);
    else if (markState === 'reverted') undoRevert(file.path);
    else if (markState === 'requested') setDecisions((existing) => ({ ...existing, requested: Object.fromEntries(Object.entries(existing.requested).filter(([path]) => path !== file.path)) }));
    else accept([file], false);
  };

  const pending = useMemo(() => unsent(comments).filter((comment) => files.some((file) => file.path === comment.path && !file.reverted)), [comments, files]);
  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of pending) counts[comment.path] = (counts[comment.path] ?? 0) + 1;
    return counts;
  }, [pending]);
  const requestFixes = (): void => {
    if (pending.length === 0) return;
    const text = formatRequest(pending);
    if (!send({ type: 'chat.send', text })) {
      setError('The review message could not be sent. It is too long, or the core is not connected.');
      return;
    }
    const paths = filesWith(pending);
    setError(null);
    setComments((existing) => markSent(existing, pending.map((comment) => comment.id), Date.now()));
    setDecisions((existing) => requestChanges(existing, files.filter((file) => paths.includes(file.path))));
    const text2 = `Sent ${pending.length} ${pending.length === 1 ? 'comment' : 'comments'} on ${paths.length} ${paths.length === 1 ? 'file' : 'files'} to the agent`;
    notify(text2);
    if (current && paths.includes(current.file.path)) setSelected(pickNext({ reviewed: decisions.reviewed, requested: { ...decisions.requested, ...Object.fromEntries(paths.map((path) => [path, files.find((file) => file.path === path)?.after ?? null])) } }, selected));
  };
  const addNewComment = useCallback((draft: NewComment): void => setComments((existing) => addComment(existing, draft, crypto.randomUUID(), Date.now())), []);
  const editOne = useCallback((id: string, text: string): void => setComments((existing) => editComment(existing, id, text)), []);
  const removeOne = useCallback((id: string): void => setComments((existing) => removeComment(existing, id)), []);
  const setDraft = useCallback((path: string, next: { anchor: LineAnchor; text: string } | null): void => setDrafts((existing) => {
    if (next) return { ...existing, [path]: next };
    const { [path]: _gone, ...rest } = existing;
    return rest;
  }), []);
  const setMode = useCallback((mode: DiffMode): void => setPrefs((existing) => ({ ...existing, mode })), []);

  const modal = confirming || help;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (modal || !focusIsHere(frame.current, event.target)) return;
      const key = keyOf(event);
      if (key === 'Escape') {
        if (typing(event.target)) (event.target as HTMLElement).blur();
        else if (drawer) setDrawer(false);
        else onExit();
        return;
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const inList = event.target instanceof HTMLElement && event.target.closest('.rv-list') !== null;
      if (key === 'j' || (key === 'ArrowDown' && inList)) setSelected(step(navigable, selected, 1));
      else if (key === 'k' || (key === 'ArrowUp' && inList)) setSelected(step(navigable, selected, -1));
      else if (key === 'a' && current) accept([current.file], true);
      else if (key === 'u') {
        if (toast?.undo) {
          const run = toast.undo;
          setToast(null);
          run();
        } else undoLast();
      }
      else if (key === 'r' && current && !current.file.reverted) setConfirming(true);
      else if (key === 'i') setPrefs((existing) => ({ ...existing, showContext: !existing.showContext }));
      else if (key === '?') setHelp(true);
      else if (key === '/') {
        if (compact && !drawer) setDrawer(true);
        window.setTimeout(() => filterInput.current?.focus(), compact ? 40 : 0);
      }
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!modal && (document.activeElement === document.body || document.activeElement === null)) frame.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (compact) setDrawer(false);
  }, [compact, selected?.path]);

  const context = useMemo(() => (current ? contextOf(current.section, current.file, history, chatItems) : null), [current, history, chatItems]);
  const requestId = current ? requests.current[diffKey(current.file)] : undefined;
  const select = useCallback((position: Position): void => {
    setSelected(position);
    frame.current?.focus({ preventScroll: true });
  }, []);
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;
  const markFile = useCallback((file: ReviewItem, markState: FileState): void => onMarkRef.current(file, markState), []);

  return (
    <div className={`review-mode rv${compact ? ' compact' : ''}`} data-testid="review-mode" ref={frame} tabIndex={-1} style={{ '--rv-list': `${listWidth}px` } as CSSProperties}>
      {compact && drawer && <div className="rv-backdrop" onClick={() => setDrawer(false)} />}
      <div className={`rv-list-wrap${compact ? ' drawer' : ''}${drawer ? ' open' : ''}`} inert={compact && !drawer}>
        <ReviewList
          sections={visible}
          totals={totals}
          decisions={decisions}
          selected={selected}
          tally={tally}
          filter={filter}
          onFilter={setFilter}
          filterRef={filterInput}
          collapsed={collapsed}
          onToggle={(key) => setCollapsed((existing) => ({ ...existing, [key]: !existing[key] }))}
          onSelect={select}
          onMark={markFile}
          onAcceptGroup={(section) => accept(section.files.filter((file) => isOpen(fileState(decisions.reviewed, decisions.requested, file))), false)}
          commentCounts={commentCounts}
          unsentComments={pending.length}
          unsentFiles={filesWith(pending).length}
          onRequestChanges={requestFixes}
          onExit={onExit}
        />
      </div>
      {!compact && (
        <Resizer
          orientation="vertical"
          label="Resize the file list"
          value={prefs.listWidth}
          min={LIST_WIDTH.min}
          max={LIST_WIDTH.max}
          grow={1}
          onResize={(size) => setPrefs((existing) => ({ ...existing, listWidth: clampListWidth(size) }))}
          onReset={() => setPrefs((existing) => ({ ...existing, listWidth: LIST_WIDTH.initial }))}
        />
      )}
      <section className="rv-main">
        {compact && (
          <button className="rv-files-button" onClick={() => setDrawer(true)} aria-label="Show the file list">
            <Icon name="panel-left" size={15} />Files <b>{tally.accepted + tally.requested + tally.reverted}/{tally.total}</b>
          </button>
        )}
        {current && state && context ? (
          <ReviewDiff
            key={current.file.path}
            file={current.file}
            state={state}
            result={requestId ? results[requestId] : undefined}
            noRequest={requestId === null}
            onRetry={() => retry(current.file)}
            mode={prefs.mode}
            onMode={setMode}
            comments={comments.filter((comment) => comment.path === current.file.path)}
            draft={drafts[current.file.path] ?? null}
            onDraft={setDraft}
            onAddComment={addNewComment}
            onEditComment={editOne}
            onRemoveComment={removeOne}
            onAccept={() => accept([current.file], true)}
            onUndo={() => unaccept([current.file])}
            onRevert={() => setConfirming(true)}
            onUndoRevert={() => undoRevert(current.file.path)}
            onMap={() => onShowOnMap([current.file.path])}
            reverting={ops.some((op) => op.kind === 'revert')}
            error={error}
            onDismissError={() => setError(null)}
            active={!modal}
          >
            <ReviewContextStrip context={context} open={prefs.showContext} onToggle={() => setPrefs((existing) => ({ ...existing, showContext: !existing.showContext }))} onJump={onShowInChat} />
          </ReviewDiff>
        ) : (
          <ReviewFinish
            tally={tally}
            unsentComments={pending.length}
            onRequest={requestFixes}
            onContinue={() => setSelected(nextOpen(sections, decisions, null))}
            onExit={onExit}
          />
        )}
        <footer className="rv-keys">
          <span><Kbd>j</Kbd><Kbd>k</Kbd> files</span>
          <span><Kbd>n</Kbd><Kbd>p</Kbd> hunks</span>
          <span><Kbd>a</Kbd> accept</span>
          <span><Kbd>c</Kbd> comment</span>
          <span><Kbd>r</Kbd> revert</span>
          <span className="rv-spacer" />
          <button className="rv-keys-help" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)"><Kbd>?</Kbd> shortcuts</button>
        </footer>
        {toast && (
          <div className="rv-toast" key={toast.id}>
            <span>{toast.text}</span>
            {toast.undo && <button onClick={() => { toast.undo?.(); setToast(null); }}>Undo<Kbd>u</Kbd></button>}
            <button className="rv-icon" onClick={() => setToast(null)} aria-label="Dismiss"><Icon name="close" size={13} /></button>
          </div>
        )}
      </section>
      {confirming && current && (
        <ConfirmRevert
          paths={current.file.renamedFrom ? [current.file.renamedFrom, current.file.path] : [current.file.path]}
          moved={current.file.renamedFrom !== null}
          outOfPlan={current.section.outOfPlan}
          onCancel={() => setConfirming(false)}
          onConfirm={revert}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      <div className="rv-sr" aria-live="polite" role="status">{announcement}</div>
    </div>
  );
}
