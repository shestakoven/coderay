import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { SESSION_START_SCRIPT } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

const START_INPUT = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'claude-1' });

function run(configPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SESSION_START_SCRIPT, configPath], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', (code) => resolve(code));
    child.stdin.end(START_INPUT);
  });
}

function config(url: string): string {
  const path = join(tempDir('ide-hook-'), 'hook.json');
  writeFileSync(path, JSON.stringify({ url, secret: 's3cret', sessionId: 's1' }));
  return path;
}

async function core(status: number, seen: { req?: IncomingMessage; body?: string } = {}): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      Object.assign(seen, { req, body });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

describe('session-start hook script', () => {
  it('posts the session id to /hook/alive with the agent secret and exits 0', async () => {
    const seen: { req?: IncomingMessage; body?: string } = {};
    const url = await core(204, seen);
    expect(await run(config(url))).toBe(0);
    expect([seen.req?.method, seen.req?.url, seen.req?.headers.authorization, JSON.parse(seen.body ?? 'null')])
      .toEqual(['POST', '/hook/alive', 'Bearer s3cret', { sessionId: 's1' }]);
  });

  it('exits 0 when the core answers with an error', async () => {
    expect(await run(config(await core(500)))).toBe(0);
  });

  it('exits 0 when the core is down', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await run(config(`http://127.0.0.1:${port}/hook`))).toBe(0);
  });

  it('exits 0 when its config cannot be read', async () => {
    expect(await run(join(tempDir('ide-hook-'), 'missing.json'))).toBe(0);
    const bad = join(tempDir('ide-hook-'), 'hook.json');
    writeFileSync(bad, 'not json');
    expect(await run(bad)).toBe(0);
  });
});
