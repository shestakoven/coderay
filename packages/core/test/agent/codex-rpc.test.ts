import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startAppServer, withAppServer } from '../../src/agent/codex/app-server';
import { JsonRpc, RpcError, type Incoming, type IncomingRequest } from '../../src/agent/codex/rpc';
import { isAlive } from '../../src/os-process';
import { codexRecords, fakeCodex } from '../fake-codex/fake';
import { tempDir } from '../helpers';

function pair() {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const written: unknown[] = [];
  toServer.on('data', (chunk: Buffer) => written.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line))));
  const notes: Incoming[] = [];
  const asked: IncomingRequest[] = [];
  const rpc = new JsonRpc(fromServer, toServer, { notification: (message) => notes.push(message), request: (message) => asked.push(message) });
  const say = (message: object) => fromServer.write(`${JSON.stringify(message)}\n`);
  return { rpc, say, written, notes, asked, fromServer };
}

describe('JsonRpc', () => {
  it('pairs answers with requests by id, rejects an error answer, skips lines that are not objects, and hands notifications and server requests on', async () => {
    const { rpc, say, written, notes, asked } = pair();
    const first = rpc.request('model/list', {});
    const second = rpc.request('turn/start', { threadId: 't' }).catch((error: unknown) => error instanceof RpcError && [error.code, error.message]);
    say({ id: 2, error: { code: -32600, message: 'no thread' } });
    say({ id: 1, result: { data: [] } });
    say({ method: 'turn/started', params: { turn: { id: 'x' } } });
    say({ id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'p' } });
    say([1, 2]);
    rpc.reply(0, { decision: 'decline' });
    const answered = await first;
    // Lines and writes travel through the streams asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    expect([answered, await second, notes, asked]).toEqual([
      { data: [] }, [-32600, 'no thread'], [{ method: 'turn/started', params: { turn: { id: 'x' } } }], [{ id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'p' } }],
    ]);
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'model/list', params: {} }, { jsonrpc: '2.0', id: 2, method: 'turn/start', params: { threadId: 't' } }, { jsonrpc: '2.0', id: 0, result: { decision: 'decline' } },
    ]);
  });

  it('rejects every request still waiting when the app-server closes its output, and every later one', async () => {
    const { rpc, fromServer } = pair();
    const waiting = rpc.request('thread/start', {});
    fromServer.end();
    await expect(waiting).rejects.toThrow('The app-server closed its output.');
    await expect(rpc.request('turn/start', {})).rejects.toThrow('The app-server closed its output.');
  });
});

describe('the app-server process', () => {
  it("starts with CodeRay's flags, records its pid as codex-<pid>, answers through a short-lived server, and is gone after SIGTERM", async () => {
    const dir = tempDir('codex-run-');
    const record = join(dir, 'record.jsonl');
    const account = await withAppServer(fakeCodex(null, record), dir, (rpc) => rpc.request('account/read', { refreshToken: false }));
    const server = startAppServer(fakeCodex(null, record), { cwd: dir, pidDir: dir });
    onTestFinished(() => void server.kill());
    const pidFile = await new Promise<string | undefined>((resolve) => setTimeout(() => resolve(readdirSync(dir).find((name) => /^codex-\d+\.pid\.json$/.test(name))), 200));
    const pid = server.pid!;
    await server.kill();
    expect([account, codexRecords(record)[0]?.argv, pidFile, isAlive(pid), existsSync(join(dir, pidFile ?? 'x'))]).toEqual([
      { account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
      ['app-server', '-c', 'features.hooks=false', '-c', 'notify=[]'], `codex-${pid}.pid.json`, false, false,
    ]);
  });
});
