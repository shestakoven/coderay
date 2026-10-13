import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, PlanView, ReviewGraph } from '@ide/protocol';
import { Icon } from '../../layout/Icon';
import { LayoutMenu } from '../../map/LayoutMenu';
import { DEFAULT_LAYOUT, type Direction } from '../../map/layout-settings';
import { loadFlowDirection, saveFlowDirection } from '../../plan-flow/flow-settings';
import { focusIsHere, keyOf, typing } from '../review-keys';
import { focusOf, partOfPath, stepOutcomes, targetKey, totalsOf, visibleMap, type Target } from './review-map-model';
import { formatQuestions, loadQuestions, markAsked, outdated, persistQuestions, questionFor, removeQuestion, saveQuestion, unsentQuestions, type MapQuestion } from './review-map-questions';
import { ReviewMapBar } from './ReviewMapBar';
import { ReviewMapCanvas } from './ReviewMapCanvas';
import { ReviewMapPanel } from './ReviewMapPanel';
import './review-map.css';

export interface ReviewMapProps {
  graph: ReviewGraph | null;
  loading: boolean;
  error: string | null;
  plan: PlanView | null;
  root: string;
  reviewed: ReadonlySet<string>;
  selectedPath: string | null;
  active: boolean;
  send: (message: ClientMessage) => boolean;
  onSelectPath: (path: string | null) => void;
  onAccept: (paths: string[]) => void;
  onOpenChat: () => void;
}

