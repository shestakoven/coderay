import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@ide/protocol';
import { tempDir, waitFor } from './helpers';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function spawnLauncher(base: string, port: number | string) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', MAIN, '--ide-home', join(base, 'home'), '--port', String(port), '--ui', join(base, 'ui')], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const output = { text: '' };
  child.stdout?.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  onTestFinished(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  return { exited, output };
}

describe('main.ts without --project', { timeout: 90_000 }, () => {
  it('starts the launcher: a project-less greeting, folder browsing, errors for project messages', async () => {
    const base = tempDir('main-launcher-');
    mkdirSync(join(base, 'ui'));
    const { output } = spawnLauncher(base, 0);
    const url = await waitFor(() => /open: http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+)/.exec(output.text) ?? undefined, `the core address in:\n${output.text}`, 60_000);
    const socket = new WebSocket(`ws://127.0.0.1:${url[1]}/ws?token=${url[2]}`);
    onTestFinished(() => socket.terminate());
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    expect(await waitFor(() => messages.find((m) => m.type === 'project.info'), 'the greeting')).toMatchObject({ info: { root: null } });
    socket.send(JSON.stringify({ type: 'session.new' }));
    expect(await waitFor(() => messages.find((m) => m.type === 'error'), 'an error reply')).toMatchObject({ message: expect.stringContaining('until a project is open') });
    socket.send(JSON.stringify({ type: 'fs.list', requestId: 'l1', path: base }));
    expect(await waitFor(() => messages.find((m) => m.type === 'fs.list.result'), 'the listing')).toMatchObject({ requestId: 'l1', path: base, error: null });
    expect(messages.map((m) => m.type)).toEqual(['project.info', 'error', 'fs.list.result']);
  });

  it('exits with a message, not an unhandled rejection, when the port is taken', async () => {
    const base = tempDir('main-launcher-');
    mkdirSync(join(base, 'ui'));
    const first = spawnLauncher(base, 0);
    const taken = await waitFor(() => /open: http:\/\/127\.0\.0\.1:(\d+)\//.exec(first.output.text)?.[1], `the first core address in:\n${first.output.text}`, 60_000);
    const second = spawnLauncher(base, taken);
    expect(await second.exited).toBe(1);
    expect(second.output.text).toContain('CodeRay core failed to start: ');
    expect(second.output.text).toContain('EADDRINUSE');
    expect(second.output.text).not.toContain('    at ');
  });
});
