import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { AGENT_EVENT_SCRIPT } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

interface Seen {
  req?: IncomingMessage;
  body?: string;
}

function run(configPath: string, input: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT_EVENT_SCRIPT, configPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

function config(url: string): string {
  const path = join(tempDir('ide-hook-'), 'hook.json');
  writeFileSync(path, JSON.stringify({ url, secret: 's3cret', sessionId: 's1' }));
  return path;
}

async function core(status: number, answer = '', seen: Seen = {}): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      Object.assign(seen, { req, body });
      res.writeHead(status, answer === '' ? {} : { 'content-type': 'application/json' }).end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

const EVENT = { hook_event_name: 'UserPromptSubmit', session_id: 'claude-1', prompt: 'fix the login' };

describe('agent-event hook script', () => {
  it('posts the session id and the payload of the hook to /hook/event with the agent secret', async () => {
    const seen: Seen = {};
    const url = await core(204, '', seen);
    expect((await run(config(url), JSON.stringify(EVENT))).code).toBe(0);
    expect([seen.req?.method, seen.req?.url, seen.req?.headers.authorization, JSON.parse(seen.body ?? 'null')])
      .toEqual(['POST', '/hook/event', 'Bearer s3cret', { sessionId: 's1', event: EVENT }]);
  });

  it('writes the answer of the core to the output of the hook as it is, and exits 0', async () => {
    const answer = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'заметка 世界' } });
    const result = await run(config(await core(200, answer)), JSON.stringify(EVENT));
    expect(result).toEqual({ code: 0, stdout: answer });
  });

  it('writes nothing when the core has nothing to add', async () => {
    expect(await run(config(await core(204)), JSON.stringify(EVENT))).toEqual({ code: 0, stdout: '' });
  });

  it.each([[401], [400], [500]])('writes nothing and exits 0 when the core answers %i', async (status) => {
    expect(await run(config(await core(status, '{"error":"no"}')), JSON.stringify(EVENT))).toEqual({ code: 0, stdout: '' });
  });

  it('passes a payload of several megabytes through whole', async () => {
    const seen: Seen = {};
    const big = { ...EVENT, prompt: 'x'.repeat(3 * 1024 * 1024) };
    expect((await run(config(await core(204, '', seen)), JSON.stringify(big))).code).toBe(0);
    expect(JSON.parse(seen.body ?? 'null')).toEqual({ sessionId: 's1', event: big });
  });

  it('exits 0 and writes nothing when the core is down', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await run(config(`http://127.0.0.1:${port}/hook`), JSON.stringify(EVENT))).toEqual({ code: 0, stdout: '' });
  });

  it('exits 0 and posts nothing when the payload is not JSON', async () => {
    const seen: Seen = {};
    expect(await run(config(await core(204, '', seen)), 'not json')).toEqual({ code: 0, stdout: '' });
    expect(seen.req).toBeUndefined();
  });

  it('exits 0 and posts nothing when claude gives it no payload at all', async () => {
    const seen: Seen = {};
    expect(await run(config(await core(204, '', seen)), '')).toEqual({ code: 0, stdout: '' });
    expect(seen.req).toBeUndefined();
  });

  it('exits 0 and posts nothing when its config cannot be read', async () => {
    const seen: Seen = {};
    await core(204, '', seen);
    expect((await run(join(tempDir('ide-hook-'), 'missing.json'), JSON.stringify(EVENT))).code).toBe(0);
    const bad = join(tempDir('ide-hook-'), 'hook.json');
    writeFileSync(bad, 'not json');
    expect((await run(bad, JSON.stringify(EVENT))).code).toBe(0);
    expect(seen.req).toBeUndefined();
  });
});
