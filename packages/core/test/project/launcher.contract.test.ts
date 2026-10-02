import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@ide/protocol';
import { projectDir } from '../../src/home';
import { acquireCoreLock } from '../../src/lock';
import { CLONE_CANCELLED } from '../../src/project/clone';
import { GIT_NOT_FOUND } from '../../src/project/git';
import { startLauncher } from '../../src/project/launcher';
import { tempDir, waitFor } from '../helpers';
import { fakeGit } from './fake-git';

const TOKEN = 'launcher-contract-token';

type Launcher = Awaited<ReturnType<typeof startLauncher>>;
type Handover = { root: string; port: number };

const launchers: Launcher[] = [];
const sockets: WebSocket[] = [];
const spawned: number[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const launcher of launchers.splice(0)) await launcher.close().catch(() => undefined);
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

async function launch(opts: { home?: string; git?: string; allowedOrigins?: string[]; handover?: (root: string, port: number) => Promise<void> } = {}) {
  const home = opts.home ?? tempDir('ide-launcher-home-');
  const handovers: Handover[] = [];
  const launcher = await startLauncher({
    port: 0,
    token: TOKEN,
    allowedOrigins: opts.allowedOrigins ?? [],
    home,
    ...(opts.git ? { git: opts.git } : {}),
    handover: opts.handover ?? (async (root, port) => {
      handovers.push({ root, port });
    }),
  });
  launchers.push(launcher);
  launcher.finished.catch(() => undefined);
  return { launcher, handovers, home };
}

function connect(port: number, token: string | null = TOKEN, headers: Record<string, string> = {}): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
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

const send = (socket: WebSocket, message: unknown): void => socket.send(typeof message === 'string' ? message : JSON.stringify(message));

const reply = (messages: ServerMessage[], type: string, requestId: string) =>
  waitFor(() => messages.find((m) => m.type === type && 'requestId' in m && m.requestId === requestId), `${type} ${requestId}`);

const resultError = (message: ServerMessage): string | null => (message as { error: string | null }).error;

function folders(): { base: string; parent: string; bin: string } {
  const base = tempDir('ide-launcher-contract-');
  const parent = join(base, 'parent');
  const bin = join(base, 'bin');
  mkdirSync(parent);
  mkdirSync(bin);
  return { base, parent, bin };
}

// A git whose init succeeds at once and whose clone waits on a helper in its process group.
function slowCloneGit(bin: string): string {
  return fakeGit(bin, [
    'case " $* " in *" init "*) exit 0;; esac',
    'for a in "$@"; do last="$a"; done',
    'mkdir -p "$last"',
    'echo partial > "$last/partial"',
    `echo $$ > "${bin}/git.pid"`,
    'sleep 30 &',
    `echo $! > "${bin}/sleep.pid"`,
    'wait',
  ].join('\n'));
}

// A git whose init blocks until the test creates the release file.
function gatedInitGit(bin: string): string {
  return fakeGit(bin, [
    `echo started > "${bin}/started"`,
    `i=0; while [ ! -f "${bin}/release" ]; do i=$((i+1)); [ $i -gt 200 ] && exit 1; sleep 0.05; done`,
    'exit 0',
  ].join('\n'));
}

async function pidFrom(file: string): Promise<number> {
  const pid = await waitFor(() => existsSync(file) && Number(readFileSync(file, 'utf8').trim()), `pid in ${file}`);
  spawned.push(pid);
  return pid;
}

