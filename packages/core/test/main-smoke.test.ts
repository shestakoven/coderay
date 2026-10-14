import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@ide/protocol';
import { FAKE_CLAUDE } from './fake-claude/fake';
import { fixture, tempDir, waitFor, writeTree } from './helpers';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

async function startMain(options: { claude?: string; env?: Record<string, string> } = {}): Promise<{ messages: ServerMessage[]; socket: WebSocket }> {
  const base = tempDir('main-smoke-');
  const root = join(base, 'project');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  mkdirSync(join(base, 'ui'));
  await writeTree(root, { 'notes.txt': 'notes\n', 'src/app.ts': 'export const a = 1;\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', MAIN, '--project', root, '--ide-home', join(base, 'home'), '--port', '0', '--ui', join(base, 'ui'), '--claude', options.claude ?? FAKE_CLAUDE],
    {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: fixture('stream/text-then-wait.jsonl'), IDE_DEFAULT_MODEL: 'sonnet', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { output += String(chunk); });
  onTestFinished(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  const url = await waitFor(() => /open: (http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+))/.exec(output) ?? undefined, `the core address in:\n${output}`, 60_000);
  const socket = new WebSocket(`ws://127.0.0.1:${url[2]}/ws?token=${url[3]}`);
  onTestFinished(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { messages, socket };
}

describe('main.ts', { timeout: 90_000 }, () => {
  it('greets with the history snapshot, errors on a diff for an unknown hash', async () => {
    const { messages, socket } = await startMain();
    const greeting = await waitFor(() => messages.find((m) => m.type === 'history.snapshot'), 'the history snapshot');
    expect(greeting).toMatchObject({ history: { changes: [], events: [], reverts: [] } });

    socket.send(JSON.stringify({ type: 'history.diff', requestId: 'r1', path: 'notes.txt', before: 'f'.repeat(40), after: null }));
    const result = await waitFor(() => messages.find((m) => m.type === 'history.result'), 'the diff result');
    expect(result).toMatchObject({ requestId: 'r1', error: expect.stringMatching(/./) });
    expect(messages.filter((m) => m.type === 'history.result')).toHaveLength(1);
  });

  it('hands neither IDE_NODE nor ELECTRON_RUN_AS_NODE on to the claude it starts', async () => {
    const dir = tempDir('main-env-');
    const seen = join(dir, 'seen');
    const claude = join(dir, 'claude');
    writeFileSync(claude, `#!/bin/sh\nprintf '%s %s\\n' "\${IDE_NODE-unset}" "\${ELECTRON_RUN_AS_NODE-unset}" >> '${seen}'\n`, { mode: 0o755 });
    const { socket } = await startMain({ claude, env: { IDE_NODE: join(dir, 'launcher'), ELECTRON_RUN_AS_NODE: '1' } });
    socket.send(JSON.stringify({ type: 'chat.send', text: 'hello' }));
    expect(await waitFor(() => (existsSync(seen) ? readFileSync(seen, 'utf8').trim() : ''), 'the claude to start')).toBe('unset unset');
  });

  it('answers a request for the models with the state of each engine first, then the models', async () => {
    const { messages, socket } = await startMain();
    socket.send(JSON.stringify({ type: 'models.list' }));
    await waitFor(() => messages.some((m) => m.type === 'models.snapshot'), 'the models');
    const answers = messages.filter((m) => m.type === 'engines.snapshot' || m.type === 'models.snapshot');
    expect([answers.map((m) => m.type), answers[0]]).toEqual([
      ['engines.snapshot', 'models.snapshot'],
      { type: 'engines.snapshot', engines: [{ engine: 'claude', state: 'ready', hint: null }] },
    ]);
  });

  it('tells the UI that a new chat needs a model when IDE_DEFAULT_MODEL names none claude takes', async () => {
    const { messages } = await startMain({ env: { IDE_DEFAULT_MODEL: '--evil' } });
    expect(await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot'), 'the chats')).toMatchObject({ sessions: [], next: null });
  });

  it('tells the UI what a new chat starts with, and lists the model a New chat gives the unused chat', async () => {
    const { messages, socket } = await startMain();
    const greeting = await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot'), 'the chats');
    socket.send(JSON.stringify({ type: 'session.new' }));
    await waitFor(() => messages.some((m) => m.type === 'session.patch' && m.patch.session?.status === 'running'), "the new chat's agent");
    socket.send(JSON.stringify({ type: 'session.new', modelChoice: 'opus', effort: 'medium' }));
    const listed = await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot' && m.sessions[0]?.modelChoice === 'opus'), 'the chat on its new model');
    expect([greeting, listed]).toMatchObject([
      { next: { engine: 'claude', modelChoice: 'sonnet', effort: 'medium' } },
      { next: { engine: 'claude', modelChoice: 'opus', effort: 'medium' } },
    ]);
  });
});