const CONTEXT_KEY = 'ide.review.map.context';
const SEND_FAILED = 'The questions could not be sent. They are too long, or the core is not connected.';

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function loadContext(): boolean {
  try {
    return storage()?.getItem(CONTEXT_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveContext(value: boolean): void {
  try {
    storage()?.setItem(CONTEXT_KEY, String(value));
  } catch {
    // storage unavailable or full: the choice only lasts for this session
  }
}

function describeTarget(graph: ReviewGraph, target: Target): { title: string; where: string } {
  const titleOf = (id: string): string => graph.parts.find((part) => part.id === id)?.title ?? id;
  if (target.t === 'part') {
    return { title: titleOf(target.id), where: graph.parts.find((part) => part.id === target.id)?.files[0]?.path ?? '' };
  }
  const link = graph.links.find((candidate) => candidate.from === target.from && candidate.to === target.to);
  const at = link?.evidence[0];
  const where = at !== undefined ? `${at.path}:${at.line}` : link?.state === 'existing' ? '' : 'not in the code';
  return { title: `${titleOf(target.from)} → ${titleOf(target.to)}`, where };
}

function ReviewMapView({ graph, loading, error, plan, root, reviewed, selectedPath, active, send, onSelectPath, onAccept, onOpenChat }: ReviewMapProps) {
  const [context, setContext] = useState(loadContext);
  const [direction, setDirection] = useState<Direction>(() => loadFlowDirection(storage()));
  const [selection, setSelection] = useState<Target | null>(() => {
    const id = graph !== null && selectedPath !== null ? partOfPath(graph, selectedPath) : null;
    return id === null ? null : { t: 'part', id };
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [questions, setQuestions] = useState<MapQuestion[]>(() => loadQuestions(storage(), root));
  const [sendError, setSendError] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [headHeight, setHeadHeight] = useState(0);

  useEffect(() => {
    persistQuestions(storage(), root, questions);
  }, [root, questions]);

  // A closed editor takes its focus with it; the review gets it back so its keys and the next Esc keep working from it.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing !== null) {
      wasEditing.current = true;
      return;
    }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    // The editor lives in a React Flow node, which drops it a render later: look once it is gone.
    const timer = window.setTimeout(() => {
      if (document.activeElement === null || document.activeElement === document.body) frame.current?.closest<HTMLElement>('.rv')?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  // The toolbar wraps and a note may sit under it: the map fits below whatever they take.
  const drawn = graph !== null;
  useEffect(() => {
    const element = head.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setHeadHeight(Math.round(entry?.contentRect.height ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawn]);

  const view = useMemo(() => (graph === null ? null : visibleMap(graph, context)), [graph, context]);
  const focus = useMemo(() => (view === null ? null : focusOf(view, selection)), [view, selection]);
  const totals = useMemo(() => (graph === null ? null : totalsOf(graph)), [graph]);
  const steps = useMemo(() => (graph === null ? [] : stepOutcomes(plan, graph)), [plan, graph]);
  const unsent = useMemo(() => unsentQuestions(questions), [questions]);
  const stale = useMemo(() => new Set((graph === null ? [] : outdated(questions, graph)).map((question) => question.id)), [questions, graph]);
  const askedCount = useMemo(
    () => questions.filter((question) => question.sentAt !== null && !stale.has(question.id) && questionFor(questions, question.target)?.id === question.id).length,
    [questions, stale],
  );
  const message = useMemo(() => (unsent.length === 0 ? '' : formatQuestions(unsent)), [unsent]);
  const draftShown = draftOpen && unsent.length > 0;
  useEffect(() => {
    if (unsent.length === 0) setDraftOpen(false);
  }, [unsent.length]);
  const files = useMemo(() => (graph === null ? [] : graph.parts.flatMap((part) => part.files)), [graph]);
  const reviewedCount = useMemo(() => files.filter((file) => reviewed.has(file.path)).length, [files, reviewed]);

  // A selection the view no longer draws (a hidden unchanged part, a part the newer graph dropped) cannot stay.
  useEffect(() => {
    if (selection === null || view === null || focusOf(view, selection) !== null) return;
    setSelection(null);
    setEditing(null);
  }, [selection, view]);

  // The review list drives the map by the file it selects; a file inside the selected part leaves the selection alone.
  const ready = graph !== null;
  useEffect(() => {
    if (selectedPath === null || graph === null) return;
    const id = partOfPath(graph, selectedPath);
    if (id === null) return;
    setSelection((current) => (current?.t === 'part' && current.id === id ? current : { t: 'part', id }));
    setEditing((current) => (current === targetKey({ t: 'part', id }) ? current : null));
  }, [selectedPath, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((target: Target | null) => {
    setSelection(target);
    setEditing(null);
    if (target?.t !== 'part') return;
    const own = graph?.parts.find((part) => part.id === target.id)?.files ?? [];
    const first = own[0];
    if (first !== undefined && !own.some((file) => file.path === selectedPath)) onSelectPath(first.path);
  }, [graph, selectedPath, onSelectPath]);

  const ask = useCallback((target: Target) => {
    select(target);
    setEditing(targetKey(target));
  }, [select]);

  const save = useCallback((target: Target, text: string) => {
    if (graph === null) return;
    setQuestions((existing) => saveQuestion(existing, { target, ...describeTarget(graph, target), text }, crypto.randomUUID(), Date.now()));
    setEditing(null);
    setSendError(null);
  }, [graph]);

  const cancel = useCallback(() => setEditing(null), []);

  const sendQuestions = useCallback(() => {
    if (unsent.length === 0) return;
    if (!send({ type: 'chat.send', text: formatQuestions(unsent) })) {
      setSendError(SEND_FAILED);
      setDraftOpen(false);
      return;
    }
    setSendError(null);
    setEditing(null);
    setDraftOpen(false);
    setQuestions((existing) => markAsked(existing, unsent.map((question) => question.id), Date.now()));
  }, [unsent, send]);

  const reset = useCallback(() => {
    setQuestions((existing) => existing.filter((question) => question.sentAt !== null));
    setEditing(null);
    setSendError(null);
    setDraftOpen(false);
  }, []);

  const clearAsked = useCallback(() => setQuestions(unsentQuestions), []);

  useEffect(() => {
    if (!active) return;
    // Capture phase: a key the map uses must not also exit the review behind it.
    const onKey = (event: KeyboardEvent): void => {
      const review = frame.current?.closest('.rv') ?? frame.current;
      if (typing(event.target) || !focusIsHere(review, event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'Enter') {
        if (unsent.length === 0) return;
        event.preventDefault();
        sendQuestions();
        return;
      }
      if (event.key === 'Escape') {
        if (editing !== null) setEditing(null);
        else if (draftShown) setDraftOpen(false);
        else if (selection !== null) select(null);
        else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (meta || event.altKey || selection === null || keyOf(event) !== 'q') return;
      event.preventDefault();
      setEditing(targetKey(selection));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, unsent, sendQuestions, editing, draftShown, selection, select]);

  const changeContext = (next: boolean): void => {
    setContext(next);
    saveContext(next);
  };
  const changeDirection = (next: Direction): void => {
    setDirection(next);
    saveFlowDirection(storage(), next);
  };

  if (graph === null || view === null || totals === null) {
    return (
      <div ref={frame} className="pf-canvas rm-canvas" data-testid="review-map">
        {error === null ? (
          <div className="rm-empty" role="status">
            <span className="pf-spin" />
            <p>Building the map of this review…</p>
          </div>
        ) : (
          <div className="rm-empty" role="alert">
            <Icon name="alert" size={20} />
            <p>{error}</p>
            <p className="rm-empty-hint">The Diff tab still works.</p>
          </div>
        )}
      </div>
    );
  }

  const note = error ?? graph.partial;
  const target = selection !== null && focus !== null ? selection : null;
  return (
    <div ref={frame} className="pf-canvas rm-canvas has-bar" data-testid="review-map">
      {view.parts.length === 0 ? (
        <div className="rm-empty">
          <Icon name="map" size={20} />
          <p>{graph.parts.length === 0 ? 'Nothing to draw: no file changed in this review.' : 'No part changed. Switch to With context to see the rest.'}</p>
        </div>
      ) : (
        <ReviewMapCanvas
          key={direction}
          view={view}
          focus={focus}
          selection={selection}
          direction={direction}
          steps={steps}
          reviewed={reviewed}
          questions={questions}
          editing={editing}
          onSelect={select}
          onAsk={ask}
          onSave={save}
          onCancel={cancel}
          onOpenChat={onOpenChat}
          headHeight={headHeight}
        />
      )}
      <div className="rm-top">
        <div className="rm-head" ref={head}>
          <div className="pf-row">
            <div className="pf-seg">
              <button type="button" className={context ? 'on' : ''} onClick={() => changeContext(true)}>With context</button>
              <button type="button" className={!context ? 'on' : ''} onClick={() => changeContext(false)}>Changed only</button>
            </div>
            <LayoutMenu settings={{ ...DEFAULT_LAYOUT, direction }} fields={['direction']} onChange={(next) => changeDirection(next.direction)} />
            <div className="pf-impact">
              {totals.created > 0 && <span className="pf-stat"><b className="rm-c-new">{totals.created}</b> new</span>}
              {totals.modified > 0 && <span className="pf-stat"><b className="rm-c-mod">{totals.modified}</b> changed</span>}
              {totals.deleted > 0 && <span className="pf-stat"><b className="rm-c-del">{totals.deleted}</b> removed</span>}
              {files.length > 0 && <span className="pf-stat"><b className="op-add">+{totals.added}</b> <b className="op-del">−{totals.removed}</b></span>}
              {totals.missing > 0 && <span className="pf-stat rm-flag"><b>{totals.missing}</b> not done</span>}
              {totals.outside > 0 && <span className="pf-stat rm-flag"><b>{totals.outside}</b> outside the plan</span>}
              {totals.unplanned > 0 && <span className="pf-stat rm-flag"><b>{totals.unplanned}</b> unplanned {totals.unplanned === 1 ? 'link' : 'links'}</span>}
              {totals.broken > 0 && <span className="pf-stat rm-flag bad"><b>{totals.broken}</b> broken {totals.broken === 1 ? 'import' : 'imports'}</span>}
            </div>
            {loading && <span className="pf-spin rm-refresh" title="Updating the map" role="status" aria-label="Updating the map" />}
          </div>
          {note !== null && (
            <p className={`rm-note${error === null ? '' : ' bad'}`} title={note} role={error === null ? 'note' : 'alert'}>
              <Icon name={error === null ? 'info' : 'alert'} size={12} />
              <span>{note}</span>
            </p>
          )}
        </div>
        {target !== null && (
          <ReviewMapPanel
            graph={graph}
            plan={plan}
            target={target}
            question={questionFor(questions, target)}
            reviewed={reviewed}
            selectedPath={selectedPath}
            onAccept={onAccept}
            onOpenFile={onSelectPath}
            onAsk={() => setEditing(targetKey(target))}
            onOpenChat={onOpenChat}
            onClose={() => select(null)}
          />
        )}
      </div>
      {sendError !== null && (
        <div className="rm-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{sendError}</span>
          <button type="button" className="pf-x" aria-label="Dismiss" onClick={() => setSendError(null)}>{'×'}</button>
        </div>
      )}
      <ReviewMapBar
        reviewed={reviewedCount}
        files={files.length}
        unsent={unsent}
        outdated={stale}
        asked={askedCount}
        text={message}
        open={draftShown}
        onOpen={setDraftOpen}
        onRemove={(id) => setQuestions((existing) => removeQuestion(existing, id))}
        onReset={reset}
        onClearAsked={clearAsked}
        onSend={sendQuestions}
        onOpenChat={onOpenChat}
      />
    </div>
  );
}

export function ReviewMap(props: ReviewMapProps) {
  return <ReviewMapView key={props.root} {...props} />;
}
