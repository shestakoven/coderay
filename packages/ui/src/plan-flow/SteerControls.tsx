import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../layout/Icon';

export const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();

// Text entered on the map: Enter saves, Shift+Enter breaks the line, Esc cancels.
export function Pop({ label, placeholder, initial = '', action, onSave, onCancel, below = false }: {
  label: string;
  placeholder: string;
  initial?: string;
  action: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  below?: boolean;
}) {
  const [text, setText] = useState(initial);
  // Saving an empty text is how an existing comment is cleared.
  const empty = text.trim() === '' && initial === '';
  const submit = (): void => {
    if (!empty) onSave(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className={`pf-pop nodrag nopan nowheel${below ? ' below' : ''}`} onClick={stop} onMouseDown={stop} onDoubleClick={stop} data-testid="steer-pop">
      <div className="pf-pop-label">{label}</div>
      <textarea autoFocus rows={2} placeholder={placeholder} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div className="pf-pop-foot">
        <span><kbd>↵</kbd> {action} · <kbd>esc</kbd> cancel</span>
        <button type="button" className="pf-pop-save" disabled={empty} onClick={submit}>{action}</button>
      </div>
    </div>
  );
}

export function Tool({ tip, kbd, icon, on = false, danger = false, onClick }: { tip: string; kbd?: string; icon: IconName; on?: boolean; danger?: boolean; onClick: (event: MouseEvent) => void }) {
  return (
    <button
      type="button"
      className={`pf-tool${on ? ' on' : ''}${danger ? ' danger' : ''}`}
      data-tip={kbd === undefined ? tip : `${tip}  ${kbd}`}
      aria-label={tip}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

export function Chip({ icon, title, children }: { icon: IconName; title?: string; children: ReactNode }) {
  return (
    <span className="pf-chip" title={title}>
      <Icon name={icon} size={11} />
      <span>{children}</span>
    </span>
  );
}