describe('launcher connection', () => {
  it('greets a client with project.info that has no root, no name and an empty recent list', async () => {
    const { launcher } = await launch();
    const { messages } = await connect(launcher.port);
    const first = await waitFor(() => messages[0], 'project.info');
    expect(first).toMatchObject({ type: 'project.info', info: { root: null, name: '', recent: [] } });
  });

  it('greets every client that connects, not only the first', async () => {
    const { launcher } = await launch();
    await connect(launcher.port);
    const second = await connect(launcher.port);
    expect(await waitFor(() => second.messages[0], 'project.info')).toMatchObject({ type: 'project.info', info: { root: null } });
  });

  it('starts folder browsing at the user home folder (assumption: info.home is os.homedir())', async () => {
    const { launcher } = await launch();
    const { socket, messages } = await connect(launcher.port);
    const info = await waitFor(() => messages.find((m) => m.type === 'project.info'), 'project.info');
    expect(info).toMatchObject({ info: { home: homedir() } });
    send(socket, { type: 'fs.list', requestId: 'f1', path: null });
    expect(await reply(messages, 'fs.list.result', 'f1')).toMatchObject({ path: homedir(), error: null });
  });

  it('refuses a client with a wrong token', async () => {
    const { launcher } = await launch();
    await expect(connect(launcher.port, 'wrong')).rejects.toThrow();
  });

  it('refuses a client without a token', async () => {
    const { launcher } = await launch();
    await expect(connect(launcher.port, null)).rejects.toThrow();
  });

  it('refuses a client from a foreign origin', async () => {
    const { launcher } = await launch({ allowedOrigins: ['http://localhost:5173'] });
    await expect(connect(launcher.port, TOKEN, { origin: 'http://evil.example' })).rejects.toThrow();
  });

  it('accepts a client from an allowed origin', async () => {
    const { launcher } = await launch({ allowedOrigins: ['http://localhost:5173'] });
    const { messages } = await connect(launcher.port, TOKEN, { origin: 'http://localhost:5173' });
    expect(await waitFor(() => messages[0], 'project.info')).toMatchObject({ type: 'project.info' });
  });

  it('creates no project lock or store in the IDE home while serving', async () => {
    const { launcher, home } = await launch();
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'fs.list', requestId: 'f1', path: home });
    await reply(messages, 'fs.list.result', 'f1');
    expect(readdirSync(home)).not.toContain('projects');
  });
});

describe('launcher routing', () => {
  it('lists a folder for fs.list with the request id', async () => {
    const { launcher } = await launch();
    const { parent } = folders();
    mkdirSync(join(parent, 'one'));
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'fs.list', requestId: 'f7', path: parent });
    expect(await reply(messages, 'fs.list.result', 'f7')).toMatchObject({ path: parent, entries: [{ name: 'one', isGit: false }], error: null });
  });

  it.each([
    ['a valid project-mode message', { type: 'project.close', requestId: 'x1' }],
    ['an unknown type', { type: 'no.such.message', requestId: 'x2' }],
    ['text that is not JSON', 'definitely not json'],
  ])('answers %s with an error and keeps serving', async (_label, message) => {
    const { launcher, handovers } = await launch();
    const { socket, messages } = await connect(launcher.port);
    await waitFor(() => messages[0], 'project.info');
    send(socket, message);
    const error = await waitFor(() => messages.find((m) => m.type === 'error'), 'error reply');
    expect(error).toEqual({ type: 'error', message: expect.any(String) });
    send(socket, { type: 'fs.list', requestId: 'after', path: null });
    await reply(messages, 'fs.list.result', 'after');
    expect(handovers).toEqual([]);
  });

  it('a cancel with no clone running does not break the launcher', async () => {
    const { launcher, handovers } = await launch();
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.clone.cancel', requestId: 'nothing' });
    send(socket, { type: 'fs.list', requestId: 'after', path: null });
    await reply(messages, 'fs.list.result', 'after');
    expect(handovers).toEqual([]);
  });
});

