import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { handshake, startAppServer, withAppServer } from '../../src/agent/codex/app-server';
import { JsonRpc, RpcError, type Incoming, type IncomingRequest } from '../../src/agent/codex/rpc';
import { isAlive } from '../../src/os-process';
import { codexRecords, fakeCodex } from '../fake-codex/fake';
import { tempDir } from '../helpers';

function pair(onRequest?: (message: IncomingRequest) => void) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const written: unknown[] = [];
  toServer.on('data', (chunk: Buffer) => written.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line))));
  const notes: Incoming[] = [];
  const asked: IncomingRequest[] = [];
  const rpc = new JsonRpc(fromServer, toServer, { notification: (message) => notes.push(message), request: (message) => (onRequest ? onRequest(message) : asked.push(message)) });
  const say = (message: object) => fromServer.write(`${JSON.stringify(message)}\n`);
  return { rpc, say, written, notes, asked, toServer };
}

// Lines and writes travel through the streams asynchronously.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const reason = (error: unknown) => (error as Error).message;

describe('JsonRpc', () => {
  it('pairs answers with requests by id, rejects an error answer, skips lines that are not objects, and hands notifications and server requests on', async () => {
    const { rpc, say, written, notes, asked } = pair();
    const first = rpc.request('model/list', {});
    const second = rpc.request('turn/start', { threadId: 't' }).catch((error: unknown) => error instanceof RpcError && [error.name, error.code, error.message, error.data]);
    say({ id: 2, error: { code: -32600, message: 'no thread', data: { threadId: 't' } } });
    say({ id: 1, result: { data: [] } });
    say({ method: 'turn/started', params: { turn: { id: 'x' } } });
    say({ id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'p' } });
    say([1, 2]);
    rpc.reply(0, { decision: 'decline' });
    const answered = await first;
    await settle();
    expect([answered, await second, notes, asked]).toEqual([
      { data: [] }, ['RpcError', -32600, 'no thread', { threadId: 't' }], [{ method: 'turn/started', params: { turn: { id: 'x' } } }], [{ id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'p' } }],
    ]);
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'model/list', params: {} }, { jsonrpc: '2.0', id: 2, method: 'turn/start', params: { threadId: 't' } }, { jsonrpc: '2.0', id: 0, result: { decision: 'decline' } },
    ]);
  });

  it('answers -32603 to a server request its handler throws on, and refuses a request at once when the app-server no longer reads', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const { rpc, say, written, toServer } = pair(() => {
      throw new Error('handler failed');
    });
    say({ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'p' } });
    await settle();
    toServer.end();
    expect([written, await rpc.request('turn/start', {}).catch(reason)]).toEqual([
      [{ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'CodeRay could not handle item/fileChange/requestApproval.' } }],
      'The app-server no longer reads its input: turn/start was not sent.',
    ]);
  });
});

describe('the app-server process', () => {
  it("starts with CodeRay's flags, records its pid as codex-<pid>, answers through a short-lived server, and is gone after SIGTERM", async () => {
    const dir = tempDir('codex-run-');
    const record = join(dir, 'record.jsonl');
    const account = await withAppServer(fakeCodex(null, record), dir, (rpc) => rpc.request('account/read', { refreshToken: false }));
    const server = startAppServer(fakeCodex(null, record), { cwd: dir, pidDir: dir });
    onTestFinished(() => void server.kill());
    const pidFile = readdirSync(dir).find((name) => /^codex-\d+\.pid\.json$/.test(name));
    const pid = server.pid!;
    await server.kill();
    expect([account, codexRecords(record)[0]?.argv, pidFile, isAlive(pid), existsSync(join(dir, pidFile ?? 'x'))]).toEqual([
      { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
      ['app-server', '-c', 'features.hooks=false', '-c', 'notify=[]'], `codex-${pid}.pid.json`, false, false,
    ]);
  });

  it('rejects the requests of an app-server that exited with its exit and last stderr line, and a probe that gets no answer with its time limit', async () => {
    const dir = tempDir('codex-run-');
    const server = startAppServer(fakeCodex(null, join(dir, 'record.jsonl'), { FAKE_CODEX_CRASH: 'thread/start' }), { cwd: dir });
    onTestFinished(() => void server.kill());
    await handshake(server.rpc);
    const waiting = await server.rpc.request('thread/start', { cwd: dir }).catch(reason);
    const later = await server.rpc.request('thread/start', { cwd: dir }).catch(reason);
    const silent = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
    const probe = await withAppServer(silent, dir, (rpc) => rpc.request('account/read', {}), 300).catch(reason);
    const exited = 'codex app-server exited (code 1): Error: fake-codex crashed on thread/start';
    expect([waiting, later, probe]).toEqual([exited, exited, 'codex app-server did not answer in 0.3 s.']);
  });
});
