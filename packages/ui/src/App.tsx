import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useReducer, useState } from 'react';
import { DetailsPanel } from './map/DetailsPanel';
import { initialMapState, mapReducer } from './map/map-state';
import { MapView } from './map/MapView';
import { describeMapStatus } from './map/status';
import { connect, type ConnectionStatus } from './net/socket';

export function App() {
  const [state, dispatch] = useReducer(mapReducer, initialMapState);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(
    () =>
      connect((message) => {
        if (message.type === 'map.snapshot') dispatch({ type: 'snapshot', snapshot: message.snapshot });
      }, setStatus),
    [],
  );

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
        {snapshot &&
          describeMapStatus(snapshot.status).map((chip) => (
            <span key={chip.text} className={`chip ${chip.tone}`} title={chip.title}>
              {chip.text}
            </span>
          ))}
        <span className={`status ${status}`}>{status === 'open' ? 'live ●' : status}</span>
      </header>
      <main className="body">
        <ReactFlowProvider>
          <MapView state={state} dispatch={dispatch} />
        </ReactFlowProvider>
        <DetailsPanel state={state} />
      </main>
    </div>
  );
}
