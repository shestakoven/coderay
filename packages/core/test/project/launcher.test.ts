import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@ide/protocol';
import { projectDir } from '../../src/home';
import { acquireCoreLock } from '../../src/lock';
import { startLauncher } from '../../src/project/launcher';
import { RecentProjects } from '../../src/project/recent';
import { tempDir, waitFor } from '../helpers';
import { fakeGit } from './fake-git';

const TOKEN = 'launcher-test-token';

async function launch(options: { before?: (home: string) => void; git?: string; handover?: (root: string, port: number) => Promise<void> } = {}) {
  const home = tempDir('ide-launcher-home-');
  options.before?.(home);
  const handover = vi.fn(options.handover ?? (async (_root: string, _port: number) => {}));
  const launcher = await startLauncher({ port: 0, token: TOKEN, allowedOrigins: [], home, handover, git: options.git });
  onTestFinished(() => launcher.close());
  const socket = new WebSocket(`ws://127.0.0.1:${launcher.port}/ws?token=${TOKEN}`);
  onTestFinished(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const send = (message: ClientMessage): void => socket.send(JSON.stringify(message));
  const next = <T extends ServerMessage['type']>(type: T, requestId?: string) =>
    waitFor(
      () => messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type && (requestId === undefined || ('requestId' in m && m.requestId === requestId))),
      `a ${type} message`,
    );
  return { home, handover, launcher, messages, send, next };
}

const sourceRepo = (): string => {
  const path = join(tempDir('ide-launcher-src-'), 'source');
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(path, 'hello.txt'), 'hi');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return path;
};

describe('launcher greeting and routing', () => {
  it('greets with a project-less project.info that lists the recent projects, and nothing else', async () => {
    const recentDir = tempDir('ide-launcher-recent-');
    const { send, next, messages } = await launch({ before: (home) => new RecentProjects(home).add(recentDir) });
    const { info } = await next('project.info');
    expect(info).toMatchObject({ root: null, name: '', recent: [{ path: recentDir }] });
    send({ type: 'fs.list', requestId: 'l1', path: recentDir });
    expect(await next('fs.list.result', 'l1')).toMatchObject({ path: recentDir, error: null });
    expect(messages.map((m) => m.type)).toEqual(['project.info', 'fs.list.result']);
  });

  it('answers messages that need a project with an error and keeps serving', async () => {
    const { send, next, messages } = await launch();
    send({ type: 'chat.send', text: 'hi' });
    send({ type: 'session.new' });
    send({ type: 'project.close', requestId: 'c1' });
    await waitFor(() => messages.filter((m) => m.type === 'error').length === 3 || undefined, 'three error replies');
    send({ type: 'fs.list', requestId: 'l1', path: null });
    expect(await next('fs.list.result', 'l1')).toMatchObject({ error: null });
  });
});

describe('launcher project.open', () => {
  it('hands over to a valid folder and records it as recent', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const { send, next, handover, launcher, home } = await launch();
    send({ type: 'project.open', requestId: 'o1', path: dir });
    expect(await next('project.open.result', 'o1')).toMatchObject({ error: null });
    await launcher.finished;
    expect(handover).toHaveBeenCalledExactlyOnceWith(dir, launcher.port);
    expect(new RecentProjects(home).list().map((p) => p.path)).toEqual([dir]);
  });

  it('rejects finished with the handover error and reports it', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const failure = new Error('spawn failed');
    const { send, next, handover, launcher } = await launch({ handover: async () => { throw failure; } });
    send({ type: 'project.open', requestId: 'o1', path: dir });
    expect(await next('project.open.result', 'o1')).toMatchObject({ error: null });
    await expect(launcher.finished).rejects.toBe(failure);
    expect(handover).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('handover'), failure);
  });

  it('still hands over when the recent list cannot be written', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const { send, next, handover, launcher } = await launch({ before: (home) => mkdirSync(join(home, 'recent-projects.json')) });
    send({ type: 'project.open', requestId: 'o1', path: dir });
    expect(await next('project.open.result', 'o1')).toMatchObject({ error: null });
    await launcher.finished;
    expect(handover).toHaveBeenCalledExactlyOnceWith(dir, launcher.port);
  });

  it('refuses a missing folder and does not hand over', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const { send, next, handover } = await launch();
    send({ type: 'project.open', requestId: 'o1', path: join(dir, 'missing') });
    expect((await next('project.open.result', 'o1')).error).toEqual(expect.any(String));
    expect(handover).not.toHaveBeenCalled();
  });

  it('refuses a project another core already serves', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const { send, next, handover, home } = await launch();
    const held = acquireCoreLock(projectDir(home, dir));
    onTestFinished(() => held.release());
    send({ type: 'project.open', requestId: 'o1', path: dir });
    expect((await next('project.open.result', 'o1')).error).toContain(String(process.pid));
    expect(handover).not.toHaveBeenCalled();
  });

  it('hands over once when two opens arrive back to back, and tells the second to wait', async () => {
    const dir = tempDir('ide-launcher-proj-');
    const { send, next, handover, launcher } = await launch();
    send({ type: 'project.open', requestId: 'a', path: dir });
    send({ type: 'project.open', requestId: 'b', path: dir });
    expect((await next('error')).message).toMatch(/restarting/);
    await launcher.finished;
    expect(handover).toHaveBeenCalledTimes(1);
  });
});

