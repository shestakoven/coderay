import { useState, type ReactNode } from 'react';
import type { ClientMessage, McpLevel, McpServerState, McpServerView, SettingsView } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { Banner, Dot, IconButton } from './controls';
import { emptyForm, entryFromForm, formFromServer, type EntryForm } from './entry-form';
import { McpForm } from './McpForm';
import { MASK, describeEntry, levelName, liveBadge, serverBadge, type EntryPair, type Tone } from './mcp-view';
import type { RunOptions } from './requests';

const statusClass = (tone: Tone): string => (tone === 'muted' ? 'sw-status' : `sw-status ${tone}`);

type Run = (message: ClientMessage & { requestId: string }, options?: RunOptions) => boolean;

const GROUPS: { level: McpLevel; file: string; note: string }[] = [
  { level: 'project', file: '.ide/mcp.json', note: 'Committed with the project. Each person approves these on their own machine.' },
  { level: 'ide', file: '~/.ide/mcp.json', note: 'On this machine, for every project.' },
];

export function McpServersBlock({ settings, sessionServers, busy, run, restartPending, onChanged, onRestart }: {
  settings: SettingsView;
  sessionServers: McpServerState[];
  busy: boolean;
  run: Run;
  restartPending: boolean;
  onChanged: () => void;
  onRestart: () => void;
}) {
  const [form, setForm] = useState<EntryForm | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const edits = settings.externalEdits;
  const live = (name: string): string | undefined => sessionServers.find((server) => server.name === name)?.status;
  const keyOf = (server: McpServerView): string => `${server.level}:${server.name}`;
  const isOpen = (server: McpServerView): boolean => expanded[keyOf(server)] ?? server.status === 'unapproved';

  const open = (level: McpLevel, server: McpServerView | null): void => {
    setForm(server ? formFromServer(server) : emptyForm(level));
    setEditing(server?.name ?? null);
    setFormError(null);
    setConfirming(null);
  };
  const close = (): void => {
    setForm(null);
    setFormError(null);
  };
  const save = (): void => {
    if (!form) return;
    const result = entryFromForm(form);
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    run(
      { type: 'mcp.save', requestId: crypto.randomUUID(), level: form.level, name: form.name.trim(), entry: result.entry, previousName: editing },
      {
        inline: true,
        okText: editing === null ? 'Server added' : 'Server saved',
        onSettled: (error) => {
          setSaving(false);
          if (error === null) {
            close();
            onChanged();
          } else setFormError(error);
        },
      },
    );
  };
  const mutate = (message: ClientMessage & { requestId: string }, okText: string): void => {
    run(message, { okText, onSettled: (error) => error === null && onChanged() });
  };
  const toggleReveal = (id: string): void => setRevealed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const takenAt = (level: McpLevel): string[] => settings.servers.filter((server) => server.level === level).map((server) => server.name);

  const pairs = (server: McpServerView, kind: 'env' | 'header', items: EntryPair[]): ReactNode =>
    items.map((pair) => {
      const id = `${keyOf(server)}:${kind}:${pair.name}`;
      const shown = !pair.secret || revealed.has(id);
      return (
        <div key={id} className="sw-pair">
          <span className="sw-pair-name">{pair.name}</span>
          <span className={`sw-pair-value${shown ? '' : ' masked'}`}>{shown ? pair.value : MASK}</span>
          {pair.secret && <IconButton icon={shown ? 'eye-off' : 'eye'} label={shown ? 'Hide value' : 'Show value'} pressed={shown} onClick={() => toggleReveal(id)} />}
        </div>
      );
    });

  const row = (server: McpServerView): ReactNode => {
    const badge = serverBadge(server.status, live(server.name));
    const description = describeEntry(server.entry);
    const key = keyOf(server);
    const openNow = isOpen(server);
    const canApprove = server.level === 'project' && server.status === 'unapproved' && !edits.trust;
    const removing = confirming === key;
    return (
      <li key={key} className={`sw-server${openNow ? ' open' : ''}`}>
        <div className="sw-server-row">
          <button type="button" className="sw-server-toggle" aria-expanded={openNow} onClick={() => setExpanded({ ...expanded, [key]: !openNow })}>
            <Icon name={openNow ? 'chevron-down' : 'chevron-right'} size={14} />
            <Dot tone={badge.tone} />
            <b>{server.name}</b>
            <span className="sw-server-line"><Icon name={description.transport === 'stdio' ? 'terminal' : 'globe'} size={13} />{description.headline}</span>
            <span className={statusClass(badge.tone)}>{badge.label}</span>
          </button>
          <span className="sw-server-actions">
            {canApprove && <IconButton icon="check" tone="ok" label="Approve as shown" disabled={busy} onClick={() => mutate({ type: 'mcp.approve', requestId: crypto.randomUUID(), name: server.name, entryHash: server.entryHash }, `${server.name} approved`)} />}
            <IconButton icon="pencil" label="Edit" onClick={() => open(server.level, server)} />
            {removing ? (
              <>
                <button type="button" className="sw-btn danger" disabled={busy} onClick={() => { setConfirming(null); mutate({ type: 'mcp.remove', requestId: crypto.randomUUID(), level: server.level, name: server.name }, `${server.name} removed`); }}>Remove?</button>
                <IconButton icon="close" label="Keep" onClick={() => setConfirming(null)} />
              </>
            ) : (
              <IconButton icon="trash" tone="danger" label="Remove" disabled={busy} onClick={() => setConfirming(key)} />
            )}
          </span>
        </div>
        {openNow && (
          <div className="sw-server-detail">
            {server.status === 'unapproved' && (
              <Banner
                tone="warn"
                title="Not approved on this machine"
                actions={canApprove ? <button type="button" className="sw-btn primary" disabled={busy} onClick={() => mutate({ type: 'mcp.approve', requestId: crypto.randomUUID(), name: server.name, entryHash: server.entryHash }, `${server.name} approved`)}>Approve as shown</button> : undefined}
              >
                {canApprove ? 'This entry comes from the project. Check what it runs below, then approve exactly this version.' : 'Confirm the outside edits above first.'}
              </Banner>
            )}
            {server.status === 'missing-env' && <Banner tone="error" title="A variable is not set">{server.reason ?? 'The entry refers to an environment variable that is not defined.'}</Banner>}
            {server.status === 'shadowed' && <Banner tone="info" title="Another server wins">{server.reason ?? 'A server with this name exists at the other level and takes precedence.'}</Banner>}
            <dl className="sw-def">
              {description.command && (<><dt>Command</dt><dd className="mono">{description.command}</dd></>)}
              {description.args.length > 0 && (<><dt>Arguments</dt><dd className="sw-tags">{description.args.map((arg, index) => <span key={`${index}-${arg}`} className="sw-tag">{arg}</span>)}</dd></>)}
              {description.url && (<><dt>URL</dt><dd className="mono">{description.url}</dd></>)}
              {description.env.length > 0 && (<><dt>Environment</dt><dd>{pairs(server, 'env', description.env)}</dd></>)}
              {description.headers.length > 0 && (<><dt>Headers</dt><dd>{pairs(server, 'header', description.headers)}</dd></>)}
              {description.timeout !== null && (<><dt>Timeout</dt><dd className="mono">{description.timeout} ms</dd></>)}
              <dt>In this session</dt>
              <dd>{liveBadge(live(server.name))?.label ?? <span className="muted">Not started yet. Servers load when the session starts.</span>}</dd>
            </dl>
          </div>
        )}
      </li>
    );
  };

  const formFor = (level: McpLevel, previous: string | null): ReactNode =>
    form && form.level === level && editing === previous ? (
      <li key={`form-${previous ?? 'new'}`} className="sw-server-form">
        <McpForm
          form={form}
          editing={editing}
          taken={takenAt(form.level)}
          otherLevelHasName={form.name.trim() !== '' && takenAt(form.level === 'ide' ? 'project' : 'ide').includes(form.name.trim())}
          serverError={formError}
          saving={saving}
          busy={busy}
          onChange={setForm}
          onSave={save}
          onCancel={close}
        />
      </li>
    ) : null;

  return (
    <div className="sw-mcp">
      {(edits.ideServers || edits.trust) && (
        <Banner
          tone="warn"
          title={`${[edits.ideServers && '~/.ide/mcp.json', edits.trust && '~/.ide/trust.json'].filter(Boolean).join(' and ')} changed outside Settings`}
          actions={<button type="button" className="sw-btn" disabled={busy} onClick={() => mutate({ type: 'mcp.confirm-external-edits', requestId: crypto.randomUUID(), fileHashes: settings.fileHashes }, 'Outside edits confirmed')}>Confirm the edits</button>}
        >
          The affected servers stay off until you confirm. Review the entries below first.
          {edits.trustApproves.length > 0 && <div>Confirming approves these project servers: {edits.trustApproves.join(', ')}.</div>}
          {edits.trust && <div>Confirming keeps only the approvals listed above and removes every other approval in ~/.ide/trust.json, including other projects’; those servers must be approved again.</div>}
        </Banner>
      )}
      {restartPending && (
        <Banner tone="info" title="Changes apply when the session restarts" actions={<button type="button" className="sw-btn" onClick={onRestart}><Icon name="restart" size={14} /> Restart session</button>} />
      )}
      {settings.problems.map((problem, index) => <Banner key={index} tone="warn">{problem}</Banner>)}
      {GROUPS.map(({ level, file, note }) => {
        const servers = settings.servers.filter((server) => server.level === level);
        return (
          <section key={level} className="sw-mcp-group" aria-label={`${levelName(level)} servers`}>
            <header className="sw-mcp-head">
              <div>
                <b>{levelName(level)}</b>
                <span className="sw-mcp-file mono">{file}</span>
                <p>{note}</p>
              </div>
              <button type="button" className="sw-btn" disabled={form !== null && form.level === level && editing === null} onClick={() => open(level, null)}><Icon name="plus" size={14} /> Add server</button>
            </header>
            <ul className="sw-list">
              {formFor(level, null)}
              {servers.map((server) => (formFor(level, server.name) ?? row(server)))}
              {servers.length === 0 && !(form && form.level === level && editing === null) && <li className="sw-list-empty">No servers here yet.</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function claudeRows(settings: SettingsView, sessionServers: McpServerState[]): { name: string; source: string; type: string | null }[] {
  const known = new Set(['idecore', ...settings.servers.map((server) => server.name), ...settings.claudeCodeServers.map((server) => server.name)]);
  return [
    ...settings.claudeCodeServers,
    ...sessionServers.filter((server) => !known.has(server.name)).map((server) => ({ name: server.name, source: 'plugin', type: null })),
  ];
}

export function ClaudeCodeServersBlock({ settings, sessionServers }: { settings: SettingsView; sessionServers: McpServerState[] }) {
  const rows = claudeRows(settings, sessionServers);
  return (
    <ul className="sw-list">
      {rows.map((server) => {
        const status = sessionServers.find((candidate) => candidate.name === server.name)?.status;
        const badge = liveBadge(status);
        return (
          <li key={server.name} className="sw-server static">
            <div className="sw-server-row">
              <span className="sw-server-toggle static">
                <Dot tone={badge?.tone ?? 'muted'} />
                <b>{server.name}</b>
                <span className="sw-tag">{server.source}</span>
                {server.type && <span className="muted">{server.type}</span>}
                <span className={statusClass(badge?.tone ?? 'muted')}>{badge ? badge.label : '—'}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