describe('launcher create', () => {
  it('replies, frees the port, then hands over the new project once', async () => {
    const { parent } = folders();
    const portFree: boolean[] = [];
    const handovers: Handover[] = [];
    const { launcher } = await launch({
      handover: async (root, port) => {
        handovers.push({ root, port });
        await new Promise<void>((resolve, reject) => {
          const probe = createServer();
          probe.once('error', reject);
          probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
        });
        portFree.push(true);
      },
    });
    const port = launcher.port;
    const { socket, messages } = await connect(port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'app' });
    await launcher.finished;
    expect(await reply(messages, 'project.create.result', 'c1')).toEqual({ type: 'project.create.result', requestId: 'c1', error: null });
    expect(handovers).toEqual([{ root: join(parent, 'app'), port }]);
    expect(portFree).toEqual([true]);
    expect(existsSync(join(parent, 'app', '.git'))).toBe(true);
  });

  it('records the created project in the recent list', async () => {
    const { parent } = folders();
    const { launcher, home } = await launch();
    const { socket } = await connect(launcher.port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'remember-me' });
    await launcher.finished;
    const next = await launch({ home });
    const { messages } = await connect(next.launcher.port);
    const info = await waitFor(() => messages.find((m) => m.type === 'project.info'), 'project.info');
    expect(info).toMatchObject({ info: { recent: [{ path: join(parent, 'remember-me'), name: 'remember-me' }] } });
  });

  it('reports an invalid name, hands over nothing and keeps serving', async () => {
    const { parent } = folders();
    const { launcher, handovers } = await launch();
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: '..' });
    expect(resultError(await reply(messages, 'project.create.result', 'c1'))).toEqual(expect.any(String));
    send(socket, { type: 'fs.list', requestId: 'f1', path: null });
    await reply(messages, 'fs.list.result', 'f1');
    expect(handovers).toEqual([]);
  });

  it('reports git not found', async () => {
    const { base, parent } = folders();
    const { launcher, handovers } = await launch({ git: join(base, 'no-such-git') });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'app' });
    expect(resultError(await reply(messages, 'project.create.result', 'c1'))).toBe(GIT_NOT_FOUND);
    expect(handovers).toEqual([]);
  });

  it('accepts a new request after a failed one', async () => {
    const { parent, bin } = folders();
    const git = fakeGit(bin, 'case "$* $PWD" in *fails-on-init*) echo "fatal: no" >&2; exit 1;; esac\nexit 0');
    const { launcher, handovers } = await launch({ git });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'fails-on-init' });
    expect(resultError(await reply(messages, 'project.create.result', 'c1'))).toEqual(expect.any(String));
    send(socket, { type: 'project.create', requestId: 'c2', parent, name: 'good' });
    await launcher.finished;
    expect(resultError(await reply(messages, 'project.create.result', 'c2'))).toBeNull();
    expect(handovers).toEqual([{ root: join(parent, 'good'), port: launcher.port }]);
  });

  it('refuses create, clone and open while a create runs, then hands over only the first', async () => {
    const { parent, bin } = folders();
    const other = join(parent, 'existing');
    mkdirSync(other);
    const { launcher, handovers } = await launch({ git: gatedInitGit(bin) });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'first' });
    await waitFor(() => existsSync(join(bin, 'started')), 'git init started');
    send(socket, { type: 'project.create', requestId: 'c2', parent, name: 'second' });
    send(socket, { type: 'project.clone', requestId: 'k1', url: 'file:///srv/r.git', parent, name: 'third' });
    send(socket, { type: 'project.open', requestId: 'o1', path: other });
    expect(resultError(await reply(messages, 'project.create.result', 'c2'))).toEqual(expect.any(String));
    expect(resultError(await reply(messages, 'project.clone.result', 'k1'))).toEqual(expect.any(String));
    expect(resultError(await reply(messages, 'project.open.result', 'o1'))).toEqual(expect.any(String));
    writeFileSync(join(bin, 'release'), '');
    await launcher.finished;
    expect(resultError(await reply(messages, 'project.create.result', 'c1'))).toBeNull();
    expect(handovers).toEqual([{ root: join(parent, 'first'), port: launcher.port }]);
    expect(existsSync(join(parent, 'second'))).toBe(false);
    expect(existsSync(join(parent, 'third'))).toBe(false);
  });
});