describe('launcher project.create', () => {
  it('creates a git repository and hands over to it', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const { send, next, handover, launcher } = await launch();
    send({ type: 'project.create', requestId: 'c1', parent, name: 'fresh' });
    expect(await next('project.create.result', 'c1')).toMatchObject({ error: null });
    await launcher.finished;
    expect(handover).toHaveBeenCalledExactlyOnceWith(join(parent, 'fresh'), launcher.port);
    expect(existsSync(join(parent, 'fresh', '.git'))).toBe(true);
  });

  it('reports a bad name and creates nothing, nor hands over', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const { send, next, handover } = await launch();
    send({ type: 'project.create', requestId: 'c1', parent, name: 'a/b' });
    expect((await next('project.create.result', 'c1')).error).toEqual(expect.any(String));
    expect(readdirSync(parent)).toEqual([]);
    expect(handover).not.toHaveBeenCalled();
  });
});

describe('launcher project.clone', () => {
  it('clones a local repository and hands over to the copy', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const { send, next, handover, launcher } = await launch();
    send({ type: 'project.clone', requestId: 'k1', url: sourceRepo(), parent, name: 'copy' });
    expect(await next('project.clone.result', 'k1')).toMatchObject({ error: null });
    await launcher.finished;
    expect(handover).toHaveBeenCalledExactlyOnceWith(join(parent, 'copy'), launcher.port);
    expect(readFileSync(join(parent, 'copy', 'hello.txt'), 'utf8')).toBe('hi');
  });

  it('refuses a second create or clone while one runs, and cancels the first on request', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const { send, next, handover } = await launch({ git });
    send({ type: 'project.clone', requestId: 'c1', url: 'x', parent, name: 'one' });
    expect(await next('project.clone.progress', 'c1')).toMatchObject({ phase: 'receiving', percent: 10 });
    send({ type: 'project.clone', requestId: 'c2', url: 'x', parent, name: 'two' });
    expect((await next('project.clone.result', 'c2')).error).toMatch(/already running/);
    send({ type: 'project.create', requestId: 'c3', parent, name: 'three' });
    expect((await next('project.create.result', 'c3')).error).toMatch(/already running/);
    send({ type: 'project.clone.cancel', requestId: 'c1' });
    expect(await next('project.clone.result', 'c1')).toMatchObject({ error: 'Clone cancelled.' });
    expect(readdirSync(parent)).toEqual([]);
    expect(handover).not.toHaveBeenCalled();
  });

  it('refuses to open a project while a clone runs', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const dir = tempDir('ide-launcher-proj-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const { send, next, handover } = await launch({ git });
    send({ type: 'project.clone', requestId: 'c1', url: 'x', parent, name: 'one' });
    await next('project.clone.progress', 'c1');
    send({ type: 'project.open', requestId: 'o1', path: dir });
    expect((await next('project.open.result', 'o1')).error).toMatch(/already running/);
    expect(handover).not.toHaveBeenCalled();
  });

  it('ignores a cancel for a request id that is not the running clone', async () => {
    const parent = tempDir('ide-launcher-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const { send, next, launcher } = await launch({ git });
    send({ type: 'project.clone', requestId: 'c1', url: 'x', parent, name: 'one' });
    await next('project.clone.progress', 'c1');
    send({ type: 'project.clone.cancel', requestId: 'other' });
    send({ type: 'fs.list', requestId: 'l1', path: parent });
    await next('fs.list.result', 'l1');
    expect(readdirSync(parent)).toEqual(['one']);
    await launcher.close();
    expect(readdirSync(parent)).toEqual([]);
  });
});
