import { createServer } from 'node:http';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ApiError, opencodeClient, readSse, type SseEvent } from '../../src/agent/opencode/api';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(handle: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const AUTH = `Basic ${Buffer.from('opencode:pw').toString('base64')}`;

describe('opencodeClient', () => {
  it('sends basic auth and the directory (a query parameter when a header cannot carry it), reads JSON, raises an ApiError with the status and body, and gives up after its timeout', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const base = await serve((req, res) => {
      seen.push({ auth: req.headers.authorization, dir: req.headers['x-opencode-directory'] as string | undefined, url: req.url });
      if (req.url === '/hang') return;
      if (req.url === '/session/nope') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"name":"NotFoundError","data":{"message":"Session not found: nope"}}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"healthy":true}');
    });
    const client = opencodeClient(base, 'pw', '/proj');
    const health = await client.get<{ healthy: boolean }>('/global/health');
    const failure = await client.get('/session/nope').catch((error: unknown) => error);
    const hung = await client.get('/hang', 100).catch((error: Error) => error.message);
    await opencodeClient(base, 'pw', '/проект').get('/global/health');
    expect([health, seen[0], failure instanceof ApiError && [failure.status, failure.body, failure.message], hung, seen.at(-1)]).toEqual([
      { healthy: true },
      { auth: AUTH, dir: '/proj', url: '/global/health' },
      [404, { name: 'NotFoundError', data: { message: 'Session not found: nope' } }, 'opencode answered 404 to GET /session/nope: Session not found: nope'],
      'opencode did not answer GET /hang within 0.1 s',
      { auth: AUTH, dir: undefined, url: `/global/health?directory=${encodeURIComponent('/проект')}` },
    ]);
  });

  it('streams GET /event with the same auth and directory until the signal aborts, and delivers nothing after it', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const base = await serve((req, res) => {
      seen.push({ auth: req.headers.authorization, dir: req.headers['x-opencode-directory'] as string | undefined, url: req.url });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      setTimeout(() => res.write('data: {"type":"session.idle","properties":{"sessionID":"s"}}\n\ndata: {"type":"session.status","properties":{}}\n\n'), 20);
    });
    const controller = new AbortController();
    const events: SseEvent[] = [];
    await opencodeClient(base, 'pw', '/proj').events((event) => {
      events.push(event);
      if (event.type === 'session.idle') controller.abort();
    }, controller.signal);
    expect([events, seen]).toEqual([
      [{ type: 'server.connected', properties: {} }, { type: 'session.idle', properties: { sessionID: 's' } }],
      [{ auth: AUTH, dir: '/proj', url: '/event' }],
    ]);
  });
});

describe('readSse', () => {
  it('splits an SSE body into events across chunk boundaries, skips a frame it cannot read, and stops on abort', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => {
      warn.mockRestore();
    });
    const events: SseEvent[] = [];
    const controller = new AbortController();
    const chunks = ['data: {"type":"a","prop', 'erties":{"n":1}}\n\ndata: nope\n\ndata: {"type":"b","properties":{}}\r\n\r\n', 'data: {"type":"c","properties":{}}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        const next = chunks.shift();
        if (next === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.abort();
          return;
        }
        stream.enqueue(new TextEncoder().encode(next));
      },
    });
    await readSse(body, (event) => events.push(event), controller.signal);
    expect([events, warn.mock.calls]).toEqual([
      [{ type: 'a', properties: { n: 1 } }, { type: 'b', properties: {} }, { type: 'c', properties: {} }],
      [['opencode: unreadable event']],
    ]);
  });
});
