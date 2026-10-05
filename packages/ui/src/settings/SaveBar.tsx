import { useState } from 'react';
import { Icon } from '../layout/Icon';
import type { PolicyChange } from './policy-form';
import { SCOPE_LABEL } from './policy-form';

export interface Toast {
  id: number;
  tone: 'ok' | 'error';
  text: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <>
      {toasts.map((toast) => (
        <div key={toast.id} className={`sw-toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={toast.tone === 'ok' ? 'check' : 'alert'} size={16} />
          <span>{toast.text}</span>
          <button type="button" className="sw-icon-btn" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </>
  );
}

export function SaveBar({ changes, saving, error, closing, onSave, onDiscard, onKeepEditing, onDiscardAndClose }: {
  changes: PolicyChange[];
  saving: boolean;
  error: string | null;
  closing: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onKeepEditing: () => void;
  onDiscardAndClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = changes.length;
  const noun = count === 1 ? 'unsaved change' : 'unsaved changes';
  return (
    <div className="sw-savebar" role="region" aria-label="Unsaved changes">
      {(open || closing) && (
        <ul className="sw-savebar-list">
          {changes.map((change) => (
            <li key={`${change.level}-${change.field}`}>
              <span className="scope">{SCOPE_LABEL[change.level]}</span>
              <span className="text">{change.text}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="sw-savebar-note" role="alert">{error}</p>}
      <div className="sw-savebar-row">
        {closing ? (
          <>
            <span><i className="sw-savebar-dot" /> Close and lose {count === 1 ? 'this change' : `these ${count} changes`}?</span>
            <span className="sw-savebar-spacer" />
            <button type="button" className="sw-btn ghost" onClick={onKeepEditing}>Keep editing</button>
            <button type="button" className="sw-btn danger" onClick={onDiscardAndClose}>Discard and close</button>
          </>
        ) : (
          <>
            <button type="button" className="sw-savebar-count" aria-expanded={open} onClick={() => setOpen(!open)}>
              <i className="sw-savebar-dot" />
              {count} {noun}
              <Icon name="chevron-up" size={14} />
            </button>
            <span className="sw-savebar-spacer" />
            <button type="button" className="sw-btn ghost" disabled={saving} onClick={onDiscard}>Discard</button>
            <button type="button" className="sw-btn primary" disabled={saving || error !== null} onClick={onSave}>{saving ? 'Saving…' : 'Save changes'}</button>
          </>
        )}
      </div>
    </div>
  );
}
