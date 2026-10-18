import { Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  API_KEY_PATTERN, ENGINE_NAMES, LOGIN_METHODS, type AccountLoginView, type ClientMessage, type EngineAccountsView, type EngineId, type LoginMethod,
} from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { methodLabel, profileNameProblem, SYSTEM_NOTE, type ProviderList } from './accounts';
import { ProviderKeys } from './ProviderKeys';
import type { RunOptions } from './requests';

const Spinner = () => <span className="bg-tasks-spin" aria-hidden="true">⟳</span>;

const ASKED: ProviderList = { loading: true, providers: [], loginCommand: '', error: null };
// A key change starts opencode under the profile, which can take longer than the usual answer.
const PROVIDER_TIMEOUT_MS = 60_000;
const FOCUSABLE = 'input:not(:disabled), button:not(:disabled)';

export function AccountsSection({ engine, view, login, busy, onRequest, providers = {}, open = null, onProviders }: {
  engine: EngineId;
  view: EngineAccountsView;
  login: AccountLoginView;
  busy: boolean;
  onRequest: (message: ClientMessage & { requestId: string }, options?: RunOptions) => void;
  /** An opencode profile's providers, by profile id. */
  providers?: Record<string, ProviderList>;
  /** The profile whose providers are shown. */
  open?: string | null;
  /** Shows a profile's providers and asks the core for them again, or hides them (null). */
  onProviders?: (id: string | null) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [nameForm, setNameForm] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  // The code and the key stay out of React state: a controlled input writes its value into the DOM's value attribute.
  const [hasCode, setHasCode] = useState(false);
  const [keyForm, setKeyForm] = useState(false);
  const [key, setKey] = useState<'empty' | 'ok' | 'bad'>('empty');
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyId = useId();
  const keyInput = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<{ element: HTMLElement; inList: boolean; scope: HTMLElement | null } | null>(null);
  const began = useRef<LoginMethod | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // A field's flag goes with the field, so one shown again, empty, never keeps a Submit enabled or an error from before.
  const codeField = useCallback((input: HTMLInputElement | null) => {
    codeInput.current = input;
    if (input === null) setHasCode(false);
  }, []);
  const keyField = useCallback((input: HTMLInputElement | null) => {
    keyInput.current = input;
    if (input === null) setKey('empty');
  }, []);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const name = ENGINE_NAMES[engine];
  // A login view without an engine comes from a core before engine-scoped accounts: it is Claude's.
  // A profile is made at once: the moment its view waits is no sign-in to show.
  const loginEngine = login.state === 'idle' || login.method === 'profile' ? null : (login.engine ?? 'claude');
  const mine = loginEngine === engine;
  // Only a running sign-in blocks the others; a failed one waits for its Retry or Dismiss without holding them up.
  const running = login.state === 'waiting' || login.state === 'checking';
  const elsewhere = running && loginEngine !== null && !mine ? ENGINE_NAMES[loginEngine] : null;
  useEffect(() => {
    // The page button stays disabled until the engine gives its address: the focus waits on the code field or Cancel, then moves to it.
    if (!mine || login.state !== 'waiting' || login.url === null) return;
    if (document.activeElement === (codeInput.current ?? cancelButton.current)) primary.current?.focus();
  }, [mine, login.state, login.url]);
  useEffect(() => {
    const leave = (event: FocusEvent): void => {
      if (!section.current?.contains(event.target as Node)) lastFocus.current = null;
    };
    document.addEventListener('focusin', leave);
    return () => {
      document.removeEventListener('focusin', leave);
      clearTimeout(copyTimer.current);
    };
  }, []);
  useEffect(() => {
    // A control disabled by a request in flight, or gone with its step, drops the focus to <body>: it comes back here once a control can take it.
    const last = lastFocus.current;
    const root = section.current;
    if (last === null || root === null || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const find = (selector: string) => root.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
    // A control gone or disabled inside a provider's row or panel gives the focus to the first control there that can take it, else to the panel.
    const gone = !last.element.isConnected || (last.element as HTMLButtonElement).disabled;
    const scope = gone && last.scope?.isConnected ? last.scope : null;
    const scoped = scope && (scope.querySelector<HTMLInputElement | HTMLButtonElement>(FOCUSABLE) ?? (scope.hasAttribute('tabindex') ? (scope as HTMLButtonElement) : null));
    const target = scoped ?? (last.element.isConnected
      ? (last.element as HTMLButtonElement)
      : last.inList
        ? find('input[type="radio"]:checked')
        : find('[data-landing]') ?? find(`.account-add[data-method="${began.current}"]`) ?? find('.account-add'));
    if (target && !target.disabled) target.focus();
  });
  const rows = [
    { id: null, label: 'System', plan: null },
    ...view.accounts.map((account) => ({ id: account.id, label: account.email, plan: account.plan ?? null })),
  ];
  const active = rows.find((row) => row.id === view.activeId) ?? rows[0]!;
  const requestId = (): string => crypto.randomUUID();
  const send = (message: ClientMessage & { requestId: string }, options?: RunOptions): void => {
    setConfirming(null);
    onRequest(message, options);
  };
  const start = (method: LoginMethod, apiKey?: string): void =>
    send({ type: 'account.login.start', requestId: requestId(), engine, method, ...(apiKey === undefined ? {} : { apiKey }) });
  const cancel = (): void => send({ type: 'account.login.cancel', requestId: requestId() });
  // Escape cancels a sign-in that waits or is checked, not the whole Settings dialog.
  const escapeCancels = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  const remove = (id: string): void => {
    if (confirming !== id) setConfirming(id);
    else send({ type: 'account.remove', requestId: requestId(), engine, id });
  };
  const closeName = (): void => {
    setNameForm(false);
    setProfileName('');
    setNameError(null);
  };
  const typedProblem = profileName.trim() === '' ? null : profileNameProblem(profileName);
  // Create is enabled only for a name the core takes; the core trims it, and on the wire it rides in `apiKey`.
  const submitName = (): void =>
    send(
      { type: 'account.login.start', requestId: requestId(), engine, method: 'profile', apiKey: profileName },
      { inline: true, onSettled: (error) => (error === null ? closeName() : setNameError(error)) },
    );
  const closeKey = (): void => {
    if (keyInput.current) keyInput.current.value = '';
    setKeyForm(false);
    setKey('empty');
  };
  const submitKey = (): void => {
    const value = keyInput.current?.value.trim() ?? '';
    // The core answers a malformed key with an error no request waits for, so the form checks the key first.
    if (!API_KEY_PATTERN.test(value)) return;
    start('api-key', value);
    closeKey();
  };
  const submitCode = (): void => {
    const value = codeInput.current?.value.trim() ?? '';
    if (value === '') return;
    send({ type: 'account.login.code', requestId: requestId(), code: value });
    codeInput.current!.value = '';
    setHasCode(false);
  };
  const copyCode = (): void => {
    const settle = (result: 'done' | 'failed'): void => {
      clearTimeout(copyTimer.current);
      setCopy(result);
      copyTimer.current = setTimeout(() => setCopy('idle'), 1500);
    };
    if (!navigator.clipboard) return settle('failed');
    navigator.clipboard.writeText(login.userCode ?? '').then(() => settle('done'), () => settle('failed'));
  };
  const openPage = (url: string | null): void => {
    if (url) window.open(url, '_blank', 'noopener');
  };
  const retry = (): void => {
    if (login.method !== 'api-key') return start(login.method ?? LOGIN_METHODS[engine][0] ?? 'browser');
    // The key form shows once the failed attempt is gone; the key itself is never kept to resend.
    cancel();
    setKeyForm(true);
  };

  return (
    <div
      ref={section}
      className="sw-accounts accounts"
      onFocus={(event) => {
        lastFocus.current = { element: event.target, inList: event.target.closest('[role="radiogroup"]') !== null, scope: event.target.closest<HTMLElement>('[data-focus-scope]') };
      }}
    >
      <p className="sw-account-note">
        {active.label} is active. A switch applies to every project from the next agent start and begins a fresh {name} conversation.
      </p>
      <div role="radiogroup" aria-label={`${name} account`} className="sw-list">
        {rows.map((row) => {
          const on = view.activeId === row.id;
          const profile = engine === 'opencode' && row.id !== null ? row.id : null;
          const removing = confirming === row.id;
          return (
            <Fragment key={row.id ?? 'system'}>
              <div className={`sw-account${on ? ' on' : ''}`}>
                <label className="account-choice sw-account-choice">
                  <input
                    type="radio"
                    name={`${engine}-account`}
                    checked={on}
                    disabled={busy}
                    onChange={() => send({ type: 'account.select', requestId: requestId(), engine, id: row.id })}
                  />
                  <span className="sw-avatar" aria-hidden="true" data-initial={row.id === null ? undefined : row.label.charAt(0).toUpperCase()}>
                    {row.id === null && <Icon name="terminal" size={14} />}
                  </span>
                  <b>{row.label}</b>
                </label>
                {row.id === null && <span className="muted sw-account-sub">{SYSTEM_NOTE[engine]}</span>}
                {row.plan !== null && <span className="muted sw-account-sub">{row.plan}</span>}
                {on && <span className="sw-tag sw-active">active</span>}
                {row.id !== null && (
                  <span className="sw-account-actions">
                    {profile !== null && (
                      <button
                        type="button"
                        className="sw-btn ghost sw-disclosure"
                        aria-expanded={open === profile}
                        aria-controls={open === profile ? `${keyId}-providers` : undefined}
                        onClick={() => onProviders?.(open === profile ? null : profile)}
                      >
                        <Icon name={open === profile ? 'chevron-down' : 'chevron-right'} size={14} /> Providers
                      </button>
                    )}
                    <button
                      type="button"
                      className={`sw-btn ghost account-remove${removing ? ' confirm' : ''}`}
                      disabled={busy}
                      title={profile !== null
                        ? (removing ? 'Click again to delete this profile and its provider keys' : 'Remove this profile')
                        : (removing ? 'Click again to sign this account out and delete its credentials' : 'Remove this account')}
                      onClick={() => remove(row.id)}
                    >
                      {removing ? (profile !== null ? 'Remove profile?' : 'Remove sign-in?') : 'Remove'}
                    </button>
                  </span>
                )}
              </div>
              {profile !== null && open === profile && (
                <div id={`${keyId}-providers`} className="sw-account-detail">
                  <ProviderKeys
                    {...(providers[profile] ?? ASKED)}
                    accountId={profile}
                    profile={row.label}
                    busy={busy}
                    onRefresh={() => onProviders?.(profile)}
                    onSet={(provider, apiKey, settled) => send(
                      { type: 'account.provider.set', requestId: requestId(), id: profile, providerID: provider.id, apiKey },
                      { inline: true, timeoutMs: PROVIDER_TIMEOUT_MS, okText: `${provider.name} key saved`, onSettled: settled },
                    )}
                    onRemove={(provider, settled) => send(
                      { type: 'account.provider.remove', requestId: requestId(), id: profile, providerID: provider.id },
                      { inline: true, timeoutMs: PROVIDER_TIMEOUT_MS, okText: `${provider.name} key removed`, onSettled: settled },
                    )}
                  />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {!mine && !keyForm && !nameForm && (
        <>
          <div className="sw-login-row">
            {LOGIN_METHODS[engine].map((method, index) => (
              <button
                key={method}
                type="button"
                className={`sw-btn${index === 0 ? '' : ' ghost'} account-add`}
                data-method={method}
                disabled={busy || elsewhere !== null}
                aria-describedby={elsewhere !== null ? `${keyId}-why` : undefined}
                onClick={() => {
                  began.current = method;
                  if (method === 'api-key') setKeyForm(true);
                  else if (method === 'profile') setNameForm(true);
                  else start(method);
                }}
              >
                {index === 0 && <Icon name="plus" size={14} />} {methodLabel(engine, method)}
              </button>
            ))}
          </div>
        </>
      )}
      {keyForm && !mine && (
        <form
          className="sw-login"
          onSubmit={(event) => {
            event.preventDefault();
            submitKey();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Escape closes the key form, not the whole Settings dialog.
            event.preventDefault();
            event.stopPropagation();
            closeKey();
          }}
        >
          <label className="sw-field-help" htmlFor={keyId}>Paste an OpenAI API key. CodeRay keeps it in this account's {name} home and never shows it again.</label>
          <div className="sw-login-row">
            <input
              ref={keyField}
              id={keyId}
              className="sw-code"
              type="password"
              data-landing
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              spellCheck={false}
              placeholder="sk-…"
              aria-invalid={key === 'bad'}
              aria-describedby={key === 'bad' ? `${keyId}-bad` : undefined}
              onChange={(event) => {
                const value = event.target.value.trim();
                setKey(value === '' ? 'empty' : API_KEY_PATTERN.test(value) ? 'ok' : 'bad');
              }}
            />
            <button
              type="submit"
              className="sw-btn primary"
              disabled={busy || elsewhere !== null || key !== 'ok'}
              aria-describedby={elsewhere !== null ? `${keyId}-why` : undefined}
            >
              Add key
            </button>
            <button type="button" className="sw-btn ghost" onClick={closeKey}>Cancel</button>
          </div>
          {key === 'bad' && <p id={`${keyId}-bad`} className="sw-error">That is not an API key: one line without spaces, at most 512 characters.</p>}
        </form>
      )}
      {nameForm && (
        <form
          className="sw-login"
          onSubmit={(event) => {
            event.preventDefault();
            submitName();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Escape closes the name form, not the whole Settings dialog.
            event.preventDefault();
            event.stopPropagation();
            closeName();
          }}
        >
          <label className="sw-field-help" id={`${keyId}-name-help`} htmlFor={`${keyId}-name`}>Name the profile, such as Work or Personal. It keeps its own opencode providers and keys.</label>
          <div className="sw-login-row">
            <input
              id={`${keyId}-name`}
              className="sw-code sw-name"
              data-landing
              value={profileName}
              aria-label="Profile name"
              aria-invalid={(typedProblem ?? nameError) !== null}
              aria-describedby={`${keyId}-name-help${(typedProblem ?? nameError) === null ? '' : ` ${keyId}-name-bad`}`}
              autoComplete="off"
              spellCheck={false}
              placeholder="Work"
              onChange={(event) => {
                setProfileName(event.target.value);
                setNameError(null);
              }}
            />
            <button type="submit" className="sw-btn primary" disabled={busy || profileName.trim() === '' || typedProblem !== null}>Create</button>
            <button type="button" className="sw-btn ghost" onClick={closeName}>Cancel</button>
          </div>
          {(typedProblem ?? nameError) !== null && <p id={`${keyId}-name-bad`} className="sw-error">{typedProblem ?? nameError}</p>}
        </form>
      )}
      {/* Said in text, not a tooltip: a disabled button takes no focus and shows no title to the keyboard. */}
      {!mine && elsewhere !== null && <p id={`${keyId}-why`} className="sw-field-help">Finish or cancel the {elsewhere} sign-in first.</p>}
      {mine && login.state === 'waiting' && login.method === 'device-code' && (
        <div className="sw-login" role="group" aria-label="Device code sign-in" onKeyDown={escapeCancels}>
          <div className="sw-login-row">
            <button ref={primary} type="button" className="sw-btn primary" disabled={login.url === null} data-landing={login.url !== null || undefined} onClick={() => openPage(login.url)}>
              Open the device page
            </button>
            {login.url === null && <span className="muted"><Spinner /> Starting {engine}…</span>}
          </div>
          {login.userCode !== null && (
            <div className="sw-login-row">
              <code className="sw-user-code">{login.userCode}</code>
              <button type="button" className="sw-btn ghost" title="Copy the code" onClick={copyCode}>
                <Icon name={copy === 'done' ? 'check' : copy === 'failed' ? 'alert' : 'copy'} size={14} /> {copy === 'done' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy'}
              </button>
            </div>
          )}
          <p className="sw-field-help">Enter this code on the device page and sign in; CodeRay finishes on its own.</p>
          <div className="sw-login-row">
            <button ref={cancelButton} type="button" className="sw-btn ghost" data-landing={login.url === null || undefined} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {mine && login.state === 'waiting' && login.method !== 'device-code' && (
        <div className="sw-login" onKeyDown={escapeCancels}>
          <div className="sw-login-row">
            <button ref={primary} type="button" className="sw-btn primary" disabled={login.url === null} data-landing={login.url !== null || undefined} onClick={() => openPage(login.url)}>
              Open sign-in page
            </button>
            {login.url === null && <span className="muted"><Spinner /> Starting {engine}…</span>}
          </div>
          {engine === 'claude' ? (
            <>
              <p className="sw-field-help">Your browser opens automatically. If it shows a code, paste it here.</p>
              <form
                className="sw-login-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCode();
                }}
              >
                <input
                  ref={codeField}
                  className="account-code sw-code"
                  data-landing={login.url === null || undefined}
                  onChange={(event) => setHasCode(event.target.value.trim() !== '')}
                  placeholder="Code from the sign-in page"
                  aria-label="Sign-in code"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="sw-btn primary" disabled={busy || !hasCode}>Submit</button>
                <button type="button" className="sw-btn ghost" onClick={cancel}>Cancel</button>
              </form>
            </>
          ) : (
            <>
              <p className="sw-field-help">Sign in on the page that opens; CodeRay finishes on its own.</p>
              <div className="sw-login-row">
                <button ref={cancelButton} type="button" className="sw-btn ghost" data-landing={login.url === null || undefined} onClick={cancel}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
      {mine && login.state === 'checking' && (
        <div className="sw-login sw-login-row" onKeyDown={escapeCancels}>
          <span className="muted" aria-hidden="true"><Spinner /> Checking account…</span>
          <button type="button" className="sw-btn ghost" data-landing aria-describedby={`${keyId}-status`} onClick={cancel}>Cancel</button>
        </div>
      )}
      {mine && login.state === 'error' && (
        <div className="sw-login sw-login-row">
          <span className="sw-error" role="alert">{login.error}</span>
          <button type="button" className="sw-btn" data-landing disabled={busy} onClick={retry}>Retry</button>
          <button type="button" className="sw-btn ghost" onClick={cancel}>Dismiss</button>
        </div>
      )}
      {/* Mounted before its text changes, so a screen reader announces the change. */}
      <span id={`${keyId}-status`} className="visually-hidden" role="status">{mine && login.state === 'checking' ? 'Checking account…' : ''}</span>
    </div>
  );
}
