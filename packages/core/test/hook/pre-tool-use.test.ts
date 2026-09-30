import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HOOK_SCRIPT } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const SECRET = 's3cret';
const INPUT = JSON.stringify({ tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: '/p/a.ts' }, cwd: '/p' });
const answer = (permissionDecision: string, permissionDecisionReason = 'IDE: test') => JSON.stringify({ permissionDecision, permissionDecisionReason });

function runHook(configPath: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(INPUT);
  });
}

async function core(reply: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => reply(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

function config(url: string, extra: object = {}): string {
  const path = join(tempDir('ide-hook-'), 'hook.json');
  writeFileSync(path, JSON.stringify({ url, secret: SECRET, ...extra }));
  return path;
}

describe('pre-tool-use hook script', () => {
  it("sends the hook input with the agent secret and prints the core's allow", async () => {
    const seen: { auth?: string; body?: string } = {};
    const url = await core((req, body, res) => {
      Object.assign(seen, { auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(answer('allow', 'IDE: allowed by plan p, step s.'));
    });
    const run = await runHook(config(url));
    expect([run.code, JSON.parse(run.stdout), seen]).toEqual([
      0,
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'IDE: allowed by plan p, step s.' } },
      { auth: `Bearer ${SECRET}`, body: INPUT },
    ]);
  });

  it("prints the core's deny and exits 0", async () => {
    const url = await core((_req, _body, res) => res.writeHead(200).end(answer('deny', 'IDE: no plan.')));
    const run = await runHook(config(url));
    expect([run.code, JSON.parse(run.stdout).hookSpecificOutput.permissionDecision]).toEqual([0, 'deny']);
  });

  it('blocks with exit 2 when the core is unreachable', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const run = await runHook(config(`http://127.0.0.1:${port}/hook`));
    expect([run.code, run.stdout, run.stderr]).toEqual([2, '', expect.stringContaining('IDE core unreachable')]);
    expect(run.stderr).not.toContain(SECRET);
  });

  it.each([
    ['an error status', (res: ServerResponse) => res.writeHead(500).end(answer('allow')), 'IDE: the IDE core answered 500'],
    ['a body that is not JSON', (res: ServerResponse) => res.writeHead(200).end('nope'), undefined],
    ['a decision other than allow or deny', (res: ServerResponse) => res.writeHead(200).end(answer('ask')), 'IDE: the IDE core sent an answer the hook cannot read'],
    ['a decision without a reason', (res: ServerResponse) => res.writeHead(200).end(JSON.stringify({ permissionDecision: 'allow' })), 'IDE: the IDE core sent an answer the hook cannot read'],
  ])('blocks with exit 2 on %s', async (_name, reply, exactStderr) => {
    const url = await core((_req, _body, res) => reply(res));
    const run = await runHook(config(url));
    expect([run.code, run.stdout]).toEqual([2, '']);
    expect(run.stderr).not.toContain(SECRET);
    if (exactStderr !== undefined) expect(run.stderr).toBe(exactStderr);
  });

  it('blocks with exit 2 when its config file is missing', async () => {
    const run = await runHook(join(tempDir('ide-hook-'), 'missing.json'));
    expect([run.code, run.stderr]).toEqual([2, expect.stringContaining('IDE:')]);
    expect(run.stderr).not.toContain(SECRET);
  });

  it('blocks with exit 2 at its own deadline when the core does not answer', async () => {
    const url = await core(() => undefined);
    const run = await runHook(config(url, { deadlineMs: 300 }));
    expect([run.code, run.stderr]).toEqual([2, expect.stringContaining('the user did not respond')]);
    expect(run.stderr).not.toContain(SECRET);
  });

  it('exits 2 within a second when its stderr pipe is already full and nobody reads it', async () => {
    const wrapper = join(tempDir('ide-hook-'), 'fill-stderr.mjs');
    writeFileSync(wrapper, `process.stderr.write('x'.repeat(4 * 1024 * 1024));\nawait import(${JSON.stringify(pathToFileURL(HOOK_SCRIPT).href)});\n`);
    const child = spawn(process.execPath, [wrapper, join(tempDir('ide-hook-'), 'missing.json')], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(INPUT);
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
    expect(code).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('exits 2, not 0, when a deny cannot be written to its stdout', async () => {
    const url = await core((_req, _body, res) => res.writeHead(200).end(answer('deny', 'IDE: no plan.')));
    const child = spawn(process.execPath, [HOOK_SCRIPT, config(url)], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.destroy();
    child.stdin.end(INPUT);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
    expect(code).toBe(2);
  });
});
