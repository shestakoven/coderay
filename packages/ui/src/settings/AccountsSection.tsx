import { useState } from 'react';
import type { AccountsView, ClientMessage } from '@ide/protocol';
import { Icon } from '../layout/Icon';

export function AccountsSection({ view, busy, onRequest }: {
  view: AccountsView;
  busy: boolean;
  onRequest: (message: ClientMessage & { requestId: string }) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { login } = view;
  const claude = view.engines[0] ?? { engine: 'claude', accounts: [], activeId: null };
  const rows = [{ id: null, label: 'System' }, ...claude.accounts.map((account) => ({ id: account.id, label: account.email }))];
  const active = rows.find((row) => row.id === claude.activeId) ?? rows[0]!;
  const send = (message: ClientMessage & { requestId: string }): void => {
    setConfirming(null);
    onRequest(message);
  };
  const remove = (id: string): void => {
    if (confirming !== id) setConfirming(id);
    else send({ type: 'account.remove', requestId: crypto.randomUUID(), id });
  };
  const submit = (): void => {
    if (code.trim() === '') return;
    send({ type: 'account.login.code', requestId: crypto.randomUUID(), code: code.trim() });
    setCode('');
  };
  const start = (): void => send({ type: 'account.login.start', requestId: crypto.randomUUID() });
  const cancel = (): void => send({ type: 'account.login.cancel', requestId: crypto.randomUUID() });

  return (
    <div className="sw-accounts accounts">
      <p className="sw-account-note">
        {active.label} is active. A switch applies to every project from the next agent start and begins a fresh Claude conversation.
      </p>
      <div role="radiogroup" aria-label="Claude account" className="sw-list">
        {rows.map((row) => {
          const on = claude.activeId === row.id;
          return (
            <div key={row.id ?? 'system'} className={`sw-account${on ? ' on' : ''}`}>
              <label className="account-choice sw-account-choice">
                <input
                  type="radio"
                  name="claude-account"
                  checked={on}
                  disabled={busy}
                  onChange={() => send({ type: 'account.select', requestId: crypto.randomUUID(), id: row.id })}
                />
                <span className="sw-avatar" aria-hidden="true" data-initial={row.id === null ? undefined : row.label.charAt(0).toUpperCase()}>
                  {row.id === null && <Icon name="terminal" size={14} />}
                </span>
                <b>{row.label}</b>
              </label>
              {row.id === null && <span className="muted sw-account-sub">claude's default sign-in</span>}
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
      {login.state === 'idle' && (
        <div>
          <button type="button" className="sw-btn account-add" disabled={busy} onClick={start}><Icon name="plus" size={14} /> Add account</button>
        </div>
      )}
      {login.state === 'waiting' && (
        <div className="sw-login">
          <div className="sw-login-row">
            <button type="button" className="sw-btn primary" disabled={login.url === null} onClick={() => login.url && window.open(login.url, '_blank', 'noopener')}>
              Open sign-in page
            </button>
            {login.url === null && <span className="muted"><span className="bg-tasks-spin" aria-hidden="true">⟳</span> Starting claude…</span>}
          </div>
          <p className="sw-field-help">Your browser opens automatically. If it shows a code, paste it here.</p>
          <form
            className="sw-login-row"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              className="account-code sw-code"
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
        </div>
      )}
      {login.state === 'checking' && (
        <div className="sw-login sw-login-row">
          <span className="muted"><span className="bg-tasks-spin" aria-hidden="true">⟳</span> Checking account…</span>
          <button type="button" className="sw-btn ghost" onClick={cancel}>Cancel</button>
        </div>
      )}
      {login.state === 'error' && (
        <div className="sw-login sw-login-row">
          <span className="sw-error">{login.error}</span>
          <button type="button" className="sw-btn" disabled={busy} onClick={start}>Retry</button>
        </div>
      )}
    </div>
  );
}
