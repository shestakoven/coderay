import { useEffect, useMemo, useState } from 'react';
import type { ClientMessage, HistoryView, PlanView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Hunks } from './DiffPanel';
import { accept, loadReviewed, neighbor, nextPending, progress, saveReviewed, statusOf, type FileStatus, type Position, type Reviewed } from './review-progress';
import { FilePath } from './ReviewPanel';
import { reviewGroups, type ReviewFile } from './review-state';
import type { DiffResult } from './WatchdogDialog';

interface Props {
  history: HistoryView;
  plans: PlanView[];
  results: Record<string, DiffResult | undefined>;
  requestDiff: (path: string, before: string | null, after: string | null) => string | null;
  send: (message: ClientMessage) => boolean;
  root: string;
  onShowOnMap: (paths: string[]) => void;
  onExit: () => void;
}

const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const same = (a: Position | null, b: Position | null): boolean => a !== null && b !== null && a.group === b.group && a.path === b.path;

export function ReviewMode({ history, plans, results, requestDiff, send, root, onShowOnMap, onExit }: Props) {
  const groups = useMemo(() => reviewGroups(history, plans), [history, plans]);
  const [reviewed, setReviewed] = useState<Reviewed>(() => loadReviewed(window.localStorage, root));
  const [selected, setSelected] = useState<Position | null>(null);
  const [requests, setRequests] = useState<Record<string, string | null>>({});
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  useEffect(() => saveReviewed(window.localStorage, root, reviewed), [root, reviewed]);

  const current = useMemo(() => {
    const group = groups.find((entry) => entry.key === selected?.group);
    const file = group?.files.find((entry) => entry.path === selected?.path);
    return group && file ? { group, file } : null;
  }, [groups, selected]);

  useEffect(() => {
    if (current) return;
    setSelected(nextPending(groups, reviewed, selected) ?? neighbor(groups, null, 1));
  }, [current, groups, reviewed, selected]);

  const diffKey = current ? `${current.group.key}:${current.file.path}:${current.file.before}:${current.file.after}` : null;
  useEffect(() => {
    if (!current || diffKey === null || diffKey in requests) return;
    setRequests((existing) => ({ ...existing, [diffKey]: requestDiff(current.file.path, current.file.before, current.file.after) }));
  }, [current, diffKey, requests, requestDiff]);

  useEffect(() => {
    if (reverting === null) return;
    const result = results[reverting];
    if (!result) return;
    setReverting(null);
    setRevertError(result.error);
  }, [results, reverting]);

  const decide = (files: ReviewFile[], from: Position | null): void => {
    const next = accept(reviewed, files);
    setReviewed(next);
    setSelected(nextPending(groups, next, from));
  };
  const acceptCurrent = (): void => {
    if (current) decide([current.file], selected);
  };
  const startRevert = (): void => {
    if (!current) return;
    const requestId = crypto.randomUUID();
    setConfirming(false);
    setRevertError(null);
    if (send({ type: 'change.revert', requestId, changeIds: current.file.ids })) setReverting(requestId);
    else setRevertError('Not connected to the core.');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (confirming) setConfirming(false);
        else onExit();
        return;
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (confirming) {
        if (event.key === 'Enter') startRevert();
        return;
      }
      if (event.key === 'j' || event.key === 'ArrowDown') setSelected(neighbor(groups, selected, 1));
      else if (event.key === 'k' || event.key === 'ArrowUp') setSelected(neighbor(groups, selected, -1));
      else if (event.key === 'a') acceptCurrent();
      else if (event.key === 'r' && current) setConfirming(true);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const { done, total } = progress(groups, reviewed);
  const requestId = diffKey ? requests[diffKey] : undefined;
  const status: FileStatus | null = current ? statusOf(reviewed, current.file) : null;

  return (
    <div className="review-mode" data-testid="review-mode">
      <aside className="rm-list">
        <header className="rm-head">
          <strong>Review</strong>
          <span className="rm-progress">{done} / {total}</span>
          <button className="rm-icon" onClick={onExit} title="Exit review (Esc)" aria-label="Exit review"><Icon name="close" size={16} /></button>
        </header>
        <div className="rm-bar"><i style={{ width: total === 0 ? '0%' : `${(done / total) * 100}%` }} /></div>
        <div className="rm-scroll">
          {groups.map((group) => (
            <section key={group.key} className={`rm-group${group.outOfPlan ? ' out' : ''}`}>
              <header className="rm-group-head">
                <span className="rm-group-name">{group.title}</span>
                <span className="review-stat"><span className="add">+{group.added}</span> <span className="del">−{group.removed}</span></span>
                <button className="rm-icon" title="Accept all in this group" aria-label="Accept all in this group" onClick={() => decide(group.files, selected)}><Icon name="check" size={16} /></button>
              </header>
              <ul>
                {group.files.map((file) => {
                  const position = { group: group.key, path: file.path };
                  const fileStatus = statusOf(reviewed, file);
                  return (
                    <li key={file.path}>
                      <button className={`rm-row ${fileStatus}${same(selected, position) ? ' on' : ''}`} onClick={() => setSelected(position)} title={file.path}>
                        <span className="rm-mark">{fileStatus === 'reviewed' ? <Icon name="check" size={13} /> : null}</span>
                        <FilePath path={file.path} />
                        <span className="review-stat"><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {groups.length === 0 && <p className="empty muted">Nothing to review yet.</p>}
        </div>
      </aside>
      <section className="rm-main">
        {current ? (
          <>
            <header className="rm-file-head">
              <FilePath path={current.file.path} />
              <span className="review-stat"><span className="add">+{current.file.added}</span> <span className="del">−{current.file.removed}</span></span>
              {status === 'reviewed' && <span className="rm-tag ok">accepted</span>}
              {status === 'updated' && <span className="rm-tag warn">changed since you accepted it</span>}
              <span className="rm-spacer" />
              <button className="rm-btn" onClick={() => onShowOnMap([current.file.path])} title="Show on the map">Map</button>
              <button className="rm-btn danger" disabled={reverting !== null} onClick={() => setConfirming(true)} title="Revert this file (r)">{reverting ? 'Reverting…' : 'Revert'}</button>
              <button className="rm-btn primary" onClick={acceptCurrent} title="Accept (a)"><Icon name="check" size={15} /> Accept</button>
            </header>
            {revertError && <div className="rm-error" role="alert">{revertError}</div>}
            <div className="rm-diff">
              <Hunks result={requestId ? results[requestId] : undefined} failed={requestId === null} path={current.file.path} />
            </div>
          </>
        ) : (
          <div className="rm-done">
            <Icon name="check" size={28} />
            <h2>{total === 0 ? 'Nothing to review' : 'Review complete'}</h2>
            <p className="muted">{total === 0 ? 'Changes the agent makes will appear here.' : `${done} of ${total} files accepted.`}</p>
            <button className="rm-btn primary" onClick={onExit}>Back to the map</button>
          </div>
        )}
        <footer className="rm-keys">
          <span><kbd>j</kbd><kbd>k</kbd> files</span>
          <span><kbd>a</kbd> accept</span>
          <span><kbd>r</kbd> revert</span>
          <span><kbd>esc</kbd> exit</span>
        </footer>
      </section>
      {confirming && current && (
        <div className="modal" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirming(false); }}>
          <section className="settings rollback" role="dialog" aria-label="Revert file">
            <h3>Revert {current.file.path}?</h3>
            <p className="muted">The file goes back to its content before {current.group.outOfPlan ? 'these out-of-plan edits' : 'these changes'}. You can undo this from the Timeline.</p>
            <div className="modal-actions">
              <button onClick={() => setConfirming(false)}>Cancel</button>
              <button className="rm-btn danger" autoFocus onClick={startRevert}>Revert</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
