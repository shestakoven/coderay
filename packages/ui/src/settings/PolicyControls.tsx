import { useRef, useState, type KeyboardEvent } from 'react';
import type { ControlMode, PolicyLevel } from '@ide/protocol';
import { Icon, type IconName } from '../layout/Icon';
import { Segmented, Toggle } from './controls';
import { addPattern, removePattern, replacePattern, type PathListField } from './path-rules';
import { MODE_LABEL, MODE_SUMMARY, MODE_WHEN, SCOPE_LABEL, autoApproveError, joinLines, lines } from './policy-form';

export function ScopeSwitch({ scope, onChange }: { scope: PolicyLevel; onChange: (scope: PolicyLevel) => void }) {
  return (
    <Segmented
      label="Where these settings apply"
      value={scope}
      onChange={onChange}
      options={[
        { value: 'project', label: SCOPE_LABEL.project, hint: 'Values for this project only; anything you leave alone follows All projects' },
        { value: 'ide', label: SCOPE_LABEL.ide, hint: 'The defaults every project starts from' },
      ]}
    />
  );
}

// Says where the value on screen comes from, and offers the way back to the inherited one.
export function Provenance({ scope, pinned, overriddenHere, onReset, onShowProject }: {
  scope: PolicyLevel;
  pinned: boolean;
  overriddenHere: boolean;
  onReset: () => void;
  onShowProject: () => void;
}) {
  if (scope === 'project') {
    return pinned ? (
      <span className="sw-origin set">
        <i /> Set for this project
        <button type="button" className="sw-link" onClick={onReset}><Icon name="undo" size={13} /> Reset to inherited</button>
      </span>
    ) : (
      <span className="sw-origin inherited"><Icon name="link" size={13} /> Inherited from all projects</span>
    );
  }
  return overriddenHere ? (
    <span className="sw-origin overridden">
      <i /> This project uses its own value
      <button type="button" className="sw-link" onClick={onShowProject}>Show</button>
    </span>
  ) : (
    <span className="sw-origin inherited"><Icon name="globe" size={13} /> Applies to every project</span>
  );
}

const MODE_ICON: Record<ControlMode, IconName> = { A: 'shield', B: 'help', C: 'flag' };
const MODES = ['A', 'B', 'C'] as const;

export function ModeCards({ value, onChange }: { value: ControlMode; onChange: (mode: ControlMode) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + MODES.length) % MODES.length;
    onChange(MODES[next]!);
    (group.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div ref={group} className="sw-modes" role="radiogroup" aria-label="When the agent writes outside the plan">
      {MODES.map((mode, index) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          tabIndex={value === mode ? 0 : -1}
          className={`sw-mode${value === mode ? ' on' : ''}`}
          onClick={() => onChange(mode)}
          onKeyDown={(event) => move(event, index)}
        >
          <span className="sw-mode-head">
            <span className="sw-mode-icon"><Icon name={MODE_ICON[mode]} size={16} /></span>
            <b>{MODE_LABEL[mode]}</b>
            <span className="sw-mode-check"><Icon name="check" size={14} /></span>
          </span>
          <span className="sw-mode-text">{MODE_SUMMARY[mode]}</span>
          <span className="sw-mode-when">{MODE_WHEN[mode]}</span>
        </button>
      ))}
    </div>
  );
}

const DEFAULT_LIMIT = 3;

