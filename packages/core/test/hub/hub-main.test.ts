import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import type { HubProject, HubServerMessage, HubSnapshot, ServerMessage } from '@ide/protocol';
import { projectId } from '../../src/hub/supervisor';
import { openProjectsFile, readOpenProjects, serializeOpenProjects, writeOpenProjects } from '../../src/hub/open-projects';
import { FAKE_CLAUDE } from '../fake-claude/fake';
import { fixture, tempDir, waitFor } from '../helpers';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const MODELS_CACHE = join(REPO, 'node_modules/.cache/ide-e2e/models');
const ORIGIN = 'http://localhost:4400';
const TOKEN = 'hub-test-token-0123456789';

type Message = HubServerMessage | ServerMessage;

function scratchProject(base: string, name: string): string {
  const root = join(base, name);
  cpSync(join(REPO, 'e2e/fixtures/tiny'), root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

function prepare() {
  const base = tempDir('hub-main-');
  const home = join(base, 'home');
  mkdirSync(MODELS_CACHE, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(MODELS_CACHE, join(home, 'models'));
  // A claude that always fails, first in PATH, so no core can ever reach the real model.
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { base, home, bin };
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});

// Every process whose command line mentions the scratch dir: the hub, its project cores and anything they started.
const processesUnder = (base: string, except: (number | undefined)[] = []): number[] => {
  try {
    return execFileSync('pgrep', ['-f', base], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((pid) => pid !== process.pid && !except.includes(pid));
  } catch {
    return [];
  }
};

function killAllUnder(base: string): void {
  for (const pid of processesUnder(base)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function startHubProcess(env: { base: string; home: string; bin: string }, port: number, projects: string[], opencode?: string) {
  const args = ['--import', 'tsx', MAIN, '--hub', ...projects.flatMap((root) => ['--project', root]),
    '--ide-home', env.home, '--port', String(port), '--allow-origin', ORIGIN, '--claude', FAKE_CLAUDE, '--no-codex', ...(opencode ? ['--opencode', opencode] : ['--no-opencode'])];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: join(env.base, 'user-home'),
      PATH: `${env.bin}:${process.env.PATH ?? ''}`,
      IDE_CORE_TOKEN: TOKEN,
      FAKE_CLAUDE_SCENARIO: fixture('stream/exec-write-then-done.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout?.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const stop = async () => {
    child.kill('SIGTERM');
    return exited;
  };
  return { child, output, exited, stop };
}

async function connect(url: string) {
  const socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
  onTestFinished(() => socket.terminate());
  const messages: Message[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Message));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const send = (message: object) => socket.send(JSON.stringify(message));
  const snapshots = () => messages.flatMap((message) => (message.type === 'hub.snapshot' ? [message.hub] : []));
  const latest = (): HubSnapshot | undefined => snapshots().at(-1);
  return { socket, messages, send, latest };
}

const connectHub = (port: number, output: { text: string }) =>
  waitFor(() => connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`).catch(() => null), `a socket to the hub; output:\n${output.text}`, 60_000);

const runningIn = (snapshot: HubSnapshot | undefined, roots: string[]): HubProject[] | false => {
  const projects = roots.map((root) => snapshot?.projects.find((project) => project.root === root));
  return projects.every((project) => project?.state === 'running') && (projects as HubProject[]);
};

describe('main.ts --hub', { timeout: 180_000 }, () => {
  it('runs a core per project, closes and opens projects through the hub and leaves no core behind', async () => {
    const env = prepare();
    onTestFinished(() => killAllUnder(env.base));
    const [a, b, c] = ['alpha', 'beta', 'gamma'].map((name) => scratchProject(env.base, name)) as [string, string, string];
    const port = await freePort();
    const hubProcess = startHubProcess(env, port, [a, b]);
    onTestFinished(async () => { await hubProcess.stop(); });

    const hub = await connectHub(port, hubProcess.output);
    expect((await waitFor(() => hub.messages[0], 'the first hub message')).type).toBe('hub.snapshot');

    const [runningA, runningB] = await waitFor(() => runningIn(hub.latest(), [a, b]), `both projects running; output:\n${hubProcess.output.text}`, 120_000) as [HubProject, HubProject];
    expect(hub.latest()?.projects.map((project) => project.root)).toEqual([a, b]);
    expect([runningA.id, runningB.id]).toEqual([projectId(a), projectId(b)]);
    expect(runningA.port).not.toBe(runningB.port);
    expect(runningA.token).not.toBe(runningB.token);
    expect([runningA.name, runningB.name]).toEqual(['alpha', 'beta']);

    const project = await connect(`ws://127.0.0.1:${runningA.port}/ws?token=${runningA.token}`);
    expect(await waitFor(() => project.messages.find((m) => m.type === 'project.info'), 'project.info from the project core')).toMatchObject({ info: { root: a } });
    await waitFor(() => project.messages.find((m) => m.type === 'map.snapshot'), 'map.snapshot from the project core', 60_000);

    const coresOf = (root: string) => processesUnder(root, [hubProcess.child.pid]);
    expect(coresOf(b).length).toBeGreaterThan(0);
    const argsOf = (pid: number) => execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    expect(coresOf(a).map(argsOf).filter((args) => args.includes('--exit-with-parent')).map((args) => args.includes(' --no-opencode '))).toEqual([true]);
    hub.send({ type: 'hub.close', requestId: 'close-b', id: runningB.id });
    expect(await waitFor(() => hub.messages.find((m) => m.type === 'hub.close.result'), 'the close result', 30_000)).toEqual({ type: 'hub.close.result', requestId: 'close-b', error: null });
    expect(hub.latest()?.projects.map((p) => p.root)).toEqual([a]);
    expect(await waitFor(() => coresOf(b).length === 0 || undefined, `the core of ${b} to end`, 15_000)).toBe(true);

    hub.send({ type: 'project.open', requestId: 'open-c', path: c });
    expect(await waitFor(() => hub.messages.find((m) => m.type === 'project.open.result'), 'the open result', 120_000)).toMatchObject({ requestId: 'open-c', error: null });
    await waitFor(() => runningIn(hub.latest(), [c]), 'the third project running', 30_000);
    expect(hub.latest()?.projects.map((p) => p.root)).toEqual([a, c]);
    expect(hub.latest()?.activeId).toBe(projectId(c));
    expect(await waitFor(() => readOpenProjects(env.home).roots.length === 2 && readOpenProjects(env.home), 'the open projects file')).toEqual({ roots: [a, c], activeRoot: c });

    expect(await hubProcess.stop()).toBe(0);
    expect(await waitFor(() => processesUnder(env.base).length === 0 || undefined, `no process left under ${env.base}: ${processesUnder(env.base).join(', ')}`, 15_000)).toBe(true);
    expect(readOpenProjects(env.home)).toEqual({ roots: [a, c], activeRoot: c });
  });

  it('reopens the projects of the last session when started without --project, each core given the hub\'s opencode', async () => {
    const env = prepare();
    onTestFinished(() => killAllUnder(env.base));
    const [a, b] = ['alpha', 'beta'].map((name) => scratchProject(env.base, name)) as [string, string];
    writeOpenProjects(env.home, serializeOpenProjects({ roots: [b, a], activeRoot: a }));
    expect(existsSync(openProjectsFile(env.home))).toBe(true);
    // An opencode that always fails, under the scratch dir, so no core can reach the real one and nothing it starts outlives the test unseen.
    const opencode = join(env.bin, 'opencode');
    writeFileSync(opencode, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const port = await freePort();
    const hubProcess = startHubProcess(env, port, [], opencode);
    onTestFinished(async () => { await hubProcess.stop(); });

    const hub = await connectHub(port, hubProcess.output);
    await waitFor(() => runningIn(hub.latest(), [a, b]), `both restored projects running; output:\n${hubProcess.output.text}`, 120_000);
    expect(hub.latest()?.projects.map((project) => project.root)).toEqual([b, a]);
    expect(hub.latest()?.activeId).toBe(projectId(a));
    const argsOf = (pid: number) => execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    const cores = [a, b].flatMap((root) => processesUnder(root, [hubProcess.child.pid]).map(argsOf).filter((args) => args.includes('--exit-with-parent')));
    expect(cores.map((args) => args.includes(` --opencode ${opencode} `))).toEqual([true, true]);

    expect(await hubProcess.stop()).toBe(0);
    expect(await waitFor(() => processesUnder(env.base).length === 0 || undefined, `no process left under ${env.base}`, 15_000)).toBe(true);
  });
});