describe('launcher open', () => {
  it('replies and hands over an existing folder, recording it in recent', async () => {
    const { parent } = folders();
    const project = join(parent, 'proj');
    mkdirSync(project);
    const { launcher, handovers, home } = await launch();
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.open', requestId: 'o1', path: project });
    await launcher.finished;
    expect(await reply(messages, 'project.open.result', 'o1')).toEqual({ type: 'project.open.result', requestId: 'o1', error: null });
    expect(handovers).toEqual([{ root: project, port: launcher.port }]);
    const next = await launch({ home });
    const greeting = await connect(next.launcher.port);
    expect(await waitFor(() => greeting.messages[0], 'project.info')).toMatchObject({ info: { recent: [{ path: project }] } });
  });

  it.each([
    ['a missing folder', (parent: string) => join(parent, 'missing')],
    ['a file', (parent: string) => {
      writeFileSync(join(parent, 'file'), 'x');
      return join(parent, 'file');
    }],
  ])('reports an error for %s and hands over nothing', async (_label, target) => {
    const { parent } = folders();
    const { launcher, handovers } = await launch();
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.open', requestId: 'o1', path: target(parent) });
    expect(resultError(await reply(messages, 'project.open.result', 'o1'))).toEqual(expect.any(String));
    send(socket, { type: 'fs.list', requestId: 'f1', path: null });
    await reply(messages, 'fs.list.result', 'f1');
    expect(handovers).toEqual([]);
  });

  it('refuses a project another live core holds', async () => {
    const { parent } = folders();
    const project = join(parent, 'held');
    mkdirSync(project);
    const { launcher, handovers, home } = await launch();
    const lock = acquireCoreLock(projectDir(home, project));
    try {
      const { socket, messages } = await connect(launcher.port);
      send(socket, { type: 'project.open', requestId: 'o1', path: project });
      expect(resultError(await reply(messages, 'project.open.result', 'o1'))).toEqual(expect.any(String));
      expect(handovers).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it('two opens sent back to back hand over exactly once, to the first', async () => {
    const { parent } = folders();
    mkdirSync(join(parent, 'a'));
    mkdirSync(join(parent, 'b'));
    const { launcher, handovers } = await launch();
    const { socket } = await connect(launcher.port);
    send(socket, { type: 'project.open', requestId: 'o1', path: join(parent, 'a') });
    send(socket, { type: 'project.open', requestId: 'o2', path: join(parent, 'b') });
    await launcher.finished;
    // A second handover would follow within this time.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handovers).toEqual([{ root: join(parent, 'a'), port: launcher.port }]);
  });
});

describe('launcher clone', () => {
  it('forwards progress with the request id, replies, then hands over', async () => {
    const { parent, bin } = folders();
    const git = fakeGit(bin, [
      'for a in "$@"; do last="$a"; done',
      'printf "Receiving objects:  50%% (1/2)\\rReceiving objects: 100%% (2/2), done.\\nResolving deltas: 100%% (1/1), done.\\n" >&2',
      'mkdir -p "$last"',
      'exit 0',
    ].join('\n'));
    const { launcher, handovers } = await launch({ git });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.clone', requestId: 'k1', url: 'https://host/org/repo.git', parent, name: null });
    await launcher.finished;
    const result = await reply(messages, 'project.clone.result', 'k1');
    expect(result).toEqual({ type: 'project.clone.result', requestId: 'k1', error: null });
    const progress = messages.filter((m) => m.type === 'project.clone.progress');
    expect(progress).toEqual([
      { type: 'project.clone.progress', requestId: 'k1', phase: 'receiving', percent: 50 },
      { type: 'project.clone.progress', requestId: 'k1', phase: 'receiving', percent: 100 },
      { type: 'project.clone.progress', requestId: 'k1', phase: 'resolving', percent: 100 },
    ]);
    expect(messages.indexOf(result)).toBeGreaterThan(messages.indexOf(progress.at(-1)!));
    expect(handovers).toEqual([{ root: join(parent, 'repo'), port: launcher.port }]);
  });

  it('reports git\'s last line on failure and hands over nothing', async () => {
    const { parent, bin } = folders();
    const git = fakeGit(bin, 'printf "Cloning into repo...\\nfatal: repository not found\\n" >&2\nexit 128');
    const { launcher, handovers } = await launch({ git });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.clone', requestId: 'k1', url: 'https://host/org/repo.git', parent, name: 'repo' });
    expect(resultError(await reply(messages, 'project.clone.result', 'k1'))).toContain('repository not found');
    expect(handovers).toEqual([]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('rejects a clone URL that starts with a dash without running git', async () => {
    const { parent, bin } = folders();
    const git = fakeGit(bin, `echo ran > "${bin}/ran"\nexit 0`);
    const { launcher, handovers } = await launch({ git });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.clone', requestId: 'k1', url: '--upload-pack=touch /tmp/never', parent, name: 'x' });
    expect(resultError(await reply(messages, 'project.clone.result', 'k1'))).toEqual(expect.any(String));
    expect(existsSync(join(bin, 'ran'))).toBe(false);
    expect(handovers).toEqual([]);
  });

  it('refuses a second clone and a create while one runs; cancel stops it and frees the launcher', async () => {
    const { parent, bin } = folders();
    const { launcher, handovers } = await launch({ git: slowCloneGit(bin) });
    const { socket, messages } = await connect(launcher.port);
    send(socket, { type: 'project.clone', requestId: 'k1', url: 'https://host/org/repo.git', parent, name: 'one' });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    const sleepPid = await pidFrom(join(bin, 'sleep.pid'));
    send(socket, { type: 'project.clone', requestId: 'k2', url: 'https://host/org/repo.git', parent, name: 'two' });
    send(socket, { type: 'project.create', requestId: 'c1', parent, name: 'three' });
    expect(resultError(await reply(messages, 'project.clone.result', 'k2'))).toEqual(expect.any(String));
    expect(resultError(await reply(messages, 'project.create.result', 'c1'))).toEqual(expect.any(String));
    expect(existsSync(join(parent, 'two'))).toBe(false);
    expect(existsSync(join(parent, 'three'))).toBe(false);

    send(socket, { type: 'project.clone.cancel', requestId: 'k1' });
    expect(resultError(await reply(messages, 'project.clone.result', 'k1'))).toBe(CLONE_CANCELLED);
    expect(readdirSync(parent)).toEqual([]);
    await waitFor(() => !alive(gitPid) && !alive(sleepPid), 'clone processes gone', 3000);
    expect(handovers).toEqual([]);

    send(socket, { type: 'project.create', requestId: 'c2', parent, name: 'after' });
    await launcher.finished;
    expect(resultError(await reply(messages, 'project.create.result', 'c2'))).toBeNull();
    expect(handovers).toEqual([{ root: join(parent, 'after'), port: launcher.port }]);
  });
});

describe('launcher shutdown', () => {
  it('close() resolves finished and stops accepting clients', async () => {
    const { launcher, handovers } = await launch();
    const port = launcher.port;
    await launcher.close();
    await launcher.finished;
    await expect(connect(port)).rejects.toThrow();
    expect(handovers).toEqual([]);
  });

  it('close() during a clone kills git and its helpers and removes the partial folder', async () => {
    const { parent, bin } = folders();
    const { launcher, handovers } = await launch({ git: slowCloneGit(bin) });
    const { socket } = await connect(launcher.port);
    send(socket, { type: 'project.clone', requestId: 'k1', url: 'https://host/org/repo.git', parent, name: 'one' });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    const sleepPid = await pidFrom(join(bin, 'sleep.pid'));
    await launcher.close();
    await launcher.finished;
    await waitFor(() => !alive(gitPid) && !alive(sleepPid), 'clone processes gone', 3000);
    await waitFor(() => readdirSync(parent).length === 0, 'partial folder removed', 3000);
    expect(handovers).toEqual([]);
  });

  it('drops connected clients after a successful open so the UI reloads', async () => {
    const { parent } = folders();
    mkdirSync(join(parent, 'p'));
    const { launcher } = await launch();
    const { socket } = await connect(launcher.port);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    send(socket, { type: 'project.open', requestId: 'o1', path: join(parent, 'p') });
    await launcher.finished;
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('close() is harmless when called twice or after a handover', async () => {
    const { parent } = folders();
    mkdirSync(join(parent, 'p'));
    const { launcher, handovers } = await launch();
    const { socket } = await connect(launcher.port);
    send(socket, { type: 'project.open', requestId: 'o1', path: join(parent, 'p') });
    await launcher.finished;
    await expect(launcher.close()).resolves.toBeUndefined();
    await expect(launcher.close()).resolves.toBeUndefined();
    expect(handovers).toHaveLength(1);
  });

  it('finished rejects when the handover fails', async () => {
    const { parent } = folders();
    mkdirSync(join(parent, 'p'));
    const { launcher } = await launch({ handover: async () => Promise.reject(new Error('spawn failed')) });
    const { socket } = await connect(launcher.port);
    send(socket, { type: 'project.open', requestId: 'o1', path: join(parent, 'p') });
    await expect(launcher.finished).rejects.toThrow('spawn failed');
  });
});
