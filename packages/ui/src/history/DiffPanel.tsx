import { useState } from 'react';
import type { ChangeView, HistoryView, MapSnapshot, PlanView } from '@ide/protocol';
import type { ChatFilter } from '../chat/chat-state';
import type { DiffResult } from './WatchdogDialog';
import { changesByStep, chatFilterIds, nodeChanges } from './history-state';

interface Props {
  nodeId: string;
  history: HistoryView;
  plans: PlanView[];
  snapshot: MapSnapshot | null;
  filter: ChatFilter | null;
  onFilter: (filter: ChatFilter | null) => void;
  diffs: Record<string, DiffResult | undefined>;
  requestDiff: (path: string, before: string | null, after: string | null) => string | null;
}

export function DiffPanel({ nodeId, history, plans, snapshot, filter, onFilter, diffs, requestDiff }: Props) {
  const groups = changesByStep(history, plans, nodeId, snapshot);
  const [requested, setRequested] = useState<Record<string, string | null>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const label = snapshot?.components.find((c) => c.id === nodeId)?.name ?? nodeId;
  const toggleFilter = (on: boolean): void => {
    if (!on) return onFilter(null);
    const files = new Set(nodeChanges(history, snapshot, nodeId).files);
    onFilter({ nodeId, label, toolUseIds: chatFilterIds(history, nodeId, snapshot), files });
  };
  const expand = (change: ChangeView): void => {
    setOpen({ ...open, [change.id]: !open[change.id] });
    if (requested[change.id]) return;
    const id = requestDiff(change.path, change.beforeHash, change.afterHash);
    setRequested({ ...requested, [change.id]: id });
    setFailed({ ...failed, [change.id]: id === null });
  };
  if (groups.length === 0) return <p className="muted">No changes here yet.</p>;
  return (
    <div className="diff-panel" data-testid="diff-panel">
      <label className="filter-toggle">
        <input type="checkbox" checked={filter?.nodeId === nodeId} onChange={(event) => toggleFilter(event.target.checked)} /> Show related chat only
      </label>
      {groups.map((group) => (
        <section key={group.stepKey ?? 'none'} className="diff-step">
          <h3>{group.title}</h3>
          {group.rationale && <p className="muted">{group.rationale}</p>}
          {group.stepKey !== null && (
            <p className="summary-text">{group.summary?.text ?? <span className="muted">summary pending</span>}</p>
          )}
          <ul>
            {group.changes.map((change) => {
              const requestId = requested[change.id];
              const result = requestId ? diffs[requestId] : undefined;
              return (
                <li key={change.id}>
                  <button className="link-row" onClick={() => expand(change)}>
                    {open[change.id] ? '▾' : '▸'} <code>{change.path}</code>
                  </button>{' '}
                  <span className="muted">{change.origin} · {change.resolution ?? 'unresolved'}</span>
                  {open[change.id] && <Hunks result={result} failed={failed[change.id] === true} />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Hunks({ result, failed }: { result: DiffResult | undefined; failed: boolean }) {
  if (failed) return <p className="warn">Could not request the diff.</p>;
  if (!result) return <p className="muted">Loading…</p>;
  if (result.error) return <p className="warn">{result.error}</p>;
  const diff = result.diff;
  if (!diff) return null;
  if (diff.binary) return <p className="muted">Binary file.</p>;
  if (diff.missing) return <p className="muted">The stored content is gone.</p>;
  return (
    <pre className="oop-diff">
      {diff.hunks.map((hunk) => (
        <div key={`${hunk.oldStart}:${hunk.newStart}`} className="hunk">
          <div className="muted">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
          {hunk.lines.map((line, i) => (
            <span key={i} className={line.op === 'add' ? 'add' : line.op === 'del' ? 'del' : ''}>
              {line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '}{line.text}{'\n'}
            </span>
          ))}
        </div>
      ))}
      {diff.truncated && <div className="muted">truncated</div>}
    </pre>
  );
}
