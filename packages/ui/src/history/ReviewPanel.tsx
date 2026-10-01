import { useState } from 'react';
import type { HistoryView, PlanView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Hunks } from './DiffPanel';
import { reviewGroups, type ReviewFile, type ReviewGroup } from './review-state';
import type { DiffResult } from './WatchdogDialog';

interface Props {
  history: HistoryView;
  plans: PlanView[];
  diffs: Record<string, DiffResult | undefined>;
  requestDiff: (path: string, before: string | null, after: string | null) => string | null;
  onShowOnMap: (paths: string[]) => void;
}

export function ReviewPanel({ history, plans, diffs, requestDiff, onShowOnMap }: Props) {
  const groups = reviewGroups(history, plans);
  const [requested, setRequested] = useState<Record<string, string | null>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const expand = (key: string, file: ReviewFile): void => {
    setOpen((current) => ({ ...current, [key]: !current[key] }));
    if (key in requested) return;
    setRequested((current) => ({ ...current, [key]: requestDiff(file.path, file.before, file.after) }));
  };
  if (groups.length === 0) return <div className="empty muted">Nothing to review yet. Changes the agent makes show up here, step by step.</div>;
  return (
    <div className="review" data-testid="review-panel">
      {groups.map((entry) => (
        <ReviewSection
          key={entry.key}
          entry={entry}
          folded={collapsed[entry.key] === true}
          onFold={() => setCollapsed((current) => ({ ...current, [entry.key]: !current[entry.key] }))}
          open={open}
          requested={requested}
          diffs={diffs}
          onExpand={expand}
          onShowOnMap={onShowOnMap}
        />
      ))}
    </div>
  );
}

function ReviewSection({ entry, folded, onFold, open, requested, diffs, onExpand, onShowOnMap }: {
  entry: ReviewGroup;
  folded: boolean;
  onFold: () => void;
  open: Record<string, boolean>;
  requested: Record<string, string | null>;
  diffs: Record<string, DiffResult | undefined>;
  onExpand: (key: string, file: ReviewFile) => void;
  onShowOnMap: (paths: string[]) => void;
}) {
  return (
    <section className={`review-group${entry.outOfPlan ? ' out' : ''}`}>
      <header className="review-head">
        <button className="review-title" onClick={onFold} aria-expanded={!folded}>
          <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={16} />
          <span className="review-name">{entry.title}</span>
        </button>
        <span className="review-stat"><span className="add">+{entry.added}</span> <span className="del">−{entry.removed}</span></span>
        <button className="tl-action shown" title="Show on the map" aria-label="Show on the map" onClick={() => onShowOnMap(entry.files.map((file) => file.path))}><Icon name="search" size={18} /></button>
      </header>
      {!folded && (
        <>
          {entry.summary && <p className="review-summary muted">{entry.summary.text ?? 'summary pending'}</p>}
          <ul className="review-files">
            {entry.files.map((file) => {
              const key = `${entry.key}:${file.path}`;
              const requestId = requested[key];
              const result = requestId ? diffs[requestId] : undefined;
              return (
                <li key={key}>
                  <button className="review-file" onClick={() => onExpand(key, file)} aria-expanded={open[key] === true} title={file.path}>
                    <Icon name={open[key] ? 'chevron-down' : 'chevron-right'} size={15} />
                    <FilePath path={file.path} />
                    <span className="review-stat"><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span>
                  </button>
                  {open[key] && <Hunks result={result} failed={requestId === null} path={file.path} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <code className="review-path">
      {slash >= 0 && <span className="review-dir">{path.slice(0, slash + 1)}</span>}
      <span className="review-base">{path.slice(slash + 1)}</span>
    </code>
  );
}
