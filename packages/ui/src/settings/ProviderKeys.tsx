import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { API_KEY_RULE, type ProviderView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { providerKeyProblem, type ProviderList } from './accounts';
import { Dot, IconButton } from './controls';

type Settled = (error: string | null) => void;

// The core gives up on opencode after 20 s and answers; a request still unanswered well after that was lost with the connection.
const STALLED_MS = 45_000;

const Spinner = () => <span className="bg-tasks-spin" aria-hidden="true">⟳</span>;

// Connected providers first, then by name; every word of the query must appear in the name or the id.
function shown(providers: ProviderView[], query: string): ProviderView[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return providers
    .filter((provider) => words.every((word) => `${provider.name}\n${provider.id}`.toLowerCase().includes(word)))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

const without = <T,>(record: Record<string, T>, id: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));

// Escape empties a field that has text, and leaves an empty one's Escape to Settings.
function escapeEmpties(event: KeyboardEvent<HTMLInputElement>, empty: () => void): void {
  if (event.key !== 'Escape' || event.currentTarget.value === '') return;
  event.preventDefault();
  event.stopPropagation();
  empty();
}

export function ProviderKeys({ accountId, profile, providers, loginCommand, loading, error, busy, onSet, onRemove, onRefresh }: ProviderList & {
  accountId: string;
  profile: string;
  busy: boolean;
  onSet: (provider: ProviderView, key: string, settled: Settled) => void;
  onRemove: (provider: ProviderView, settled: Settled) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  // Whether each key field holds a key; the key itself stays in the field, out of React state and the DOM's value attribute.
  const [keys, setKeys] = useState<Record<string, 'ok' | 'bad'>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ id: string; removing: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fields = useRef(new Map<string, HTMLInputElement>());
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const base = `${useId()}-${accountId}`;

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    // A provider that connects moves to the top; the field the focus is in goes with it and is kept in sight.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && list.current?.contains(focused)) focused.closest('li')?.scrollIntoView({ block: 'nearest' });
  }, [providers]);
  useEffect(() => {
    setStalled(false);
    if (!loading) return;
    const timer = setTimeout(() => setStalled(true), STALLED_MS);
    return () => clearTimeout(timer);
  }, [loading, attempt]);

  const refresh = (): void => {
    setAttempt(attempt + 1);
    onRefresh();
  };
  const judge = (id: string, value: string): void => {
    const key = value.trim();
    setKeys((current) => (key === '' ? without(current, id) : { ...current, [id]: providerKeyProblem(key) === null ? 'ok' : 'bad' }));
    setErrors((current) => without(current, id));
  };
  const empty = (id: string): void => {
    const field = fields.current.get(id);
    if (field) field.value = '';
    judge(id, '');
  };
  const settle = (id: string): Settled => (failure) => {
    setPending(null);
    if (failure !== null) setErrors((current) => ({ ...current, [id]: failure }));
  };
  const save = (provider: ProviderView): void => {
    // Save is enabled only for a key the core takes, so a submit always carries one.
    const key = fields.current.get(provider.id)?.value.trim() ?? '';
    empty(provider.id);
    setPending({ id: provider.id, removing: false });
    onSet(provider, key, settle(provider.id));
  };
  const remove = (provider: ProviderView): void => {
    if (confirming !== provider.id) return setConfirming(provider.id);
    setConfirming(null);
    setErrors((current) => without(current, provider.id));
    setPending({ id: provider.id, removing: true });
    onRemove(provider, settle(provider.id));
  };
  const copy = (id: string): void => {
    const done = (ok: boolean): void => {
      clearTimeout(copyTimer.current);
      setCopied({ id, ok });
      copyTimer.current = setTimeout(() => setCopied(null), 1500);
    };
    if (!navigator.clipboard) return done(false);
    navigator.clipboard.writeText(loginCommand).then(() => done(true), () => done(false));
  };

  // A request on its way hides the last one's error; one that never comes back is an error of its own.
  const problem = loading ? (stalled ? 'opencode did not answer in time.' : null) : error;
  if (problem !== null) {
    return (
      <div className="sw-providers sw-providers-state" tabIndex={-1} data-focus-scope>
        <span className="sw-error" role="alert">{problem}</span>
        <button type="button" className="sw-btn" onClick={refresh}>Try again</button>
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="sw-providers sw-providers-state" tabIndex={-1} data-focus-scope>
        {loading
          ? <span className="muted" role="status"><Spinner /> Loading providers…</span>
          : <><span className="muted">opencode lists no providers.</span><button type="button" className="sw-btn ghost" onClick={refresh}>Check again</button></>}
      </div>
    );
  }

  const rows = shown(providers, query);
  const connected = providers.filter((provider) => provider.connected).length;
  // One button through its steps, so the focus stays on it: the trash icon, then the question, then the removal on its way.
  const removeButton = (provider: ProviderView) => {
    const asking = confirming === provider.id;
    const removing = pending?.id === provider.id && pending.removing;
    const worded = asking || removing;
    return (
      <button
        type="button"
        className={`${worded ? 'sw-btn' : 'sw-icon-btn'} danger sw-provider-remove`}
        title={worded ? undefined : 'Remove the key'}
        aria-label={worded ? undefined : `Remove the ${provider.name} key`}
        disabled={busy}
        onClick={() => remove(provider)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !asking) return;
          event.stopPropagation();
          setConfirming(null);
        }}
        onBlur={() => setConfirming(null)}
      >
        {removing ? 'Removing…' : asking ? 'Remove the key?' : <Icon name="trash" size={16} />}
      </button>
    );
  };

  return (
    <div className="sw-providers" role="group" aria-label={`${profile} providers`} tabIndex={-1} data-focus-scope>
      <div className="sw-providers-head">
        <label className="sw-provider-filter">
          <Icon name="search" size={13} />
          <input
            ref={filter}
            type="search"
            value={query}
            placeholder={`Filter ${providers.length} providers`}
            aria-label="Filter providers"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => escapeEmpties(event, () => setQuery(''))}
          />
          {query !== '' && (
            <button type="button" className="sw-clear" aria-label="Clear the filter" onClick={() => { filter.current?.focus(); setQuery(''); }}>
              <Icon name="close" size={12} />
            </button>
          )}
        </label>
        <span className="sw-providers-count">{connected} connected</span>
        {loading
          ? <span className="sw-icon-btn" role="status" aria-label="Checking providers"><Spinner /></span>
          : <IconButton icon="restart" label="Check providers again" onClick={refresh} />}
      </div>
      <p className="sw-field-help sw-providers-help">A key stays in this profile's opencode home. CodeRay never shows it again.</p>
      {rows.length === 0 ? (
        <p className="sw-empty sw-providers-none">No provider matches “{query.trim()}”.</p>
      ) : (
        <ul ref={list} className="sw-provider-list">
          {rows.map((provider) => {
            const message = errors[provider.id] ?? (keys[provider.id] === 'bad' ? API_KEY_RULE : null);
            const messageId = `${base}-${provider.id}-error`;
            return (
              <li key={provider.id} className="sw-provider-row" data-focus-scope>
                <div className="sw-provider-name">
                  <b>{provider.name}</b>
                  <span className={`sw-provider-state${provider.connected ? ' ok' : ''}`}><Dot tone={provider.connected ? 'ok' : 'muted'} />{provider.connected ? 'connected' : 'not connected'}</span>
                </div>
                {provider.methods.includes('api') ? (
                  <form
                    className="sw-provider-action"
                    onSubmit={(event) => {
                      event.preventDefault();
                      save(provider);
                    }}
                  >
                    <input
                      ref={(field) => {
                        if (field) fields.current.set(provider.id, field);
                        else fields.current.delete(provider.id);
                      }}
                      className="sw-code"
                      type="password"
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore
                      spellCheck={false}
                      placeholder="Paste an API key"
                      aria-label={`${provider.name} API key`}
                      aria-invalid={keys[provider.id] === 'bad'}
                      aria-describedby={message === null ? undefined : messageId}
                      onChange={(event) => judge(provider.id, event.target.value)}
                      onKeyDown={(event) => escapeEmpties(event, () => empty(provider.id))}
                    />
                    <button type="submit" className={`sw-btn${keys[provider.id] === 'ok' ? ' primary' : ''}`} aria-label={`Save ${provider.name} key`} disabled={busy || keys[provider.id] !== 'ok'}>
                      {pending?.id === provider.id && !pending.removing ? 'Saving…' : 'Save'}
                    </button>
                    {provider.connected && removeButton(provider)}
                  </form>
                ) : (
                  <div className="sw-provider-action sw-provider-oauth">
                    <span className="sw-provider-how">Sign in in a terminal</span>
                    <code className="sw-command" tabIndex={0}>{loginCommand}</code>
                    <button type="button" className="sw-btn ghost" onClick={() => copy(provider.id)}>
                      <Icon name={copied?.id !== provider.id ? 'copy' : copied.ok ? 'check' : 'alert'} size={14} />
                      {copied?.id !== provider.id ? 'Copy' : copied.ok ? 'Copied' : 'Copy failed'}
                    </button>
                    {provider.connected && removeButton(provider)}
                  </div>
                )}
                {message !== null && <p id={messageId} className="sw-error sw-provider-error" role="alert">{message}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
