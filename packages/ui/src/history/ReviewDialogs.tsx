import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../layout/Icon';
import { SHORTCUTS } from './review-keys';
import { Kbd } from './ReviewParts';

const FOCUSABLE = 'button:not(:disabled), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

export function Dialog({ label, onClose, children, wide = false }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    if (element && !element.contains(document.activeElement)) (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab' && element) {
        const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected) before.focus();
    };
  }, []);
  return (
    <div className="rv-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panel} className={`rv-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </section>
    </div>
  );
}

export function ConfirmRevert({ paths, moved, outOfPlan, onConfirm, onCancel }: { paths: string[]; moved: boolean; outOfPlan: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog label="Revert file" onClose={onCancel}>
      <h3>{moved ? 'Revert the move of ' : 'Revert '}<code>{paths[paths.length - 1]}</code>?</h3>
      <p className="muted">
        {moved ? `The file goes back to ${paths[0]}.` : `The file goes back to its content before ${outOfPlan ? 'these out-of-plan edits' : 'these changes'}.`}
        {' '}You can undo this right after, or later from the Timeline.
      </p>
      <div className="rv-dialog-actions">
        <button className="rv-btn" onClick={onCancel}>Cancel<Kbd>esc</Kbd></button>
        <button className="rv-btn danger solid" data-autofocus onClick={onConfirm}>Revert<Kbd>↵</Kbd></button>
      </div>
    </Dialog>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose} wide>
      <header className="rv-dialog-head">
        <h3>Keyboard shortcuts</h3>
        <button className="rv-icon" onClick={onClose} aria-label="Close" data-autofocus><Icon name="close" size={16} /></button>
      </header>
      <div className="rv-shortcuts">
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <h4>{group.title}</h4>
            <dl>
              {group.items.map((item) => (
                <div key={item.does}>
                  <dt>{item.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</dt>
                  <dd>{item.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
