import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HARDENING_ENV, shellWrapper, startServer, withServer } from '../../src/agent/opencode/server';
import { isAlive, signal } from '../../src/os-process';
import { FAKE_OPENCODE, fakeOpencode, opencodeRecords } from '../fake-opencode/fake';
import { tempDir, waitFor } from '../helpers';

const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
const EXITING_CORE = fileURLToPath(new URL('../fake-opencode/exiting-core.ts', import.meta.url));
// Literal, so a flag dropped from HARDENING_ENV cannot shrink both sides of an assertion.
const HARDENING = { OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1' };
const records: string[] = [];
// Runs before the temp directory goes: whatever fake or shell command a test started dies with it, even when the code under test failed to stop them.
afterEach(() => {
  for (const entry of records.splice(0).flatMap(opencodeRecords)) signal(entry.pid ?? entry.sleeperPid ?? -1, 'SIGKILL');
});

function scratch(): { dir: string; record: string } {
  const dir = tempDir('oc-server-');
  const record = join(dir, 'rec.jsonl');
  records.push(record);
  return { dir, record };
}

function sleeperScenario(dir: string): string {
  const scenario = join(dir, 's.jsonl');
  writeFileSync(scenario, '{"fake":"spawn-sleeper"}\n{"fake":"sleep","ms":60000}\n');
  return scenario;
}

describe('startServer', () => {
  it('spawns serve --port 0 with the hardening environment, a fresh password and the config content, knows its pid at once, waits for the listening line, health and the version, and writes an opencode pid file', async () => {
    const { dir, record } = scratch();
    const server = startServer(fakeOpencode(null, record, { OPENCODE_CONFIG_DIR: '/elsewhere', OPENCODE_AUTO_SHARE: '1', OPENCODE_SERVER_USERNAME: 'other' }), {
      cwd: dir, pidDir: dir, configContent: '{"mcp":{}}', env: { OPENCODE_PURE: '0', OPENCODE_PERMISSION: '{"edit":"allow"}' },
    });
    const early = server.pid;
    const { base, version } = await server.ready;
    const first = opencodeRecords(record)[0]!;
    const health = opencodeRecords(record).find((entry) => entry.req?.path === '/global/health');
    const pidFile = readdirSync(dir).find((name) => /^opencode-\d+\.pid\.json$/.test(name));
    const recorded = pidFile === undefined ? null : JSON.parse(readFileSync(join(dir, pidFile), 'utf8')).pid;
    await server.kill();
    expect([HARDENING_ENV, early !== undefined, first.argv, first.env, first.opencodeVars, first.configContent, health !== undefined, version, base, recorded === early]).toEqual([
      // The inherited OPENCODE_* are gone, and nothing passed in overrides the hardening; only CodeRay's own remain.
      HARDENING, true, ['serve', '--port', '0', '--hostname', '127.0.0.1'], Object.keys(HARDENING), ['OPENCODE_CONFIG_CONTENT', ...Object.keys(HARDENING), 'OPENCODE_SERVER_PASSWORD'].sort(), { mcp: {} }, true, '1.19.0', expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), true,
    ]);
  });

  it.each([
    ['never prints the listening line', { FAKE_OPENCODE_NO_LISTEN: '1' }, [], /^opencode did not say where it listens within 1 s$/],
    ['exits before it listens', {}, ['bogus'], /^opencode exited before it said where it listens \(code 2\): fake-opencode: unsupported arguments bogus serve/],
    ['answers health with 503', { FAKE_OPENCODE_HEALTH: 'down' }, [], /^opencode's health check failed \(503\)$/],
    ['is older than 1.19', { FAKE_OPENCODE_VERSION: '1.18.9' }, [], /^opencode 1\.18\.9 is older than 1\.19\.0, the version CodeRay was verified with: update opencode to run it in CodeRay\.$/],
    ['prints the listening line on stderr (and is then fine)', { FAKE_OPENCODE_LISTEN_STREAM: 'stderr' }, [], null],
  ])('settles ready with the reason and leaves no process when the server %s', async (_name, env, args, reason) => {
    const { dir, record } = scratch();
    const server = startServer({ ...fakeOpencode(null, record, env), args: [FAKE_OPENCODE, ...args] }, { cwd: dir, listenTimeoutMs: 1_000 });
    let gone = false;
    void server.exited.then(() => {
      gone = true;
    });
    const outcome = await server.ready.then(() => null, (error: Error) => error.message);
    // A start that failed has stopped its server by itself.
    await (reason === null ? server.kill() : waitFor(() => gone, 'the server stopped by itself', 3_000));
    expect([reason === null ? outcome : reason.test(outcome ?? '') || outcome, gone]).toEqual([reason === null ? null : true, true]);
  });

  it.each([
    ['dispose answers', {}],
    ['dispose hangs', { FAKE_OPENCODE_DISPOSE: 'hang' }],
  ])('stops the server without orphaning a running shell command when %s: dispose, then SIGTERM, then SIGKILL, then the descendants', async (_name, env) => {
    const { dir, record } = scratch();
    const server = startServer(fakeOpencode(sleeperScenario(dir), record, env), { cwd: dir, killGraceMs: 500 });
    const { client } = await server.ready;
    const session = await client.post<{ id: string }>('/session', {});
    await client.post(`/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'go' }] });
    const sleeper = await waitFor(() => opencodeRecords(record).find((entry) => entry.sleeperPid !== undefined)?.sleeperPid, 'the sleeper started');
    await server.kill();
    const disposed = opencodeRecords(record).some((entry) => entry.req?.path === '/global/dispose');
    expect([disposed, isAlive(sleeper), server.pid !== undefined && isAlive(server.pid)]).toEqual([true, false, false]);
  });

  it('kills the server and its running shell command at once when the core exits without stopping it', async () => {
    const { dir, record } = scratch();
    const core = spawn(TSX, [EXITING_CORE, sleeperScenario(dir), record, dir], { stdio: 'ignore' });
    await new Promise((resolve) => core.once('exit', resolve));
    const server = opencodeRecords(record).find((entry) => entry.pid !== undefined)?.pid ?? -1;
    const sleeper = opencodeRecords(record).find((entry) => entry.sleeperPid !== undefined)?.sleeperPid ?? -1;
    expect([server > 1, sleeper > 1]).toEqual([true, true]);
    await waitFor(() => !isAlive(server) && !isAlive(sleeper), 'the server and its shell command stopped', 2_000);
  });
});

describe('withServer', () => {
  it('answers one question on a short-lived server with its own password, and stops it whatever happens, a question that never ends included', async () => {
    const { dir, record } = scratch();
    const answer = await withServer(fakeOpencode(null, record), dir, async (client, version) => `${(await client.get<unknown[]>('/agent')).length} agents on ${version}`);
    const hung = await withServer(fakeOpencode(null, record), dir, () => new Promise<never>(() => {}), {}, 1_000).catch((error: Error) => error.message);
    const starts = opencodeRecords(record).filter((entry) => entry.pid !== undefined);
    expect([answer, hung, starts.length, starts.filter((entry) => isAlive(entry.pid ?? -1)), new Set(starts.map((entry) => entry.passwordHash)).size]).toEqual([
      '7 agents on 1.19.0', 'opencode did not answer in 1 s.', 2, [], 2,
    ]);
  });
});

describe('shellWrapper', () => {
  it("writes an executable named after the user's shell that drops the server's secrets and execs the real shell", () => {
    const { dir } = scratch();
    const path = shellWrapper(dir, '/bin/zsh');
    const sh = shellWrapper(dir, '/bin/sh');
    const secrets = { OPENCODE_SERVER_PASSWORD: 'pw', OPENCODE_SERVER_USERNAME: 'u', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_PID: '1', KEEP: 'kept' };
    const seen = execFileSync(sh, ['-c', 'printenv'], { env: { PATH: process.env.PATH, ...secrets }, encoding: 'utf8' }).split('\n').map((line) => line.split('=')[0]);
    expect([path.endsWith('/opencode-shell/zsh'), statSync(path).mode & 0o777, statSync(join(dir, 'opencode-shell')).mode & 0o777, readFileSync(path, 'utf8'), Object.keys(secrets).filter((name) => seen.includes(name))]).toEqual([
      true, 0o755, 0o700, '#!/bin/sh\nexec env -u OPENCODE_SERVER_PASSWORD -u OPENCODE_SERVER_USERNAME -u OPENCODE_CONFIG_CONTENT -u OPENCODE_PID /bin/zsh "$@"\n', ['KEEP'],
    ]);
  });
});
