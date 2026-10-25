import { ENGINE_PRODUCT_NAMES, type BackgroundAiChoice, type BackgroundAiView, type EngineStatus } from '@ide/protocol';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../layout/Icon';
import { LIMITS_NOTE, stateLabel } from '../settings/background-ai';
import { Dot } from '../settings/controls';
import '../settings/settings.css';
import './onboarding.css';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

const toneOf = (status: EngineStatus | null): 'ok' | 'warn' | 'muted' =>
  status === null || status.state === 'missing' ? 'muted' : status.state === 'ready' ? 'ok' : 'warn';

const skipKeeps = (choice: BackgroundAiChoice): string => {
  if (choice.mode === 'off') return 'Skip keeps the background AI off.';
  if (choice.mode === 'engine') return `Skip keeps ${ENGINE_PRODUCT_NAMES[choice.engine]}.`;
  return 'Skip keeps Auto: the first engine that becomes ready is used.';
};

/** The first-run screen: which engines this machine has, and whether to use them, choose one, or go on without background AI. */
export function Onboarding({ view, onUseFound, onChoose, onWithoutAi, onSkip }: {
  view: BackgroundAiView; onUseFound: () => void; onChoose: () => void; onWithoutAi: () => void; onSkip: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  // The first button takes the focus and, until the reader presses a key or clicks, keeps it as the engines are found and the buttons change.
  const touched = useRef(false);
  const known = view.options.every((option) => option.status !== null);
  const offerFound = known && view.options.some((option) => option.status?.state === 'ready');
  const inUse = view.status.state === 'ready' ? view.status.engine : null;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const opener = node.ownerDocument.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener !== node.ownerDocument.body && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (!touched.current) first.current?.focus();
  }, [offerFound, known]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    touched.current = true;
    // Plain keys stay in the screen, so the shortcuts of the project behind it (F, focus mode) do not fire.
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onSkip();
      return;
    }
    if (event.key !== 'Tab' || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 ? 0 : at + 1);
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <div className="ob-backdrop" onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}>
      <section
        ref={root}
        className="ob"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-title"
        aria-describedby="ob-lead"
        onKeyDown={onKeyDown}
        onPointerDown={() => { touched.current = true; }}
      >
        <header className="ob-head">
          <span className="ob-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
          <h2 id="ob-title">Background AI</h2>
        </header>
        <p id="ob-lead" className="ob-lead">
          CodeRay groups the project map and writes summaries with an AI engine already on this machine. It never edits files or runs tools, and chat and the map work without one.
        </p>
        <ul className="ob-engines" aria-label="Engines on this machine" aria-live="polite" aria-busy={!known}>
          {view.options.length === 0 && <li className="ob-engine none">This CodeRay runs no AI engine.</li>}
          {view.options.map(({ engine, status }) => (
            <li key={engine} className={`ob-engine ${status?.state ?? 'checking'}`}>
              <Dot tone={toneOf(status)} />
              <span className="ob-engine-name">{ENGINE_PRODUCT_NAMES[engine]}</span>
              <span className="ob-engine-state">
                {stateLabel(status)}
                {engine === inUse && status?.state === 'ready' && <span className="ob-in-use">In use</span>}
              </span>
              {status?.hint && <span className="ob-engine-hint">{status.hint}</span>}
            </li>
          ))}
        </ul>
        <div className="ob-actions">
          {offerFound && <button ref={first} type="button" className="sw-btn primary" onClick={onUseFound}>Use what's found</button>}
          <button ref={offerFound ? undefined : first} type="button" className="sw-btn" onClick={onChoose}>Choose an engine…</button>
          {known && <button type="button" className="sw-btn" onClick={onWithoutAi}>Continue without AI</button>}
          <button type="button" className="sw-btn ghost ob-skip" onClick={onSkip}>Skip</button>
        </div>
        <p className="ob-foot">{LIMITS_NOTE} {skipKeeps(view.choice)} Change this any time in Settings → Background AI.</p>
      </section>
    </div>
  );
}
