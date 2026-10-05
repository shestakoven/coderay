import { useEffect, useState } from 'react';
import type { ClientMessage, McpLevel, McpServerState, McpServerView, McpTransport, SettingsView } from '@ide/protocol';
import { AccountsSection } from './AccountsSection';
import { PolicySection } from './PolicySection';
import { emptyForm, entryFromForm, formFromServer, type EntryForm } from './entry-form';

export interface SettingsResult {
  requestId: string;
  error: string | null;
}

const LEVELS: { level: McpLevel; title: string }[] = [
  { level: 'ide', title: 'IDE level — every project (~/.ide/mcp.json)' },
  { level: 'project', title: 'Project level — committed (.ide/mcp.json)' },
];

type TextField = 'name' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'timeout';

export function SettingsPanel({ settings, lastResult, sessionServers, send, onClose }: {
  settings: SettingsView | null;
  lastResult: SettingsResult | null;
  sessionServers: McpServerState[];
  send: (message: ClientMessage) => boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState<EntryForm | null>(null);
  const [previousName, setPreviousName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<{ requestId: string; fromForm: boolean; needsRestart: boolean } | null>(null);
  const [changed, setChanged] = useState(false);
  const edits = settings?.externalEdits;

  useEffect(() => {
    if (!awaiting || lastResult?.requestId !== awaiting.requestId) return;
    setAwaiting(null);
    if (lastResult.error === null) {
      if (awaiting.needsRestart) setChanged(true);
      if (awaiting.fromForm) setForm(null);
    } else if (awaiting.fromForm) {
      setFormError(lastResult.error);
    } else {
      setPanelError(lastResult.error);
    }
  }, [lastResult, awaiting]);

  const request = (message: ClientMessage & { requestId: string }, fromForm: boolean, needsRestart = true): void => {
    setPanelError(null);
    if (send(message)) setAwaiting({ requestId: message.requestId, fromForm, needsRestart });
  };
  const edit = (level: McpLevel, server: McpServerView | null): void => {
    setForm(server ? formFromServer(server) : emptyForm(level));
    setPreviousName(server?.name ?? null);
    setFormError(null);
  };
  const save = (): void => {
    if (!form) return;
    const result = entryFromForm(form);
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    request({ type: 'mcp.save', requestId: crypto.randomUUID(), level: form.level, name: form.name.trim(), entry: result.entry, previousName }, true);
  };
  const liveStatus = (name: string): string => sessionServers.find((server) => server.name === name)?.status ?? '—';
  const claudeCode = settings?.claudeCodeServers ?? [];
  const known = new Set(['idecore', ...(settings?.servers ?? []).map((server) => server.name), ...claudeCode.map((server) => server.name)]);
  const external: { name: string; source: string; type: string | null }[] = settings
    ? [...claudeCode, ...sessionServers.filter((server) => !known.has(server.name)).map((server) => ({ name: server.name, source: 'plugin', type: null }))]
    : [];

  return (
    <div className="modal" onClick={onClose}>
      <div className="settings" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose}>Close</button>
        </header>
        {settings && edits && (edits.ideServers || edits.trust) && (
          <div className="banner warn">
            <div>
              {[edits.ideServers && '~/.ide/mcp.json', edits.trust && '~/.ide/trust.json'].filter(Boolean).join(' and ')} changed outside Settings.
              The affected servers stay off until you confirm. Review the entries below first.
              {edits.trustApproves.length > 0 && <div>Confirming approves these project servers: {edits.trustApproves.join(', ')}.</div>}
              {edits.trust && <div>Confirming keeps only the approvals listed above and removes every other approval in ~/.ide/trust.json, including other projects'; those servers must be approved again.</div>}
            </div>
            <button
              disabled={awaiting !== null}
              onClick={() => request({ type: 'mcp.confirm-external-edits', requestId: crypto.randomUUID(), fileHashes: settings.fileHashes }, false)}
            >
              Confirm the edits
            </button>
          </div>
        )}
        {changed && (
          <div className="banner">
            <span>Changes apply when the session restarts.</span>
            <button
              onClick={() => {
                send({ type: 'session.restart' });
                setChanged(false);
              }}
            >
              Restart session
            </button>
          </div>
        )}
        {panelError && <p className="problem">{panelError}</p>}
        {settings && <AccountsSection view={settings.accounts} busy={awaiting !== null} onRequest={(message) => request(message, false, false)} />}
        <h3>MCP servers</h3>
        {LEVELS.map(({ level, title }) => (
          <section key={level}>
            <h3>{title}</h3>
            {(settings?.servers ?? []).filter((server) => server.level === level).map((server) => (
              <div key={server.name} className="server">
                <div className="server-row">
                  <b>{server.name}</b>
                  <span className={`server-status ${server.status}`}>{server.status}{server.reason ? `: ${server.reason}` : ''}</span>
                  <span className="muted">session: {liveStatus(server.name)}</span>
                  <span className="actions">
                    {server.level === 'project' && server.status === 'unapproved' && !edits?.trust && (
                      <button
                        disabled={awaiting !== null}
                        onClick={() => request({ type: 'mcp.approve', requestId: crypto.randomUUID(), name: server.name, entryHash: server.entryHash }, false)}
                      >
                        Approve as shown
                      </button>
                    )}
                    <button onClick={() => edit(level, server)}>Edit</button>
                    <button
                      disabled={awaiting !== null}
                      onClick={() => request({ type: 'mcp.remove', requestId: crypto.randomUUID(), level, name: server.name }, false)}
                    >
                      Remove
                    </button>
                  </span>
                </div>
                <details open={server.status === 'unapproved'}>
                  <summary className="muted">entry</summary>
                  <pre className="entry">{JSON.stringify(server.entry, null, 2)}</pre>
                </details>
              </div>
            ))}
            <button onClick={() => edit(level, null)}>Add server</button>
          </section>
        ))}
        {external.length > 0 && (
          <section>
            <h3>From Claude Code</h3>
            <div className="muted">Loaded by Claude Code itself. Edit them with <code>claude mcp</code>.</div>
            {external.map((server) => (
              <div key={server.name} className="server">
                <div className="server-row">
                  <b>{server.name}</b>
                  <span className="badge source">{server.source}</span>
                  {server.type && <span className="muted">{server.type}</span>}
                  <span className="muted">session: {liveStatus(server.name)}</span>
                </div>
              </div>
            ))}
          </section>
        )}
        {settings && (
          <PolicySection
            view={settings.policy}
            busy={awaiting !== null}
            onSave={(level, policy) => request({ type: 'policy.save', requestId: crypto.randomUUID(), level, policy }, false, false)}
            onConfirm={(hashes) => request({ type: 'policy.confirm-external-edits', requestId: crypto.randomUUID(), hashes }, false, false)}
          />
        )}
        {settings?.problems.map((problem, index) => <p key={index} className="problem">{problem}</p>)}
        {form && (
          <EntryEditor
            form={form}
            error={formError}
            saving={awaiting?.fromForm === true}
            busy={awaiting !== null}
            onChange={setForm}
            onSave={save}
            onCancel={() => setForm(null)}
          />
        )}
      </div>
    </div>
  );
}

function EntryEditor({ form, error, saving, busy, onChange, onSave, onCancel }: {
  form: EntryForm;
  error: string | null;
  saving: boolean;
  busy: boolean;
  onChange: (form: EntryForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = (key: TextField) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => onChange({ ...form, [key]: event.target.value } as EntryForm),
  });
  return (
    <div className="entry-editor">
      <h3>{form.level === 'ide' ? 'IDE-level server' : 'Project-level server'}</h3>
      <label>Name <input {...field('name')} /></label>
      <label>
        Transport
        <select value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value as McpTransport })}>
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
      </label>
      {form.type === 'stdio' ? (
        <>
          <label>Command <input {...field('command')} /></label>
          <label>Arguments, one per line <textarea rows={3} {...field('args')} /></label>
          <label>Environment, NAME=value per line (write secrets as {'${VAR}'}) <textarea rows={3} {...field('env')} /></label>
        </>
      ) : (
        <>
          <label>URL <input {...field('url')} /></label>
          <label>Headers, "Name: value" per line (write secrets as {'${VAR}'}) <textarea rows={3} {...field('headers')} /></label>
        </>
      )}
      <label>Timeout in ms (optional) <input {...field('timeout')} /></label>
      {error && <p className="problem">{error}</p>}
      <div className="composer-actions">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={onSave} disabled={busy}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
