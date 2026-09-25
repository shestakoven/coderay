import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, MapSnapshot, ServerMessage } from '@ide/protocol';
import { startServer, type RunningServer } from '../../src/server/server';
import { mapStatus, tempDir, waitFor } from '../helpers';

const TOKEN = 'test-launch-token';

const snapshot = (version: number): MapSnapshot => ({
  version, projectName: 'demo', files: [], components: [], fileEdges: [], status: mapStatus(),
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
    token: TOKEN,
    staticDir: join(root, 'public'),
    allowedOrigins: ['http://localhost:5173'],
    snapshot: () => snapshot(1),
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server.close();
});

function connect(
  headers: Record<string, string>,
  port = server.port,
  token: string | null = TOKEN,
): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
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

  it('rejects a WebSocket upgrade without the launch token', async () => {
    await expect(connect({}, server.port, null)).rejects.toThrow('401');
  });

  it('rejects a WebSocket upgrade with a wrong launch token', async () => {
    await expect(connect({}, server.port, 'x'.repeat(TOKEN.length))).rejects.toThrow('401');
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
    await expect(startServer({ port: server.port, token: TOKEN, snapshot: () => snapshot(1) })).rejects.toThrow('EADDRINUSE');
  });

  it('refuses a symlink that points outside the static directory', async () => {
    const root = tempDir('ide-server-');
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'public', 'leak.txt'));
    const svr = await startServer({ port: 0, token: TOKEN, staticDir: join(root, 'public'), snapshot: () => snapshot(1) });
    onTestFinished(() => svr.close());
    expect((await fetch(`http://127.0.0.1:${svr.port}/leak.txt`)).status).toBe(403);
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

  it('sends greeting messages right after the map snapshot on connect', async () => {
    const empty = { session: null, turns: [], items: [], tasks: [], mcpServers: [] };
    const svr = await startServer({ port: 0, token: TOKEN, snapshot: () => snapshot(1), greeting: () => [{ type: 'session.snapshot', state: empty }] });
    onTestFinished(() => svr.close());
    const { messages } = await connect({}, svr.port);
    await waitFor(() => messages[1], 'greeting');
    expect(messages.map((message) => message.type)).toEqual(['map.snapshot', 'session.snapshot']);
  });

  it('sends no map snapshot before one exists and still sends the greeting', async () => {
    const svr = await startServer({
      port: 0,
      token: TOKEN,
      snapshot: () => null,
      greeting: () => [{ type: 'map.progress', progress: { indexing: { indexed: 3 }, embedding: null } }],
    });
    onTestFinished(() => svr.close());
    const { messages } = await connect({}, svr.port);
    await waitFor(() => messages[0], 'greeting');
    expect(messages).toEqual([{ type: 'map.progress', progress: { indexing: { indexed: 3 }, embedding: null } }]);
  });

  it('keeps the connection and the server up when the greeting throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const svr = await startServer({
        port: 0,
        token: TOKEN,
        snapshot: () => snapshot(1),
        greeting: () => {
          throw new Error('registry unreadable');
        },
        onClientMessage: (message, reply) => reply({ type: 'error', message: 'handled' }),
      });
      onTestFinished(() => svr.close());

      const { socket, messages } = await connect({}, svr.port);
      await waitFor(() => messages[1], 'error after the snapshot');
      expect(messages[0]).toEqual({ type: 'map.snapshot', snapshot: snapshot(1) });
      expect(messages[1]).toEqual({ type: 'error', message: 'registry unreadable' });
      expect(consoleError).toHaveBeenCalledWith('server: greeting failed', expect.any(Error));

      const second = await connect({}, svr.port);
      await waitFor(() => second.messages[1], 'second client also greeted and errored');
      expect(second.messages[0]).toEqual({ type: 'map.snapshot', snapshot: snapshot(1) });

      socket.send(JSON.stringify({ type: 'chat.send', text: 'hi' }));
      await waitFor(() => messages[2], 'reply to a normal message on the first connection');
      expect(messages[2]).toEqual({ type: 'error', message: 'handled' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the server up when the snapshot throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const svr = await startServer({
        port: 0,
        token: TOKEN,
        snapshot: () => {
          throw new Error('index unreadable');
        },
        onClientMessage: (message, reply) => reply({ type: 'error', message: 'handled' }),
      });
      onTestFinished(() => svr.close());

      const { socket, messages } = await connect({}, svr.port);
      await waitFor(() => messages[0], 'error reply');
      expect(messages[0]).toEqual({ type: 'error', message: 'index unreadable' });
      expect(consoleError).toHaveBeenCalledWith('server: greeting failed', expect.any(Error));

      socket.send(JSON.stringify({ type: 'chat.send', text: 'hi' }));
      await waitFor(() => messages[1], 'reply to a normal message on the same connection');
      expect(messages[1]).toEqual({ type: 'error', message: 'handled' });

      const second = await connect({}, svr.port);
      await waitFor(() => second.messages[0], 'server still accepts a second client');
      expect(second.messages[0]).toEqual({ type: 'error', message: 'index unreadable' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('hands a valid client message to the handler, which can reply to that client', async () => {
    const received: ClientMessage[] = [];
    const svr = await startServer({
      port: 0,
      token: TOKEN,
      snapshot: () => snapshot(1),
      onClientMessage: (message, reply) => {
        received.push(message);
        reply({ type: 'error', message: 'handled' });
      },
    });
    onTestFinished(() => svr.close());
    const { socket, messages } = await connect({}, svr.port);
    socket.send(JSON.stringify({ type: 'chat.send', text: 'hi' }));
    await waitFor(() => messages[1], 'reply');
    expect(received).toEqual([{ type: 'chat.send', text: 'hi' }]);
    expect(messages[1]).toEqual({ type: 'error', message: 'handled' });
  });

  it('answers an invalid client message with an error and keeps the connection open', async () => {
    const { socket, messages } = await connect({});
    socket.send(JSON.stringify({ type: 'chat.send' }));
    await waitFor(() => messages[1], 'error reply');
    expect(messages[1]).toEqual({ type: 'error', message: 'invalid client message' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('disconnects a client that stops reading session messages so it resyncs on reconnect', async () => {
    const { socket, messages } = await connect({});
    await waitFor(() => messages[0], 'snapshot on connect');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const notice = { kind: 'notice' as const, id: 'n1', seq: 1, turnId: null, parentToolUseId: null, text: 'x'.repeat(10 * 1024 * 1024), ts: 0 };

    socket.pause();
    for (let i = 0; i < 3; i += 1) server.broadcast({ type: 'session.patch', patch: { items: [notice] } });
    // Pausing and resuming in the same tick never yields to the event loop, so it cannot exercise real
    // backpressure under a tick-judged backlog; hold the pause across two catch-up ticks instead.
    await new Promise((resolve) => setTimeout(resolve, 600));
    socket.resume();

    await closed;
    expect(messages.length).toBeLessThan(4);
  });

  it('keeps a client that keeps reading connected through an ordered burst over 8 MB', async () => {
    const big = { kind: 'notice' as const, id: 'n1', seq: 1, turnId: null, parentToolUseId: null, text: 'x'.repeat(9 * 1024 * 1024), ts: 0 };
    const small = { kind: 'notice' as const, id: 'n2', seq: 2, turnId: null, parentToolUseId: null, text: 'hi', ts: 0 };
    const svr = await startServer({
      port: 0,
      token: TOKEN,
      snapshot: () => snapshot(1),
      greeting: () => [
        { type: 'session.patch', patch: { items: [big] } },
        { type: 'session.patch', patch: { items: [small] } },
      ],
    });
    onTestFinished(() => svr.close());
    const { socket, messages } = await connect({}, svr.port);

    await waitFor(() => messages.length === 3, 'snapshot and both greeting messages');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps a client that keeps reading connected across more than 8 MB of ordered frames over several ticks', async () => {
    const { socket, messages } = await connect({});
    await waitFor(() => messages[0], 'snapshot on connect');
    const big = (id: string) => ({ kind: 'notice' as const, id, seq: 1, turnId: null, parentToolUseId: null, text: 'x'.repeat(3 * 1024 * 1024), ts: 0 });

    for (let i = 0; i < 4; i += 1) {
      server.broadcast({ type: 'session.patch', patch: { items: [big(`n${i}`)] } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await waitFor(() => messages.length === 5, 'snapshot and all patches received');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps a client that is behind only on map snapshots connected when a session message arrives', async () => {
    const { socket, messages } = await connect({});
    await waitFor(() => messages[0], 'snapshot on connect');
    const large = (version: number): MapSnapshot => ({ ...snapshot(version), projectName: 'x'.repeat(10 * 1024 * 1024) });

    socket.pause();
    for (let version = 2; version <= 4; version++) server.broadcast({ type: 'map.snapshot', snapshot: large(version) });
    server.broadcast({ type: 'session.patch', patch: { mcpServers: [] } });
    socket.resume();

    await waitFor(() => messages.some((message) => message.type === 'session.patch') && versionOf(messages.at(-1)) === 4, 'patch and latest map');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
