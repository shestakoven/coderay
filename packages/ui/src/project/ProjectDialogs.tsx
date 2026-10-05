import { useEffect, useState, type Dispatch } from 'react';
import type { ClientMessage, HubProject } from '@ide/protocol';
import { isOpening } from './browse-state';
import type { OpenProjectController } from './OpenProjectDialog';
import { CloneForm, CreateForm } from './StartScreen';
import { isWorking, type StartAction, type StartState } from './start-state';
import type { StatusKind } from './project-status';

export function NewProjectDialog({ initial, browse, start, dispatchStart, send, onClose }: {
  initial: 'create' | 'clone';
  browse: OpenProjectController;
  start: StartState;
  dispatchStart: Dispatch<StartAction>;
  send: (message: ClientMessage) => boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState(initial);
  const busy = isWorking(start) || isOpening(browse.state);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const form = { browse, start, dispatchStart, send, busy };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New project" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="open-project">
        <div className="settings-header">
          <h2>{view === 'create' ? 'New project' : 'Clone repository'}</h2>
          <button className="link" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <div className="ptabs" role="tablist" aria-label="Kind" style={{ padding: 0, marginBottom: 8 }}>
          <button role="tab" aria-selected={view === 'create'} className={view === 'create' ? 'on' : ''} disabled={busy} onClick={() => setView('create')}>Create</button>
          <button role="tab" aria-selected={view === 'clone'} className={view === 'clone' ? 'on' : ''} disabled={busy} onClick={() => setView('clone')}>Clone</button>
        </div>
        {view === 'create' ? <CreateForm {...form} /> : <CloneForm {...form} />}
      </div>
    </div>
  );
}

export function CloseProjectDialog({ name, kind, onConfirm, onCancel }: { name: string; kind: StatusKind; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Close ${name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="open-project" style={{ width: 'min(440px, calc(100vw - 32px))' }}>
        <div className="settings-header"><h2>Close {name}?</h2></div>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {kind === 'working' ? 'Its agent is working. Closing the project stops it.' : 'Its agent is waiting for your answer. Closing the project drops the question.'}
        </p>
        <div className="modal-actions">
          <button onClick={onCancel} autoFocus>Keep open</button>
          <button className="primary" onClick={onConfirm}>Close project</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectNote({ project, onRestart, onClose }: { project: HubProject; onRestart: () => void; onClose: () => void }) {
  if (project.state === 'starting') {
    return (
      <div className="project-note" role="status">
        <i className="project-spin" />
        <b>Opening {project.name}…</b>
        <span>A large project can take a minute while its map is built.</span>
      </div>
    );
  }
  return (
    <div className="project-note" role="alert">
      <b>{project.name} did not start</b>
      <span className="problem">{project.error ?? 'The IDE core stopped.'}</span>
      <div className="note-row">
        <button className="pbtn primary" onClick={onRestart}>Try again</button>
        <button className="pbtn" onClick={onClose}>Close project</button>
      </div>
    </div>
  );
}
