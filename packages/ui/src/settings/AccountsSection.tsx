import { useEffect, useId, useRef, useState } from 'react';
import {
  API_KEY_PATTERN, ENGINE_NAMES, LOGIN_METHODS, type AccountLoginView, type ClientMessage, type EngineAccountsView, type EngineId, type LoginMethod,
} from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { methodLabel, SYSTEM_NOTE } from './accounts';

const Spinner = () => <span className="bg-tasks-spin" aria-hidden="true">⟳</span>;

export function AccountsSection({ engine, view, login, busy, onRequest }: {
  engine: EngineId;
  view: EngineAccountsView;
  login: AccountLoginView;
  busy: boolean;
  onRequest: (message: ClientMessage & { requestId: string }) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [keyForm, setKeyForm] = useState(false);
  const [key, setKey] = useState('');
  const [copied, setCopied] = useState(false);
  const keyId = useId();
  const section = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<{ element: HTMLElement; inList: boolean } | null>(null);
  const began = useRef<LoginMethod | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const name = ENGINE_NAMES[engine];
  // A login view without an engine comes from a core before engine-scoped accounts: it is Claude's.
  const loginEngine = login.state === 'idle' ? null : (login.engine ?? 'claude');
  const mine = loginEngine === engine;
  // Only a running sign-in blocks the others; a failed one waits for its Retry or Dismiss without holding them up.
  const running = login.state === 'waiting' || login.state === 'checking';
  const elsewhere = running && loginEngine !== null && !mine ? ENGINE_NAMES[loginEngine] : null;
  const keyValue = key.trim();
  const keyBad = keyValue !== '' && !API_KEY_PATTERN.test(keyValue);
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
    return () => document.removeEventListener('focusin', leave);
  }, []);
  useEffect(() => {
    // A control disabled by a request in flight, or gone with its step, drops the focus to <body>: it comes back here once a control can take it.
    const last = lastFocus.current;
    const root = section.current;
    if (last === null || root === null || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const find = (selector: string) => root.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
    const target = last.element.isConnected
      ? (last.element as HTMLButtonElement)
      : last.inList
        ? find('input[type="radio"]:checked')
        : find('[data-landing]') ?? find(`.account-add[data-method="${began.current}"]`) ?? find('.account-add');
    if (target && !target.disabled) target.focus();
  });
  const rows = [
    { id: null, label: 'System', plan: null },
    ...view.accounts.map((account) => ({ id: account.id, label: account.email, plan: account.plan ?? null })),
  ];
  const active = rows.find((row) => row.id === view.activeId) ?? rows[0]!;
  const requestId = (): string => crypto.randomUUID();
  const send = (message: ClientMessage & { requestId: string }): void => {
    setConfirming(null);
    onRequest(message);
  };
  const start = (method: LoginMethod, apiKey?: string): void =>
    send({ type: 'account.login.start', requestId: requestId(), engine, method, ...(apiKey === undefined ? {} : { apiKey }) });
  const cancel = (): void => send({ type: 'account.login.cancel', requestId: requestId() });
  const remove = (id: string): void => {
    if (confirming !== id) setConfirming(id);
    else send({ type: 'account.remove', requestId: requestId(), engine, id });
  };
  const closeKey = (): void => {
    setKeyForm(false);
    setKey('');
  };
  const submitKey = (): void => {
    // The core answers a malformed key with an error no request waits for, so the form checks the key first.
    if (keyValue === '' || keyBad) return;
    start('api-key', keyValue);
    closeKey();
  };
  const submitCode = (): void => {
    if (code.trim() === '') return;
    send({ type: 'account.login.code', requestId: requestId(), code: code.trim() });
    setCode('');
  };
  const copyCode = (): void => {
    void navigator.clipboard?.writeText(login.userCode ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const open = (url: string | null): void => {
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
        lastFocus.current = { element: event.target, inList: event.target.closest('[role="radiogroup"]') !== null };
      }}
    >
      <p className="sw-account-note">
        {active.label} is active. A switch applies to every project from the next agent start and begins a fresh {name} conversation.
      </p>
      <div role="radiogroup" aria-label={`${name} account`} className="sw-list">
        {rows.map((row) => {
          const on = view.activeId === row.id;
          return (
            <div key={row.id ?? 'system'} className={`sw-account${on ? ' on' : ''}`}>
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
                  <button
                    type="button"
                    className={`sw-btn ghost account-remove${confirming === row.id ? ' confirm' : ''}`}
                    disabled={busy}
                    title={confirming === row.id ? 'Click again to sign this account out and delete its credentials' : 'Remove this account'}
                    onClick={() => remove(row.id)}
                  >
                    {confirming === row.id ? 'Remove sign-in?' : 'Remove'}
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {!mine && !keyForm && (
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
                  else start(method);
                }}
              >
                {index === 0 && <Icon name="plus" size={14} />} {methodLabel(engine, method)}
              </button>
            ))}
          </div>
          {/* Said in text, not a tooltip: a disabled button takes no focus and shows no title to the keyboard. */}
          {elsewhere !== null && <p id={`${keyId}-why`} className="sw-field-help">Finish or cancel the {elsewhere} sign-in first.</p>}
        </>
      )}
      {keyForm && !mine && (
        <form
          className="sw-login"
          onSubmit={(event) => {
            event.preventDefault();
            submitKey();
          }}
        >
          <label className="sw-field-help" htmlFor={keyId}>Paste an OpenAI API key. CodeRay keeps it in this account's {name} home and never shows it again.</label>
          <div className="sw-login-row">
            <input
              id={keyId}
              className="sw-code"
              type="password"
              data-landing
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              value={key}
              aria-invalid={keyBad}
              aria-describedby={keyBad ? `${keyId}-bad` : undefined}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                // Escape closes the key form, not the whole Settings dialog.
                event.preventDefault();
                event.stopPropagation();
                closeKey();
              }}
            />
            <button type="submit" className="sw-btn primary" disabled={busy || keyValue === '' || keyBad}>Add key</button>
            <button type="button" className="sw-btn ghost" onClick={closeKey}>Cancel</button>
          </div>
          {keyBad && <p id={`${keyId}-bad`} className="sw-error">That is not an API key: one line without spaces, at most 512 characters.</p>}
        </form>
      )}
      {mine && login.state === 'waiting' && login.method === 'device-code' && (
        <div className="sw-login" role="group" aria-label="Device code sign-in">
          <div className="sw-login-row">
            <button ref={primary} type="button" className="sw-btn primary" disabled={login.url === null} data-landing={login.url !== null || undefined} onClick={() => open(login.url)}>
              Open the device page
            </button>
            {login.url === null && <span className="muted"><Spinner /> Starting {engine}…</span>}
          </div>
          {login.userCode !== null && (
            <div className="sw-login-row">
              <code className="sw-user-code" aria-label="One-time code">{login.userCode}</code>
              <button type="button" className="sw-btn ghost" title="Copy the code" onClick={copyCode}>
                <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
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
        <div className="sw-login">
          <div className="sw-login-row">
            <button ref={primary} type="button" className="sw-btn primary" disabled={login.url === null} data-landing={login.url !== null || undefined} onClick={() => open(login.url)}>
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
                  ref={codeInput}
                  className="account-code sw-code"
                  data-landing={login.url === null || undefined}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Code from the sign-in page"
                  aria-label="Sign-in code"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="sw-btn primary" disabled={busy || code.trim() === ''}>Submit</button>
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
        <div className="sw-login sw-login-row">
          <span className="muted" role="status"><Spinner /> Checking account…</span>
          <button type="button" className="sw-btn ghost" data-landing onClick={cancel}>Cancel</button>
        </div>
      )}
      {mine && login.state === 'error' && (
        <div className="sw-login sw-login-row">
          <span className="sw-error" role="alert">{login.error}</span>
          <button type="button" className="sw-btn" data-landing disabled={busy} onClick={retry}>Retry</button>
          <button type="button" className="sw-btn ghost" onClick={cancel}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
