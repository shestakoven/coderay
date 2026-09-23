import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { MapSnapshot, ServerMessage } from '@ide/protocol';

export interface ServerOptions {
  port: number;
  staticDir?: string;
  allowedOrigins?: string[];
  snapshot: () => MapSnapshot;
}

export interface RunningServer {
  port: number;
  broadcast(message: ServerMessage): void;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
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
    void serveStatic(options.staticDir, req.url ?? '/', res);
  });
  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
      isAllowedUpgrade(req.headers.host, origin, port, options.allowedOrigins ?? []),
  });
  wss.on('connection', (socket) => {
    const message: ServerMessage = { type: 'map.snapshot', snapshot: options.snapshot() };
    socket.send(JSON.stringify(message));
  });

  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(options.port, HOST, () => resolveListen());
  });
  port = (http.address() as AddressInfo).port;

  return {
    port,
    broadcast(message) {
      const data = JSON.stringify(message);
      for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.close(() => resolveClose());
      }),
  };
}

function isAllowedUpgrade(host: string | undefined, origin: string | undefined, port: number, allowedOrigins: string[]): boolean {
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  if (!origin) return true;
  return origin === `http://${host}` || allowedOrigins.includes(origin);
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
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}
