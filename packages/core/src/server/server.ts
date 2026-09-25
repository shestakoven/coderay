import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_CLIENT_FRAME_BYTES, type ClientMessage, type MapSnapshot, type ServerMessage } from '@ide/protocol';
import { parseClientMessage } from './client-messages';

export interface ServerOptions {
  port: number;
  token: string;
  staticDir?: string;
  allowedOrigins?: string[];
  snapshot: () => MapSnapshot;
  greeting?: () => ServerMessage[];
  onClientMessage?: (message: ClientMessage, reply: (message: ServerMessage) => void) => void;
}

export interface RunningServer {
  port: number;
  broadcast(message: ServerMessage): void;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_ORDERED_BACKLOG_BYTES = 8 * 1024 * 1024;
const CATCH_UP_INTERVAL_MS = 250;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  let port = 0;
  const http = createServer((req, res) => {
    if (!isLocalHost(req.headers.host, port)) {
      res.writeHead(401).end();
      return;
    }
    void serveStatic(options.staticDir, req.url ?? '/', res);
  });
  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => isAllowedUpgrade(req, origin, port, options),
  });

  const orderedBacklog = new WeakMap<WebSocket, number>();
  const orderedOverLimitTicks = new WeakMap<WebSocket, number>();
  const sendOrdered = (client: WebSocket, data: Buffer): void => {
    orderedBacklog.set(client, (orderedBacklog.get(client) ?? 0) + data.length);
    client.send(data, { binary: false }, () => orderedBacklog.set(client, (orderedBacklog.get(client) ?? data.length) - data.length));
  };

  wss.on('connection', (socket) => {
    socket.on('error', (error) => console.error('server: client error', error));
    const reply = (message: ServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      const data = Buffer.from(JSON.stringify(message));
      if (message.type === 'map.snapshot') socket.send(data, { binary: false });
      else sendOrdered(socket, data);
    };
    socket.on('message', (data, isBinary) => {
      const message = isBinary ? null : parseClientMessage(String(data));
      if (!message) {
        reply({ type: 'error', message: 'invalid client message' });
        return;
      }
      try {
        options.onClientMessage?.(message, reply);
      } catch (error) {
        reply({ type: 'error', message: (error as Error).message });
      }
    });
    reply({ type: 'map.snapshot', snapshot: options.snapshot() });
    for (const message of options.greeting?.() ?? []) reply(message);
  });

  await new Promise<void>((resolveListen, reject) => {
    const onStartupError = (error: Error): void => reject(error);
    http.once('error', onStartupError);
    wss.once('error', onStartupError);
    http.listen(options.port, HOST, () => {
      http.removeListener('error', onStartupError);
      wss.removeListener('error', onStartupError);
      resolveListen();
    });
  });
  port = (http.address() as AddressInfo).port;
  wss.on('error', (error) => console.error('server: websocket error', error));

  let latest: Buffer | undefined;
  const behind = new Set<WebSocket>();
  const deliver = (client: WebSocket, data: Buffer): void => {
    if (client.readyState !== client.OPEN) {
      behind.delete(client);
    } else if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      behind.add(client);
    } else {
      behind.delete(client);
      client.send(data, { binary: false });
    }
  };
  const catchUp = setInterval(() => {
    if (latest) for (const client of behind) deliver(client, latest);
    // ws send callbacks land asynchronously, so judge the ordered backlog here, not at queue time.
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      const overLimit = (orderedBacklog.get(client) ?? 0) > MAX_ORDERED_BACKLOG_BYTES;
      const ticks = overLimit ? (orderedOverLimitTicks.get(client) ?? 0) + 1 : 0;
      orderedOverLimitTicks.set(client, ticks);
      if (ticks >= 2) client.terminate();
    }
  }, CATCH_UP_INTERVAL_MS);
  catchUp.unref();

  return {
    port,
    broadcast(message) {
      const data = Buffer.from(JSON.stringify(message));
      if (message.type !== 'map.snapshot') {
        for (const client of wss.clients) if (client.readyState === client.OPEN) sendOrdered(client, data);
        return;
      }
      latest = data;
      for (const client of wss.clients) deliver(client, latest);
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        clearInterval(catchUp);
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.close(() => resolveClose());
      }),
  };
}

function isLocalHost(host: string | undefined, port: number): boolean {
  return !!(host && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host));
}

function isAllowedUpgrade(req: IncomingMessage, origin: string | undefined, port: number, options: ServerOptions): boolean {
  const host = req.headers.host;
  if (!isLocalHost(host, port)) return false;
  if (origin && origin !== `http://${host}` && !(options.allowedOrigins ?? []).includes(origin)) return false;
  return hasToken(req.url, options.token);
}

function hasToken(url: string | undefined, token: string): boolean {
  const given = Buffer.from(new URL(url ?? '/', 'http://localhost').searchParams.get('token') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function serveStatic(staticDir: string | undefined, url: string, res: ServerResponse): Promise<void> {
  if (!staticDir) {
    res.writeHead(404).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const root = resolve(staticDir);
  const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(file);
    if (!realFile.startsWith(realRoot + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}
