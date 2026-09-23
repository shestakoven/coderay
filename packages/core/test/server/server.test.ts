import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MapSnapshot, ServerMessage } from '@ide/protocol';
import { startServer, type RunningServer } from '../../src/server/server';
import { tempDir, waitFor } from '../helpers';

const snapshot = (version: number): MapSnapshot => ({
  version, projectName: 'demo', files: [], components: [], fileEdges: [],
});

let server: RunningServer;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  const root = tempDir('ide-server-');
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', 'index.html'), '<h1>ide</h1>');
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  server = await startServer({
    port: 0,
    staticDir: join(root, 'public'),
    allowedOrigins: ['http://localhost:5173'],
    snapshot: () => snapshot(1),
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server.close();
});

function openClient(headers: Record<string, string>): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    socket.once('open', () => resolve(messages));
    socket.once('error', reject);
  });
}

describe('server', () => {
  it('sends the current snapshot to a same-origin client on connect', async () => {
    const messages = await openClient({ origin: `http://127.0.0.1:${server.port}` });
    const first = await waitFor(() => messages[0]);
    expect(first).toEqual({ type: 'map.snapshot', snapshot: snapshot(1) });
  });

  it('broadcasts messages to connected clients', async () => {
    const messages = await openClient({});
    await waitFor(() => messages[0]);
    server.broadcast({ type: 'map.snapshot', snapshot: snapshot(2) });
    const second = await waitFor(() => messages[1]);
    expect(second.snapshot.version).toBe(2);
  });

  it('accepts a configured development origin', async () => {
    const messages = await openClient({ origin: 'http://localhost:5173' });
    expect((await waitFor(() => messages[0])).type).toBe('map.snapshot');
  });

  it('rejects a page from another origin', async () => {
    await expect(openClient({ origin: 'http://evil.example' })).rejects.toThrow('401');
  });

  it('rejects a DNS-rebinding request whose host is not local', async () => {
    const host = `evil.example:${server.port}`;
    await expect(openClient({ host, origin: `http://${host}` })).rejects.toThrow('401');
  });

  it('serves static files and refuses paths outside the static directory', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe('<h1>ide</h1>');
    expect((await fetch(`${base}/..%2Fsecret.txt`)).status).toBe(403);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });
});
