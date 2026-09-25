import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage, SettingsView } from '@ide/protocol';
import { ChatPanel } from './chat/ChatPanel';
import { chatReducer, initialChatState } from './chat/chat-state';
import { DetailsPanel } from './map/DetailsPanel';
import { initialMapState, mapReducer } from './map/map-state';
import { MapView } from './map/MapView';
import { connect, fitsFrame, type Connection, type ConnectionStatus } from './net/socket';
import { hashToken, launchToken } from './net/token';
import { SettingsPanel, type SettingsResult } from './settings/SettingsPanel';

export function App() {
  const token = useMemo(launchToken, []);
  const [state, dispatch] = useReducer(mapReducer, initialMapState);
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const connection = useRef<Connection | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      if (hashToken(location.hash)) location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!token) return;
    const current = connect(token, (message) => {
      switch (message.type) {
        case 'map.snapshot':
          dispatch({ type: 'snapshot', snapshot: message.snapshot });
          break;
        case 'session.snapshot':
          dispatchChat({ type: 'snapshot', state: message.state });
          break;
        case 'session.patch':
          dispatchChat({ type: 'patch', patch: message.patch });
          break;
        case 'settings.snapshot':
          setSettings(message.settings);
          break;
        case 'settings.result':
          setSettingsResult({ requestId: message.requestId, error: message.error });
          break;
        case 'error':
          dispatchChat({ type: 'error', message: message.message });
          break;
      }
    }, setStatus);
    connection.current = current;
    return () => current.close();
  }, [token]);

  if (!token) {
    return <div className="no-token">Open the address the IDE core printed when it started: it carries this launch's access token.</div>;
  }

  const send = (message: ClientMessage): boolean => {
    if (!fitsFrame(message)) {
      dispatchChat({ type: 'error', message: 'This message is too long to send: the limit is 64 KiB.' });
      return false;
    }
    if (!connection.current?.send(message)) {
      dispatchChat({ type: 'error', message: 'Not connected to the IDE core.' });
      return false;
    }
    return true;
  };

  const openSettings = (): void => {
    send({ type: 'settings.get' });
    setSettingsOpen(true);
  };
  const toReview = (settings?.servers.filter((server) => server.status === 'unapproved').length ?? 0)
    + (settings?.externalEdits.ideServers || settings?.externalEdits.trust ? 1 : 0);

  const snapshot = state.snapshot;
  return (
    <div className="app">
      <header className="topbar">
        <span className="project">{snapshot?.projectName ?? '…'}</span>
        {snapshot && (
          <span className="muted">
            {snapshot.files.length} files · {snapshot.components.length} components
          </span>
        )}
        <span className="badge danger" title="No pre-execution gate yet (Plan 4): the agent runs with --dangerously-skip-permissions.">
          unguarded
        </span>
        <button className="link" onClick={openSettings}>
          MCP servers{toReview > 0 ? ` · ${toReview} to review` : ''}
        </button>
        <span className={`status ${status}`}>{status === 'open' ? 'live ●' : status}</span>
      </header>
      <main className="body">
        <div className="map-area">
          <ReactFlowProvider>
            <MapView state={state} dispatch={dispatch} />
          </ReactFlowProvider>
          <DetailsPanel state={state} />
        </div>
        <ChatPanel chat={chat} send={send} onDismissError={() => dispatchChat({ type: 'dismiss-error' })} />
      </main>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          lastResult={settingsResult}
          sessionServers={chat.mcpServers}
          send={send}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
