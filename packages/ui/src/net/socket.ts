import type { ServerMessage } from '@ide/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export function connect(onMessage: (message: ServerMessage) => void, onStatus: (status: ConnectionStatus) => void): () => void {
  let socket: WebSocket | undefined;
  let attempt = 0;
  let stopped = false;
  let retryTimer: number | undefined;

  const open = () => {
    onStatus('connecting');
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => {
      attempt = 0;
      onStatus('open');
    };
    socket.onmessage = (event) => onMessage(JSON.parse(String(event.data)) as ServerMessage);
    socket.onclose = () => {
      onStatus('closed');
      if (!stopped) retryTimer = window.setTimeout(open, Math.min(5000, 250 * 2 ** attempt++));
    };
  };

  open();
  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    socket?.close();
  };
}
