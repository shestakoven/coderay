import { useState, type Dispatch } from 'react';
import { projectNameFromUrl, validateProjectName, type ClientMessage, type ProjectInfo } from '@ide/protocol';
import { Icon, type IconName } from '../layout/Icon';
import type { ConnectionStatus } from '../net/socket';
import { isOpening, joinPath } from './browse-state';
import { FolderBrowser } from './FolderBrowser';
import { OpenProjectDialog, type OpenProjectController } from './OpenProjectDialog';
import { formatAgo, isWorking, PHASE_LABEL, type StartAction, type StartState, type StartView } from './start-state';

interface FormProps {
  browse: OpenProjectController;
  start: StartState;
  dispatchStart: Dispatch<StartAction>;
  send: (message: ClientMessage) => boolean;
  busy: boolean;
}

export function StartScreen({ info, status, browse, start, dispatchStart, send }: Omit<FormProps, 'busy'> & { info: ProjectInfo; status: ConnectionStatus }) {
  const [dialog, setDialog] = useState(false);
  const busy = isWorking(start) || isOpening(browse.state);
  const toggle = (view: StartView): void => dispatchStart({ type: 'view', view: start.view === view ? 'home' : view });
  const open = (path: string): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.open', requestId, path })) browse.dispatch({ type: 'open', requestId });
  };
  const now = Date.now();
  const form = { browse, start, dispatchStart, send, busy };
  return (
    <div className="app start">
      <header className="topbar">
        <span className="topbar-spacer" />
        <span className={`conn ${status}`}><i className="dot" />{status === 'open' ? 'core connected' : status}</span>
      </header>
      <main className="start-body">
        <section className="start-main" aria-label="Start">
          <h1 className="start-title">AI Control IDE</h1>
          <p className="start-lead muted">Open a project, start a new one or clone a repository.</p>
          <div className="start-actions">
            <ActionRow icon="plus" title="Create" hint="A new folder with an empty git repository" expanded={start.view === 'create'} disabled={busy} onClick={() => toggle('create')} />
            {start.view === 'create' && <CreateForm {...form} />}
            <ActionRow icon="folder" title="Open" hint="An existing folder on this machine" disabled={busy} onClick={() => setDialog(true)} />
            <ActionRow icon="git-branch" title="Clone" hint="A git repository from a URL" expanded={start.view === 'clone'} disabled={busy} onClick={() => toggle('clone')} />
            {start.view === 'clone' && <CloneForm {...form} />}
          </div>
        </section>
        <aside className="start-recent" aria-label="Recent projects">
          <h2>Recent</h2>
          {info.recent.length === 0 ? (
            <p className="muted">No recent projects yet.</p>
          ) : (
            <ul>
              {info.recent.map((project) => (
                <li key={project.path}>
                  <button className="recent-row start-recent-row" disabled={busy} onClick={() => open(project.path)} title={project.path}>
                    <b>{project.name}</b>
                    <span className="mono muted">{project.path}</span>
                    <span className="muted">{formatAgo(now, project.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {start.view === 'home' && !dialog && browse.state.error && <p className="problem" role="alert">{browse.state.error}</p>}
        </aside>
      </main>
      {dialog && (
        <OpenProjectDialog info={info} controller={browse} send={send} onClose={() => { setDialog(false); browse.dispatch({ type: 'reset' }); }} />
      )}
    </div>
  );
}

function ActionRow({ icon, title, hint, expanded, disabled, onClick }: {
  icon: IconName;
  title: string;
  hint: string;
  expanded?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`start-action${expanded ? ' on' : ''}`} aria-expanded={expanded} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={18} />
      <span className="start-action-title">{title}</span>
      <span className="start-action-hint muted">{hint}</span>
    </button>
  );
}

function CreateForm({ browse, start, dispatchStart, send, busy }: FormProps) {
  const [name, setName] = useState('');
  const parent = browse.state.path;
  const problem = name.trim() === '' ? null : validateProjectName(name);
  const ready = !busy && parent !== null && name.trim() !== '' && problem === null;
  const submit = (): void => {
    if (!ready || parent === null) return;
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.create', requestId, parent, name: name.trim() })) dispatchStart({ type: 'begin', kind: 'create', requestId });
  };
  // Not a <form>: the folder browser inside has its own, and forms cannot nest.
  return (
    <div className="start-form" role="group" aria-label="Create a project">
      <label className="start-field">
        <span className="start-label">Name</span>
        <input
          className="start-input mono" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          aria-label="Project name" placeholder="my-project" spellCheck={false} disabled={busy}
        />
      </label>
      <div className="start-field">
        <span className="start-label">Location</span>
        <FolderBrowser state={browse.state} dispatch={browse.dispatch} send={send} disabled={busy} start={browse.state.path} />
      </div>
      {parent !== null && name.trim() !== '' && <p className="start-target mono muted">Creates {joinPath(parent, name.trim())}</p>}
      {problem && <p className="problem" role="alert">{problem}</p>}
      {start.error && <p className="problem" role="alert">{start.error}</p>}
      <div className="modal-actions">
        {start.work?.kind === 'create' && <span className="muted">Creating and opening…</span>}
        <button type="button" className="primary" disabled={!ready} onClick={submit}>Create</button>
      </div>
    </div>
  );
}

function CloneForm({ browse, start, dispatchStart, send, busy }: FormProps) {
  const [url, setUrl] = useState('');
  const [typedName, setTypedName] = useState('');
  const parent = browse.state.path;
  const name = typedName.trim() === '' ? projectNameFromUrl(url) : typedName.trim();
  const problem = name === '' ? null : validateProjectName(name);
  const work = start.work?.kind === 'clone' ? start.work : null;
  const ready = !busy && parent !== null && url.trim() !== '' && name !== '' && problem === null;
  const submit = (): void => {
    if (!ready || parent === null) return;
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.clone', requestId, url: url.trim(), parent, name })) dispatchStart({ type: 'begin', kind: 'clone', requestId });
  };
  const onEnter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') submit();
  };
  return (
    <div className="start-form" role="group" aria-label="Clone a repository">
      <label className="start-field">
        <span className="start-label">Repository URL</span>
        <input
          className="start-input mono" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={onEnter}
          aria-label="Repository URL" placeholder="https://github.com/org/repo.git" spellCheck={false} disabled={busy}
        />
      </label>
      <label className="start-field">
        <span className="start-label">Folder name</span>
        <input
          className="start-input mono" value={typedName} onChange={(event) => setTypedName(event.target.value)} onKeyDown={onEnter}
          aria-label="Folder name" placeholder={projectNameFromUrl(url) || 'repo'} spellCheck={false} disabled={busy}
        />
      </label>
      <div className="start-field">
        <span className="start-label">Location</span>
        <FolderBrowser state={browse.state} dispatch={browse.dispatch} send={send} disabled={busy} start={browse.state.path} />
      </div>
      {parent !== null && name !== '' && <p className="start-target mono muted">Clones into {joinPath(parent, name)}</p>}
      {problem && <p className="problem" role="alert">{problem}</p>}
      {start.error && <p className="problem" role="alert">{start.error}</p>}
      {work && (
        <div className="clone-progress" role="status">
          <span>{work.phase ? PHASE_LABEL[work.phase] : 'Starting…'}{work.percent !== null ? ` ${work.percent}%` : ''}</span>
          <button type="button" onClick={() => send({ type: 'project.clone.cancel', requestId: work.requestId })}>Cancel</button>
          <div className={`progress${work.percent === null ? ' indeterminate' : ''}`}><i style={{ width: `${work.percent ?? 0}%` }} /></div>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="primary" disabled={!ready} onClick={submit}>Clone</button>
      </div>
    </div>
  );
}
