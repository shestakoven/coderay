import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatPick, ClientMessage, EngineState, EngineStatus, ModelInfo } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { storage } from '../layout/dom';
import { useDismiss } from '../project/use-dismiss';
import { configureMessage, modelLabel } from './chats';
import {
  catalogOf, chooseMessage, effortChoices, indexOfKey, initialActive, loadRecent, matchSpans, menuKey, pickerGroups, rememberModel, rowKeys, saveRecent, shownId, type PickerRow,
} from './model-picker';

const RESTART_WAIT_MS = 1500;
const NEW_CHAT = 'New chat with this model';

const STATE_LABEL: Record<Exclude<EngineState, 'ready'>, string> = { missing: 'not found', old: 'too old', 'signed-out': 'signed out', error: 'error' };

const marked = (text: string, query: string): ReactNode =>
  matchSpans(text, query).map((span, index) => (span.hit ? <u key={index}>{span.text}</u> : <Fragment key={index}>{span.text}</Fragment>));

export function ModelControls({ current, models, engines, started, enabled, send, onMenu, onChosen }: {
  current: ChatPick | null;
  models: ModelInfo[];
  engines: EngineStatus[];
  started: boolean;
  enabled: boolean;
  send: (message: ClientMessage) => boolean;
  onMenu?: (open: boolean) => void;
  /** Takes the focus when the menu closes away from its button: after a choice, or when the agent gets busy while it is open. */
  onChosen?: () => void;
}) {
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [open, setOpen] = useState<{ query: string } | null>(null);
  const [recent, setRecent] = useState(() => loadRecent(storage()));
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const catalog = useMemo(() => catalogOf(models), [models]);
  const settled = `${current?.modelChoice ?? ''}|${current?.effort ?? ''}`;
  const disabled = !enabled || sentAt !== null;
  const menuOpen = open !== null;
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), RESTART_WAIT_MS);
    return () => clearTimeout(timer);
  }, [sentAt, settled]);
  useEffect(() => {
    if (!disabled || !menuOpen) return;
    const focused = root.current?.querySelector('.model-menu')?.contains(document.activeElement) ?? false;
    setOpen(null);
    if (focused) onChosen?.();
  }, [disabled]);
  useEffect(() => {
    if (!menuOpen) return;
    onMenu?.(true);
    return () => onMenu?.(false);
  }, [menuOpen, onMenu]);
  const sent = (message: ClientMessage): void => {
    if (send(message)) setSentAt(Date.now());
  };
  const close = useCallback((refocus: boolean): void => {
    setOpen(null);
    if (refocus) button.current?.focus();
  }, []);
  const choose = (row: PickerRow): void => {
    const next = rememberModel(recent, row.model.value);
    setRecent(next);
    saveRecent(storage(), next);
    close(false);
    onChosen?.();
    const message = chooseMessage(row, current);
    if (message !== null) sent(message);
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (menuOpen || disabled) return;
    const typed = event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (!typed && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen({ query: typed ? event.key : '' });
  };
  const model = catalog.find((item) => item.value === current?.modelChoice);
  const efforts = effortChoices(model, current?.engine ?? null, current?.effort ?? null);
  // The model takes no effort, yet claude is still sent the chat's: shown, not offered.
  const fixedEffort = model !== undefined && model.efforts.length === 0;
  const label = current?.modelChoice ? modelLabel(current.modelChoice, models) : 'Select model';
  const title = disabled ? 'Wait for the agent to finish, or press Stop, before changing the model.' : 'Applies to this chat. The model switches in the running agent; an effort change restarts it and resumes the conversation.';
  return (
    <span className="model-controls" ref={root}>
      <button
        ref={button}
        type="button"
        className={`model-button${current === null ? ' needed' : ''}`}
        data-menu-anchor
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label={`Model: ${label}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(menuOpen ? null : { query: '' })}
        onKeyDown={onButtonKey}
      >
        <span className="model-button-label">{label}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && <ModelMenu models={catalog} engines={engines} current={current} started={started} recent={recent} initialQuery={open.query} onChoose={choose} onClose={close} />}
      {current !== null && efforts.length > 0 && (
        <select
          aria-label="Effort"
          title={fixedEffort ? 'This model lists no effort levels; the chat keeps its own.' : title}
          disabled={disabled || fixedEffort}
          value={current.effort ?? ''}
          onChange={(event) => sent(configureMessage(current, { effort: event.target.value }))}
        >
          {current.effort === null && <option value="" disabled>Select effort</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      )}
    </span>
  );
}

export function ModelMenu({ models, engines, current, started, recent, initialQuery, onChoose, onClose }: {
  models: ModelInfo[];
  engines: EngineStatus[];
  current: ChatPick | null;
  started: boolean;
  recent: string[];
  initialQuery: string;
  onChoose: (row: PickerRow) => void;
  onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const engine = current?.engine ?? null;
  const currentModel = current?.modelChoice ?? null;
  const groups = useMemo(() => pickerGroups({ models, engines, engine, current: currentModel, started, query, recent }), [models, engines, engine, currentModel, started, query, recent]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const keys = useMemo(() => rowKeys(groups), [groups]);
  // By key, not place: claude's list can replace the built-in one under an open menu, and Enter must take the row the user sees.
  const [activeKey, setActiveKey] = useState(() => keys[initialQuery === '' ? initialActive(groups, currentModel) : 0] ?? null);
  const selected = indexOfKey(keys, activeKey);
  const selectedKey = keys[selected] ?? null;
  // When its row is gone, or the query changed, the first row takes over, by its own key from then on.
  if (selectedKey !== activeKey) setActiveKey(selectedKey);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // The list follows the active row as the keys or the query move it, never as the mouse does: it would scroll away under the pointer.
  const follow = useRef(true);
  useDismiss(root, useCallback((reason: 'escape' | 'outside') => onClose(reason === 'escape'), [onClose]));
  useEffect(() => {
    const row = list.current?.querySelector('.model-row.sel');
    if (!row || !follow.current) return;
    // The first row of a group brings its engine's header into view with it.
    if (row === row.parentElement?.firstElementChild) row.parentElement?.previousElementSibling?.scrollIntoView({ block: 'nearest' });
    row.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const action = menuKey(event, selected, rows.length, query);
    if (action === null) return;
    event.preventDefault();
    if (action === 'close') {
      // Closing removes the search box before the browser moves the focus, which would then fall to the page itself.
      onClose(true);
    } else if (action === 'choose') {
      const row = rows[selected];
      if (row) onChoose(row);
    } else {
      follow.current = true;
      setActiveKey(keys[action.move] ?? null);
    }
  };
  const optionId = (at: number): string => `${id}-option-${at}`;
  let index = -1;
  return (
    // A press anywhere in the menu but the search box leaves the focus in it, so the keys go on working.
    <div className="model-menu" role="dialog" aria-label="Choose a model" ref={root} data-testid="model-menu" onMouseDown={(event) => {
      if (event.target !== search.current) event.preventDefault();
    }}>
      <div className="model-search">
        <Icon name="search" size={14} />
        <input
          ref={search}
          autoFocus
          role="combobox"
          aria-label="Search models"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? optionId(selected) : undefined}
          placeholder="Search models"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
          onChange={(event) => {
            setQuery(event.target.value);
            follow.current = true;
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="model-list" ref={list}>
        <div id={`${id}-list`} role="listbox" aria-label="Models">
          {groups.map((group) => (
            <div key={group.id} className="model-group" role="presentation">
              <div className="model-group-head" id={`${id}-${group.id}`} aria-hidden="true">
                <span className="model-engine">{group.title}</span>
                {group.status?.account && (
                  <>
                    <span className="visually-hidden">, account </span>
                    <span className="model-account" title={`${group.title} runs under ${group.status.account}`}>{group.status.account}</span>
                  </>
                )}
                {group.status && group.status.state !== 'ready' && <span className={`model-state ${group.status.state}`}>{STATE_LABEL[group.status.state]}</span>}
                {group.status?.hint && <span className="model-hint">{group.status.hint}</span>}
              </div>
              <div role="group" aria-labelledby={`${id}-${group.id}`}>
                {group.rows.map((row) => {
                  index += 1;
                  const at = index;
                  const key = keys[at] ?? null;
                  const modelId = shownId(row.model);
                  const isCurrent = row.model.value === currentModel;
                  return (
                    <div
                      key={key}
                      id={optionId(at)}
                      role="option"
                      aria-selected={at === selected}
                      className={`model-row${at === selected ? ' sel' : ''}${row.locked ? ' locked' : ''}`}
                      title={row.locked ? NEW_CHAT : row.model.value}
                      onMouseMove={() => {
                        follow.current = false;
                        setActiveKey(key);
                      }}
                      onMouseDown={(event) => {
                        if (event.button === 0) onChoose(row);
                      }}
                    >
                      <span className="model-check">{isCurrent && <Icon name="check" size={14} />}</span>
                      <span className="model-name">{marked(row.model.name, query)}</span>
                      {row.locked ? <span className="model-new">New chat<span className="model-new-tail"> with this model</span></span> : modelId !== null && <span className="model-id">{marked(modelId, query)}</span>}
                      {isCurrent && <span className="visually-hidden"> (current)</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {/* Mounted while empty, so that a screen reader announces the text when it appears. */}
        <div className="model-empty" role="status">{groups.length === 0 && query.trim() !== '' ? `No model matches “${query.trim()}”` : ''}</div>
      </div>
      <div className="model-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>↵</kbd>choose</span><span><kbd>esc</kbd>close</span></div>
    </div>
  );
}
