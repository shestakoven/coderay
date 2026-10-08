import { useEffect, useRef, useState } from 'react';
import { Icon } from '../layout/Icon';
import { GROUP_LABEL, GROUP_ORDER, type Item } from './steer';

const GROUP_ICON = { note: 'comment', ask: 'plus' } as const;

export type BarPhase = 'idle' | 'sending';

// The answer to a waiting plan: approve it, or send what was collected on the map.
export function SteerBar({ phase, working, version, steps, files, items, canUndo, text, onUndo, onReset, onRemove, onSend, onApprove }: {
  phase: BarPhase;
  // Whether the agent has a turn open: the spinner is only honest while it does.
  working: boolean;
  version: number;
  steps: number;
  files: number;
  items: readonly Item[];
  canUndo: boolean;
  text: string;
  onUndo: () => void;
  onReset: () => void;
  onRemove: (index: number) => void;
  onSend: () => void;
  onApprove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = items.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);

  if (phase === 'sending') {
    return (
      <div className="pf-bar sending" data-testid="steer-bar" data-phase="sending" role="status">
        {working ? <span className="pf-spin" /> : <span className="pf-bar-dot still" />}
        <span className="pf-bar-text"><b>Sent to the agent</b> · {working ? 'it is revising the plan…' : 'it is not working on the plan now'}</span>
      </div>
    );
  }
  return (
    <div className={`pf-bar${count > 0 ? ' dirty' : ''}`} ref={box} data-testid="steer-bar" data-phase="idle">
      {open && count > 0 && (
        <div className="pf-draft" data-testid="steer-draft">
          <div className="pf-draft-head">
            <span>What the agent will receive</span>
            <button type="button" className={`pf-link${raw ? ' on' : ''}`} onClick={() => setRaw(!raw)}>{raw ? 'List' : 'Message'}</button>
          </div>
          {raw ? (
            <pre className="pf-draft-raw" data-testid="steer-message">{text}</pre>
          ) : (
            GROUP_ORDER.map((group) => {
              const inGroup = items.filter((item) => item.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div className="pf-draft-group" key={group}>
                  <div className="pf-draft-label">{GROUP_LABEL[group]}</div>
                  {inGroup.map((item) => (
                    <div className={`pf-draft-row ${group}`} key={item.index} data-testid="steer-item">
                      <span className="pf-draft-ic"><Icon name={GROUP_ICON[group]} size={12} /></span>
                      <span className="pf-draft-body">
                        <span className="pf-draft-title">{item.title}</span>
                        <span className="pf-draft-detail">{item.detail}</span>
                      </span>
                      <button type="button" className="pf-draft-x" aria-label="Remove this change" onClick={() => onRemove(item.index)}><Icon name="close" size={12} /></button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
      {count === 0 ? (
        <>
          <span className="pf-bar-dot" />
          <span className="pf-bar-text"><b>Plan v{version}</b> · {steps} step{steps === 1 ? '' : 's'} · {files} file{files === 1 ? '' : 's'}</span>
          <span className="pf-bar-hint"><Icon name="info" size={12} /> Point at a part to comment on it or add to it</span>
          <button type="button" className="pf-btn primary" onClick={onApprove} data-testid="steer-approve">Approve plan</button>
        </>
      ) : (
        <>
          <button type="button" className={`pf-changes${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="steer-changes">
            <span className="pf-count">{count}</span>
            <span>{count === 1 ? 'change' : 'changes'}</span>
            <Icon name={open ? 'minus' : 'plus'} size={11} />
          </button>
          <button type="button" className="pf-icon-btn" onClick={onUndo} disabled={!canUndo} data-tip="Undo  ⌘Z" aria-label="Undo"><Icon name="undo" size={14} /></button>
          <button type="button" className="pf-link" onClick={onReset}>Reset</button>
          <span className="pf-bar-sep" />
          <button type="button" className="pf-btn ghost" onClick={onApprove} title="Approves the plan as it is and drops these changes">Approve as is</button>
          <button type="button" className="pf-btn primary" onClick={onSend} data-testid="steer-send">Send to agent <kbd>⌘↵</kbd></button>
        </>
      )}
    </div>
  );
}
