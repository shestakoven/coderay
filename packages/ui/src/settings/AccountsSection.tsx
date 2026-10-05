import { useState } from 'react';
import type { AccountsView, ClientMessage } from '@ide/protocol';

export function AccountsSection({ view, busy, onRequest }: {
  view: AccountsView;
  busy: boolean;
  onRequest: (message: ClientMessage & { requestId: string }) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { login } = view;
  const rows = [{ id: null, label: 'System' }, ...view.accounts.map((account) => ({ id: account.id, label: account.email }))];
  const active = rows.find((row) => row.id === view.activeId) ?? rows[0]!;
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
    <section className="accounts">
      <h3>Accounts</h3>
      <div className="muted">
        Active: {active.label}. A switch applies to every project from the next agent start and begins a fresh Claude conversation.
      </div>
      <div role="radiogroup" aria-label="Claude account">
        {rows.map((row) => (
          <div key={row.id ?? 'system'} className="server">
            <div className="server-row">
              <label className="account-choice">
                <input
                  type="radio"
                  name="claude-account"
                  checked={view.activeId === row.id}
                  disabled={busy}
                  onChange={() => send({ type: 'account.select', requestId: crypto.randomUUID(), id: row.id })}
                />
                <b>{row.label}</b>
              </label>
              {row.id === null && <span className="muted">claude's default sign-in</span>}
              {view.activeId === row.id && <span className="badge source">active</span>}
              {row.id !== null && (
                <span className="actions">
                  <button
                    className={`account-remove${confirming === row.id ? ' confirm' : ''}`}
                    disabled={busy}
                    title={confirming === row.id ? 'Click again to sign this account out and delete its credentials' : 'Remove this account'}
                    onClick={() => remove(row.id)}
                  >
                    {confirming === row.id ? 'Remove sign-in?' : 'Remove'}
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {login.state === 'idle' && <button className="account-add" disabled={busy} onClick={start}>Add account</button>}
      {login.state === 'waiting' && (
        <div className="account-login">
          <div className="account-login-row">
            <button className="primary" disabled={login.url === null} onClick={() => login.url && window.open(login.url, '_blank', 'noopener')}>
              Open sign-in page
            </button>
            {login.url === null && <span className="muted"><span className="bg-tasks-spin" aria-hidden="true">⟳</span> Starting claude…</span>}
          </div>
          <div className="muted">Your browser opens automatically. If it shows a code, paste it here.</div>
          <form
            className="account-login-row"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              className="account-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Code from the sign-in page"
              aria-label="Sign-in code"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={busy || code.trim() === ''}>Submit</button>
            <button type="button" onClick={cancel}>Cancel</button>
          </form>
        </div>
      )}
      {login.state === 'checking' && (
        <div className="account-login account-login-row">
          <span className="muted"><span className="bg-tasks-spin" aria-hidden="true">⟳</span> Checking account…</span>
          <button onClick={cancel}>Cancel</button>
        </div>
      )}
      {login.state === 'error' && (
        <div className="account-login account-login-row">
          <span className="problem">{login.error}</span>
          <button disabled={busy} onClick={start}>Retry</button>
        </div>
      )}
    </section>
  );
}
