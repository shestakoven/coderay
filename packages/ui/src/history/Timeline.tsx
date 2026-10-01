import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import type { ClientMessage, HistoryView, PlanView, RollbackPreview } from '@ide/protocol';
import type { ChatState } from '../chat/chat-state';
import { Icon } from '../layout/Icon';
import type { BottomTab } from '../layout/panel-state';
import { timelineItems, type TimelineItem } from './history-state';
import { agentIdle, canConfirmRollback, canOfferRollback, rollbackReducer } from './timeline-state';

export interface HistoryResults { [requestId: string]: { error: string | null; preview?: RollbackPreview } | undefined }

interface Props {
  plans: PlanView[];
  latestPlan: PlanView | null;
  history: HistoryView;
  results: HistoryResults;
  chat: ChatState;
  send: (message: ClientMessage) => boolean;
  onSelect: (item: TimelineItem) => void;
  open: boolean;
  onToggle: () => void;
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  terminal: ReactNode;
  terminalCount: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function timelineSummary(items: TimelineItem[]): string {
  const count = (kind: TimelineItem['kind']): number => items.filter((i) => i.kind === kind).length;
  return [plural(count('step'), 'step'), plural(count('event') + count('gate'), 'event'), plural(count('revert'), 'revert')].join(' · ');
}

export function Timeline({ plans, latestPlan, history, results, chat, send, onSelect, open, onToggle, tab, onTab, terminal, terminalCount }: Props) {
  const [rollback, dispatch] = useReducer(rollbackReducer, null);
  const [undoing, setUndoing] = useState<Record<string, string>>({});
  const items = useMemo(() => timelineItems(plans, history), [plans, history]);

  useEffect(() => {
    if (!rollback?.requestId) return;
    const result = results[rollback.requestId];
    if (!result) return;
    if (rollback.stage === 'previewing' && result.preview && !result.error) dispatch({ type: 'preview', preview: result.preview });
    else if (rollback.stage === 'previewing' && !result.error) dispatch({ type: 'result', error: 'The core sent no preview for this step.' });
    else if (rollback.stage === 'previewing' || rollback.stage === 'running') dispatch({ type: 'result', error: result.error });
  }, [rollback, results]);

  const openRollback = (planId: string, stepKey: string): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'step.rollback-preview', requestId, planId, stepKey })) dispatch({ type: 'open', planId, stepKey, requestId });
  };
  const undo = (revertId: string): void => {
    const requestId = crypto.randomUUID();
    if (!undoPending(revertId) && send({ type: 'revert.undo', requestId, revertId })) setUndoing({ ...undoing, [revertId]: requestId });
  };
  const undoPending = (revertId: string): boolean => {
    const requestId = undoing[revertId];
    return requestId !== undefined && results[requestId] === undefined;
  };
  const undoText = (revertId: string): string | null => {
    const requestId = undoing[revertId];
    const result = requestId ? results[requestId] : undefined;
    return result?.error ?? null;
  };

  return (
    <footer className="timeline" data-testid="timeline">
      <div className="bottom-tabs">
        <button className={`timeline-bar${open && tab === 'timeline' ? ' on' : ''}`} aria-pressed={open && tab === 'timeline'} aria-expanded={open && tab === 'timeline'} onClick={() => (open && tab === 'timeline' ? onToggle() : onTab('timeline'))}>
          <Icon name={open && tab === 'timeline' ? 'chevron-down' : 'chevron-right'} size={14} /> {timelineSummary(items)}
        </button>
        <button className={`timeline-bar${open && tab === 'terminal' ? ' on' : ''}`} aria-pressed={open && tab === 'terminal'} onClick={() => (open && tab === 'terminal' ? onToggle() : onTab('terminal'))}>
          <Icon name="terminal" size={14} /> Terminal{terminalCount > 0 ? ` · ${terminalCount}` : ''}
        </button>
      </div>
      <div className="terminal-slot" hidden={!(open && tab === 'terminal')}>{terminal}</div>
      {open && tab === 'timeline' && (
        <ul className="timeline-list">
          {items.map((item) => {
            const step = item.kind === 'step' ? latestPlan?.steps.find((s) => s.key === item.ref.stepKey) : undefined;
            const revert = item.kind === 'revert' ? history.reverts.find((r) => r.id === item.ref.revertId) : undefined;
            const error = revert ? undoText(revert.id) : null;
            return (
              <li key={item.id} className={`tl-item ${item.tone}`}>
                <button className="link-row" onClick={() => onSelect(item)}>{item.label}</button>
                {step && item.ref.planId === latestPlan?.id && canOfferRollback(chat, latestPlan, step) && (
                  <button title="Roll this step back" onClick={() => openRollback(item.ref.planId!, item.ref.stepKey!)}>↺</button>
                )}
                {revert && revert.undoneAt === null && <button disabled={undoPending(revert.id) || !agentIdle(chat)} onClick={() => undo(revert.id)}>undo</button>}
                {error && <span className="warn"> {error}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {rollback && (
        <div className="modal">
          <section className="settings rollback" data-testid="rollback-dialog">
            <h3>Roll back step {rollback.stepKey}</h3>
            {rollback.stage === 'previewing' && <p className="muted">Checking what can be rolled back…</p>}
            {rollback.preview && <PreviewBody preview={rollback.preview} confirm={rollback.confirm} onToggle={(path) => dispatch({ type: 'toggle', path })} />}
            {rollback.stage === 'running' && <p className="muted">Rolling back…</p>}
            {rollback.stage === 'done' && <p>Rolled back.</p>}
            {rollback.error && <p className="warn">{rollback.error}</p>}
            <div className="modal-actions">
              {(rollback.stage === 'confirming') && (
                <button
                  disabled={!canConfirmRollback(rollback)}
                  onClick={() => {
                    const requestId = crypto.randomUUID();
                    if (send({ type: 'step.rollback', requestId, planId: rollback.planId, stepKey: rollback.stepKey, confirm: [...rollback.confirm] })) dispatch({ type: 'run', requestId });
                  }}
                >Roll back</button>
              )}
              <button onClick={() => dispatch({ type: 'close' })}>{rollback.stage === 'done' ? 'Close' : 'Cancel'}</button>
            </div>
          </section>
        </div>
      )}
    </footer>
  );
}

function PreviewBody({ preview, confirm, onToggle }: { preview: RollbackPreview; confirm: ReadonlySet<string>; onToggle: (path: string) => void }) {
  return (
    <>
      {!preview.allowed && <p className="warn">{preview.reason ?? 'This step cannot be rolled back now.'}</p>}
      {preview.autoFiles.length > 0 && (
        <><h4>Rolled back automatically</h4><ul>{preview.autoFiles.map((p) => <li key={p}><code>{p}</code></li>)}</ul></>
      )}
      {preview.confirmFiles.length > 0 && (
        <>
          <h4>Needs your confirmation</h4>
          <ul>
            {preview.confirmFiles.map((p) => (
              <li key={p}><label><input type="checkbox" checked={confirm.has(p)} onChange={() => onToggle(p)} /> <code>{p}</code></label></li>
            ))}
          </ul>
        </>
      )}
      {preview.notRolledBack.length > 0 && (
        <><h4>Not rolled back</h4><ul>{preview.notRolledBack.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">{f.why}</span></li>)}</ul></>
      )}
      {preview.conflicts.length > 0 && (
        <><h4>Conflicts</h4><ul>{preview.conflicts.map((f) => <li key={f.path}><code>{f.path}</code> <span className="warn">{f.reason}</span></li>)}</ul></>
      )}
    </>
  );
}
