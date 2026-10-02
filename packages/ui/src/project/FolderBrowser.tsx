import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { ClientMessage } from '@ide/protocol';
import { Icon } from '../layout/Icon';
import { joinPath, type BrowseAction, type BrowseState } from './browse-state';

export function FolderBrowser({ state, dispatch, send, disabled, start }: {
  state: BrowseState;
  dispatch: Dispatch<BrowseAction>;
  send: (message: ClientMessage) => boolean;
  disabled: boolean;
  start: string | null;
}) {
  const [typed, setTyped] = useState('');
  const edited = useRef(false);
  const list = (path: string | null): void => {
    const requestId = crypto.randomUUID();
    if (send({ type: 'fs.list', requestId, path })) {
      edited.current = false;
      dispatch({ type: 'list', requestId });
    }
  };
  useEffect(() => {
    list(start);
    // first listing only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // a listing that was requested before the user's last keystroke must not overwrite it
    if (state.path !== null && !edited.current) setTyped(state.path);
  }, [state.path]);
  return (
    <>
      <form className="path-row" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) list(typed.trim()); }}>
        <button type="button" disabled={state.parent === null || disabled} onClick={() => state.parent && list(state.parent)} title="Parent folder" aria-label="Parent folder">↑</button>
        <input value={typed} onChange={(event) => { edited.current = true; setTyped(event.target.value); }} aria-label="Folder path" spellCheck={false} className="mono" disabled={disabled} />
        <button type="submit" disabled={disabled}>Go</button>
      </form>
      {state.error && <p className="problem" role="alert">{state.error}</p>}
      <ul className="dirs" aria-label="Folders">
        {state.entries.length === 0 && state.pending === null && !state.error && <li className="muted dir-empty">No subfolders.</li>}
        {state.entries.map((entry) => (
          <li key={entry.name}>
            <button type="button" className="dir-row" disabled={disabled} onClick={() => state.path && list(joinPath(state.path, entry.name))}>
              <Icon name="folder" size={16} />
              <span>{entry.name}</span>
              {entry.isGit && <span className="tag ok">git</span>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
