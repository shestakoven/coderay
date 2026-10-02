import { useEffect, useReducer, useState, type Dispatch } from 'react';
import type { ClientMessage, ProjectInfo } from '@ide/protocol';
import { browseReducer, initialBrowse, isOpening, type BrowseAction, type BrowseState } from './browse-state';
import { FolderBrowser } from './FolderBrowser';

export interface OpenProjectController {
  state: BrowseState;
  dispatch: Dispatch<BrowseAction>;
}

export function useOpenProject(): OpenProjectController {
  const [state, dispatch] = useReducer(browseReducer, initialBrowse);
  return { state, dispatch };
}

export function OpenProjectDialog({ info, controller, send, onClose, onCloseProject }: {
  info: ProjectInfo | null;
  controller: OpenProjectController;
  send: (message: ClientMessage) => boolean;
  onClose: () => void;
  onCloseProject?: () => boolean;
}) {
  const { state, dispatch } = controller;
  const [closing, setClosing] = useState(false);
  const open = (path: string): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'project.open', requestId, path })) dispatch({ type: 'open', requestId });
  };
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
          <FolderBrowser state={state} dispatch={dispatch} send={send} disabled={opening} start={info?.root ? parentOf(info.root) : null} />
        </section>
        <div className="modal-actions">
          {onCloseProject && info?.root && (
            <button className="link close-project" disabled={opening || closing} onClick={() => { if (onCloseProject()) setClosing(true); }}>
              {closing ? 'Closing…' : 'Close project'}
            </button>
          )}
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