export function AutoApprove({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const remembered = useRef(DEFAULT_LIMIT);
  const error = autoApproveError(value);
  const number = Number(value.trim());
  const on = error !== null || number > 0;
  if (error === null && number > 0) remembered.current = number;
  const step = (delta: number): void => onChange(String(Math.min(50, Math.max(0, (error ? 0 : number) + delta))));
  return (
    <div className="sw-auto">
      <div className="sw-auto-row">
        <Toggle checked={on} label="Approve small plans automatically" onChange={(next) => onChange(next ? String(remembered.current) : '0')} />
        <span className="sw-auto-label">{on ? 'Plans touching up to' : 'Off — every plan waits for you'}</span>
        {on && (
          <>
            <span className="sw-stepper">
              <button type="button" aria-label="Fewer files" disabled={!error && number <= 1} onClick={() => step(-1)}>−</button>
              <input
                value={value}
                inputMode="numeric"
                aria-label="Number of files"
                aria-invalid={error !== null}
                onChange={(event) => onChange(event.target.value)}
              />
              <button type="button" aria-label="More files" disabled={!error && number >= 50} onClick={() => step(1)}>+</button>
            </span>
            <span className="sw-auto-label">files</span>
          </>
        )}
      </div>
      {error && <p className="sw-error" role="alert">{error}</p>}
    </div>
  );
}

const PLACEHOLDER: Record<PathListField, string> = {
  guarded: 'Add a pattern, e.g. secrets/**',
  harness: 'Add a pattern, e.g. .cache/',
  outsideAllowed: 'Add a folder, e.g. ~/notes/',
};

export function PathList({ field, text, onChange }: { field: PathListField; text: string; onChange: (text: string) => void }) {
  const items = lines(text);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const commit = (list: string[]): void => onChange(joinLines(list));

  const add = (raw: string): void => {
    let list = items;
    for (const piece of raw.split('\n')) {
      if (piece.trim() === '') continue;
      const result = addPattern(field, list, piece);
      if ('error' in result) {
        setError(result.error);
        setDraft(piece);
        if (list !== items) commit(list);
        return;
      }
      list = result.list;
    }
    commit(list);
    setDraft('');
    setError(null);
  };
  const finishEdit = (): void => {
    if (!editing) return;
    if (editing.value.trim() === items[editing.index]) {
      setEditing(null);
      setEditError(null);
      return;
    }
    const result = replacePattern(field, items, editing.index, editing.value);
    if ('error' in result) {
      setEditError(result.error);
      return;
    }
    commit(result.list);
    setEditing(null);
    setEditError(null);
  };
  const cancelEdit = (): void => {
    setEditing(null);
    setEditError(null);
  };

  return (
    <div className="sw-paths">
      {items.length === 0 ? (
        <p className="sw-empty">Nothing listed yet.</p>
      ) : (
        <ul className="sw-chips">
          {items.map((item, index) => (
            <li key={item} className={`sw-chip${editing?.index === index ? ' editing' : ''}`}>
              {editing?.index === index ? (
                <input
                  autoFocus
                  className="sw-chip-input"
                  value={editing.value}
                  size={Math.max(8, editing.value.length + 1)}
                  aria-label={`Edit ${item}`}
                  aria-invalid={editError !== null}
                  onChange={(event) => setEditing({ index, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      finishEdit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => (editError ? cancelEdit() : finishEdit())}
                />
              ) : (
                <button type="button" className="sw-chip-text" title="Click to edit" onClick={() => setEditing({ index, value: item })}>{item}</button>
              )}
              <button type="button" className="sw-chip-x" aria-label={`Remove ${item}`} title="Remove" onMouseDown={(event) => event.preventDefault()} onClick={() => commit(removePattern(items, index))}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editError && <p className="sw-error" role="alert">{editError}</p>}
      <div className="sw-add">
        <input
          value={draft}
          placeholder={PLACEHOLDER[field]}
          aria-label="Add a pattern"
          aria-invalid={error !== null}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (!pasted.includes('\n')) return;
            event.preventDefault();
            add(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(draft);
            } else if (event.key === 'Escape' && draft !== '') {
              event.stopPropagation();
              setDraft('');
              setError(null);
            }
          }}
        />
        <button type="button" className="sw-btn" disabled={draft.trim() === ''} onClick={() => add(draft)}><Icon name="plus" size={14} /> Add</button>
      </div>
      {error && <p className="sw-error" role="alert">{error}</p>}
    </div>
  );
}
