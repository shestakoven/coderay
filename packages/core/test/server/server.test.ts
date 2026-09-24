import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { MapSnapshot, ServerMessage } from '@ide/protocol';
import { startServer, type RunningServer } from '../../src/server/server';
import { tempDir, waitFor } from '../helpers';

const snapshot = (version: number): MapSnapshot => ({
  version, projectName: 'demo', files: [], components: [], fileEdges: [],
});

const versionOf = (message: ServerMessage | undefined): number | undefined =>
  message?.type === 'map.snapshot' ? message.snapshot.version : undefined;

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

function connect(headers: Record<string, string>): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function openClient(headers: Record<string, string>): Promise<ServerMessage[]> {
  return (await connect(headers)).messages;
}

function httpRequest(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      resolve(res.statusCode ?? 500);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server', () => {
  it('sends the current snapshot to a same-origin client on connect', async () => {
    const messages = await openClient({ origin: `http://127.0.0.1:${server.port}` });
    const first = await waitFor(() => messages[0], 'snapshot on connect');
    expect(first).toEqual({ type: 'map.snapshot', snapshot: snapshot(1) });
  });

  it('broadcasts messages to connected clients', async () => {
    const messages = await openClient({});
    await waitFor(() => messages[0], 'snapshot on connect');
    server.broadcast({ type: 'map.snapshot', snapshot: snapshot(2) });
    const second = await waitFor(() => messages[1], 'broadcast received');
    expect(versionOf(second)).toBe(2);
  });

  it('accepts a configured development origin', async () => {
    const messages = await openClient({ origin: 'http://localhost:5173' });
    expect((await waitFor(() => messages[0], 'snapshot on connect')).type).toBe('map.snapshot');
  });

  it('rejects a page from another origin', async () => {
    await expect(openClient({ origin: 'http://evil.example' })).rejects.toThrow('401');
  });

  it('rejects a DNS-rebinding request whose host is not local', async () => {
    const host = `evil.example:${server.port}`;
    await expect(openClient({ host, origin: `http://${host}` })).rejects.toThrow('401');
  });

  it('serves index.html for the root path', async () => {
    const index = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe('<h1>ide</h1>');
  });

  it('refuses a static path that escapes the static directory', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/..%2Fsecret.txt`)).status).toBe(403);
  });

  it('answers 404 for a missing static file', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/missing.js`)).status).toBe(404);
  });

  it('refuses static requests whose host is not local', async () => {
    const status = await httpRequest('/', { host: `evil.example:${server.port}` });
    expect(status).toBe(401);
  });

  it('rejects startup when the port is already taken', async () => {
    await expect(startServer({ port: server.port, snapshot: () => snapshot(1) })).rejects.toThrow('EADDRINUSE');
  });

  it('refuses a symlink that points outside the static directory', async () => {
    const root = tempDir('ide-server-');
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'public', 'leak.txt'));
    const svr = await startServer({
      port: 0,
      staticDir: join(root, 'public'),
      snapshot: () => snapshot(1),
    });
    const status = await httpRequest('/', { host: `127.0.0.1:${svr.port}` });
    await fetch(`http://127.0.0.1:${svr.port}/leak.txt`).then((res) => expect(res.status).toBe(403));
    await svr.close();
  });

  it('broadcasts messages as text frames', async () => {
    const { socket, messages } = await connect({});
    await waitFor(() => messages[0], 'snapshot on connect');
    const binaryFlags: boolean[] = [];
    socket.on('message', (_data, isBinary) => binaryFlags.push(isBinary));

    server.broadcast({ type: 'map.snapshot', snapshot: snapshot(2) });

    await waitFor(() => binaryFlags.length === 1, 'broadcast received');
    expect(binaryFlags).toEqual([false]);
  });

  it('sends a client that stops reading the latest snapshot instead of every broadcast', async () => {
    const { socket, messages } = await connect({});
    await waitFor(() => messages[0], 'snapshot on connect');
    const large = (version: number): MapSnapshot => ({ ...snapshot(version), projectName: 'x'.repeat(10 * 1024 * 1024) });

    socket.pause();
    for (let version = 2; version <= 11; version++) server.broadcast({ type: 'map.snapshot', snapshot: large(version) });
    socket.resume();

    await waitFor(() => versionOf(messages.at(-1)) === 11, 'latest snapshot received');
    expect(messages.length).toBeLessThan(11);
  });

  it('keeps serving other clients after a client sends an invalid frame', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = await connect({});
      const good = await connect({});
      await waitFor(() => good.messages[0], 'snapshot on connect');

      bad.socket.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
      await waitFor(() => bad.socket.readyState === WebSocket.CLOSED, 'invalid client closed');
      server.broadcast({ type: 'map.snapshot', snapshot: snapshot(2) });

      expect(versionOf(await waitFor(() => good.messages[1], 'broadcast received'))).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('server: client error', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('closes a client that sends a frame larger than 64 KiB', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { socket } = await connect({});
      const closeCode = new Promise<number>((resolve) => socket.once('close', resolve));

      socket.send('x'.repeat(64 * 1024 + 1));

      expect(await closeCode).toBe(1009);
    } finally {
      consoleError.mockRestore();
    }
  });
});
