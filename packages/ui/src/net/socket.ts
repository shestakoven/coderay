import { MAX_CLIENT_FRAME_BYTES, type ClientMessage, type ServerMessage } from '@ide/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface Connection {
  send(message: ClientMessage): boolean;
  close(): void;
}

export function fitsFrame(message: ClientMessage): boolean {
  return new TextEncoder().encode(JSON.stringify(message)).length <= MAX_CLIENT_FRAME_BYTES;
}

export function connect(
  token: string,
  onMessage: (message: ServerMessage) => void,
  onStatus: (status: ConnectionStatus) => void,
  url?: string,
): Connection {
  let socket: WebSocket | undefined;
  let attempt = 0;
  let stopped = false;
  let retryTimer: number | undefined;

  const open = () => {
    onStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${url ?? `${scheme}://${location.host}/ws`}?token=${encodeURIComponent(token)}`);
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
  return {
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      stopped = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
