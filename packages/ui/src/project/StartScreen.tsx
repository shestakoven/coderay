import { useEffect, useRef, useState, type Dispatch, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';
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
  const openRow = useRef<HTMLButtonElement>(null);
  const busy = isWorking(start) || isOpening(browse.state) || dialog;
  const toggle = (view: StartView): void => dispatchStart({ type: 'view', view: start.view === view ? 'home' : view });
  const open = (path: string): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.open', requestId, path })) browse.dispatch({ type: 'open', requestId });
  };
  const closeDialog = (): void => {
    // The Open row is disabled while the dialog is up: re-enable it before handing focus back to it.
    flushSync(() => {
      setDialog(false);
      browse.dispatch({ type: 'reset' });
    });
    openRow.current?.focus();
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
            <ActionRow ref={openRow} icon="folder" title="Open" hint="An existing folder on this machine" opensDialog disabled={busy} onClick={() => { dispatchStart({ type: 'view', view: 'home' }); setDialog(true); }} />
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
                  <button className="recent-row start-recent-row" disabled={busy} onClick={() => { dispatchStart({ type: 'view', view: 'home' }); open(project.path); }} title={project.path}>
                    <b>{project.name}</b>
                    <span className="mono muted">{project.path}</span>
                    <span className="start-recent-ago muted">{formatAgo(now, project.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {start.view === 'home' && !dialog && browse.state.error && <p className="problem" role="alert">{browse.state.error}</p>}
        </aside>
      </main>
      {dialog && (
        <OpenProjectDialog info={info} controller={browse} send={send} onClose={closeDialog} />
      )}
    </div>
  );
}

function ActionRow({ ref, icon, title, hint, expanded, opensDialog, disabled, onClick }: {
  ref?: Ref<HTMLButtonElement>;
  icon: IconName;
  title: string;
  hint: string;
  expanded?: boolean;
  opensDialog?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref} type="button" className={`start-action${expanded ? ' on' : ''}`} aria-expanded={expanded}
      aria-haspopup={opensDialog ? 'dialog' : undefined} disabled={disabled} onClick={onClick}
    >
      <Icon name={icon} size={18} />
      <span className="start-action-title">{title}</span>
      <span className="start-action-hint muted">{hint}</span>
    </button>
  );
}

function CreateForm({ browse, start, dispatchStart, send, busy }: FormProps) {
  const [name, setName] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const input = useRefocusOnError(start.error);
  const parent = browse.state.path;
  const problem = name.trim() === '' ? null : validateProjectName(name);
  const target = parent !== null && name.trim() !== '' && problem === null ? joinPath(parent, name.trim()) : null;
  const ready = !busy && target !== null;
  const submit = (): void => {
    if (!ready || parent === null) return;
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.create', requestId, parent, name: name.trim() })) {
      setSent(target);
      dispatchStart({ type: 'begin', kind: 'create', requestId });
    }
  };
  // Not a <form>: the folder browser inside has its own, and forms cannot nest.
  return (
    <div className="start-form" role="group" aria-label="Create a project">
      <label className="start-field">
        <span className="start-label">Name</span>
        <input
          ref={input} className="start-input mono" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          aria-label="Project name" placeholder="my-project" spellCheck={false} disabled={busy}
        />
      </label>
      <div className="start-field">
        <span className="start-label">Location</span>
        <FolderBrowser state={browse.state} dispatch={browse.dispatch} send={send} disabled={busy} start={browse.state.path} />
      </div>
      {target !== null && <p className="start-target mono muted">Creates {target}</p>}
      {problem && <p className="problem" role="alert">{problem}</p>}
      {start.error && sent === target && <p className="problem" role="alert">{start.error}</p>}
      <div className="modal-actions">
        <span className="muted" role="status">{start.work?.kind === 'create' ? 'Creating and opening…' : ''}</span>
        <button type="button" className="primary" disabled={!ready} onClick={submit}>Create</button>
      </div>
    </div>
  );
}

function CloneForm({ browse, start, dispatchStart, send, busy }: FormProps) {
  const [url, setUrl] = useState('');
  const [typedName, setTypedName] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const input = useRefocusOnError(start.error);
  const parent = browse.state.path;
  const name = typedName.trim() === '' ? projectNameFromUrl(url) : typedName.trim();
  const problem = name === '' ? null : validateProjectName(name);
  const target = parent !== null && name !== '' && problem === null ? joinPath(parent, name) : null;
  const attempt = `${url.trim()} -> ${target}`;
  const work = start.work?.kind === 'clone' ? start.work : null;
  const progress = work ? `${work.phase ? PHASE_LABEL[work.phase] : 'Starting…'}${work.percent !== null ? ` ${work.percent}%` : ''}` : '';
  const ready = !busy && url.trim() !== '' && target !== null;
  const submit = (): void => {
    if (!ready || parent === null) return;
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.clone', requestId, url: url.trim(), parent, name })) {
      setSent(attempt);
      dispatchStart({ type: 'begin', kind: 'clone', requestId });
    }
  };
  const onEnter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') submit();
  };
  return (
    <div className="start-form" role="group" aria-label="Clone a repository">
      <label className="start-field">
        <span className="start-label">Repository URL</span>
        <input
          ref={input} className="start-input mono" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={onEnter}
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
      {target !== null && <p className="start-target mono muted">Clones into {target}</p>}
      {problem && <p className="problem" role="alert">{problem}</p>}
      {start.error && sent === attempt && <p className="problem" role="alert">{start.error}</p>}
      {/* Progress and Cancel go beside Clone, not above it: a second click on Clone must not land on Cancel. */}
      <div className="modal-actions">
        {work && (
          <>
            <div className="clone-progress">
              <span>{progress}</span>
              <div
                className={`progress${work.percent === null ? ' indeterminate' : ''}`} role="progressbar" aria-label="Clone progress"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={work.percent ?? undefined} aria-valuetext={progress}
              >
                <i style={work.percent === null ? undefined : { width: `${work.percent}%` }} />
              </div>
            </div>
            <button type="button" onClick={() => send({ type: 'project.clone.cancel', requestId: work.requestId })}>Cancel</button>
          </>
        )}
        <button type="button" className="primary" disabled={!ready} onClick={submit}>Clone</button>
      </div>
    </div>
  );
}

/** Returns a ref for the form's first field and focuses it when a request fails: the disabled controls dropped focus to the page. */
function useRefocusOnError(error: string | null): RefObject<HTMLInputElement | null> {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  return ref;
}
