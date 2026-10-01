import { useEffect, useReducer, useState, type Dispatch } from 'react';
import type { ClientMessage, ProjectInfo } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { browseReducer, initialBrowse, isOpening, joinPath, type BrowseAction, type BrowseState } from './browse-state';

export interface OpenProjectController {
  state: BrowseState;
  dispatch: Dispatch<BrowseAction>;
}

export function useOpenProject(): OpenProjectController {
  const [state, dispatch] = useReducer(browseReducer, initialBrowse);
  return { state, dispatch };
}

export function OpenProjectDialog({ info, controller, send, onClose }: {
  info: ProjectInfo | null;
  controller: OpenProjectController;
  send: (message: ClientMessage) => boolean;
  onClose: () => void;
}) {
  const { state, dispatch } = controller;
  const [typed, setTyped] = useState('');
  const list = (path: string | null): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'fs.list', requestId, path })) dispatch({ type: 'list', requestId });
  };
  const open = (path: string): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.open', requestId, path })) dispatch({ type: 'open', requestId });
  };
  useEffect(() => {
    list(info?.root ? parentOf(info.root) : null);
    // first listing only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state.path !== null) setTyped(state.path);
  }, [state.path]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isOpening(state)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);
  const opening = isOpening(state);
  const recent = (info?.recent ?? []).filter((project) => project.path !== info?.root).slice(0, 6);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Open project" onMouseDown={(event) => { if (event.target === event.currentTarget && !opening) onClose(); }}>
      <div className="open-project">
        <div className="settings-header">
          <h2>Open project</h2>
          <button className="link" onClick={onClose} disabled={opening}>Close</button>
        </div>
        {recent.length > 0 && (
          <section>
            <h3>Recent</h3>
            <ul className="recent">
              {recent.map((project) => (
                <li key={project.path}>
                  <button className="recent-row" disabled={opening} onClick={() => open(project.path)} title={project.path}>
                    <b>{project.name}</b>
                    <span className="mono muted">{project.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>Browse</h3>
          <form className="path-row" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) list(typed.trim()); }}>
            <button type="button" disabled={state.parent === null || opening} onClick={() => state.parent && list(state.parent)} title="Parent folder" aria-label="Parent folder">↑</button>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} aria-label="Folder path" spellCheck={false} className="mono" />
            <button type="submit" disabled={opening}>Go</button>
          </form>
          {state.error && <p className="problem" role="alert">{state.error}</p>}
          <ul className="dirs" aria-label="Folders">
            {state.entries.length === 0 && state.pending === null && !state.error && <li className="muted dir-empty">No subfolders.</li>}
            {state.entries.map((entry) => (
              <li key={entry.name}>
                <button className="dir-row" disabled={opening} onClick={() => state.path && list(joinPath(state.path, entry.name))}>
                  <Icon name="folder" size={16} />
                  <span>{entry.name}</span>
                  {entry.isGit && <span className="tag ok">git</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <div className="modal-actions">
          {opening && <span className="muted">Restarting the IDE core on the new project…</span>}
          <button onClick={onClose} disabled={opening}>Cancel</button>
          <button className="primary" disabled={state.path === null || opening} onClick={() => state.path && open(state.path)}>
            Open this folder
          </button>
        </div>
      </div>
    </div>
  );
}

const parentOf = (path: string): string | null => {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : null;
};
