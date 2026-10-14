import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import { AGENT_TERMINAL_ID, type ServerMessage } from '@ide/protocol';
import { runDir } from '../src/home';
import { isAlive } from '../src/os-process';
import { FAKE_CLAUDE, readRecords } from './fake-claude/fake';
import { fixture, tempDir, waitFor } from './helpers';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const OPEN_AGENT = { type: 'terminal.open', id: AGENT_TERMINAL_ID, cols: 80, rows: 24, kind: 'agent' };
const IN_TERMINAL = /The agent runs in the terminal view/;

// The interactive claude of the terminal is the fake claude behind a wrapper that logs the signals it gets and,
// when asked, ignores SIGTERM or exits by itself; the headless check of the hooks runs the fake claude as it is.
const WRAPPER = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const log = (line) => appendFileSync(process.env.WRAPPER_LOG, line + '\\n');
if (process.argv.includes('--input-format')) {
  log((process.argv.includes('--no-session-persistence') ? 'probe ' : 'chat ') + process.pid);
} else {
  log('start ' + process.pid);
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      log(signal);
      if (process.env.WRAPPER_MODE !== 'stubborn') process.exit(0);
    });
  }
  if (process.env.WRAPPER_MODE === 'exits') setTimeout(() => process.exit(0), 1500);
  if (process.env.WRAPPER_MODE === 'turn') {
    // As claude does when the user submits a prompt: the event hook of the settings gets the payload on its stdin.
    const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
    const settings = JSON.parse(readFileSync(argument('--settings'), 'utf8'));
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
    setTimeout(() => {
      const child = spawn(hook.command, hook.args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.end(JSON.stringify({
        hook_event_name: 'UserPromptSubmit', session_id: argument('--session-id') ?? argument('--resume'),
        transcript_path: process.env.WRAPPER_TRANSCRIPT, cwd: process.cwd(), prompt: 'refactor everything',
      }));
      child.on('exit', () => log('prompted'));
    }, 1000);
  }
}
await import(process.env.WRAPPED_CLAUDE);
`;

type Mode = 'obedient' | 'stubborn' | 'exits' | 'turn';

async function startMain(mode: Mode, extraEnv: Record<string, string> = {}) {
  const base = tempDir('main-agent-terminal-');
  const root = join(base, 'project');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  mkdirSync(join(base, 'ui'));
  mkdirSync(root);
  writeFileSync(join(root, 'notes.txt'), 'notes\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const wrapper = join(base, 'claude-wrapper.mjs');
  writeFileSync(wrapper, WRAPPER);
  chmodSync(wrapper, 0o755);
  const log = join(base, 'wrapper.log');
  writeFileSync(log, '');
  const record = join(base, 'fake-record.jsonl');
  const transcript = join(base, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', MAIN, '--project', root, '--ide-home', join(base, 'home'), '--port', '0', '--ui', join(base, 'ui'), '--claude', wrapper],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_CLAUDE_SCENARIO: fixture('stream/text-then-wait.jsonl'), FAKE_CLAUDE_RECORD: record,
        WRAPPER_LOG: log, WRAPPER_MODE: mode, WRAPPER_TRANSCRIPT: transcript, WRAPPED_CLAUDE: pathToFileURL(FAKE_CLAUDE).href, IDE_DEFAULT_MODEL: 'sonnet', ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { output += String(chunk); });
  const lines = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  // The pids of the claudes the terminal started, and the signals they logged.
  const started = (): number[] => lines().filter((line) => line.startsWith('start ')).map((line) => Number(line.slice(6)));
  const pidsLogged = (kind: string): number[] => lines().filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.slice(kind.length + 1)));
  // The headless checks of the hooks and the claudes of the chat, by pid.
  const probes = (): number[] => pidsLogged('probe');
  const chats = (): number[] => pidsLogged('chat');
  // The gate and MCP files of a run, which exist only while a claude runs or is about to.
  const runFiles = (): string[] => (existsSync(runDir(join(base, 'home'))) ? readdirSync(runDir(join(base, 'home'))).filter((name) => /\.(settings|hook|mcp)\.json$/.test(name)) : []);
  // True once a hook check that was told to go on running after it reported has been sent SIGTERM, which is when CodeRay starts waiting for it to stop.
  const checkBeingStopped = (): boolean => readRecords(record).some((entry) => entry.ignoredSignal === 'SIGTERM');
  const signals = (): string[] => lines().filter((line) => /^SIG/.test(line));
  const prompted = (): boolean => lines().includes('prompted');
  const writeTranscript = (line: string) => appendFileSync(transcript, `${line}\n`);
  onTestFinished(async () => {
    child.kill('SIGTERM');
    await exited;
    for (const pid of [...started(), ...pidsLogged('probe'), ...pidsLogged('chat')]) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
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
  const send = (message: object) => socket.send(JSON.stringify(message));
  const count = (type: string) => messages.filter((message) => message.type === type).length;
  const errors = () => messages.flatMap((message) => (message.type === 'error' ? [message.message] : []));
  return { messages, send, count, errors, started, probes, chats, runFiles, checkBeingStopped, signals, prompted, writeTranscript, exited, child };
}

type Main = Awaited<ReturnType<typeof startMain>>;

async function openAgentTerminal(main: Main): Promise<void> {
  main.send(OPEN_AGENT);
  await waitFor(() => main.count('terminal.opened') === 1 || main.errors()[0], 'the agent terminal opened', 30_000);
  expect(main.errors()).toEqual([]);
  await waitFor(() => main.started().length === 1, 'the claude of the terminal started');
}

describe('main.ts and the agent terminal', { timeout: 120_000 }, () => {
  it('does not let a second agent terminal open while the closed one is still being stopped, and lets it once claude is gone', async () => {
    const main = await startMain('stubborn');
    await openAgentTerminal(main);
    main.send({ type: 'terminal.close', id: AGENT_TERMINAL_ID });
    await waitFor(() => main.count('terminal.closed') === 1, 'the terminal announced closed');
    main.send(OPEN_AGENT);
    await waitFor(() => main.errors().find((message) => IN_TERMINAL.test(message)), 'the refusal to open a second agent terminal');
    expect(main.count('terminal.opened')).toBe(1);
    expect(main.started()).toHaveLength(1);
    const [pid] = main.started() as [number];
    await waitFor(() => !isAlive(pid), 'claude killed after it ignored SIGTERM', 15_000);
    main.send(OPEN_AGENT);
    await waitFor(() => main.count('terminal.opened') === 2, 'the agent terminal opened again', 30_000);
    expect(main.errors().filter((message) => !IN_TERMINAL.test(message))).toEqual([]);
  });

  it('stops the claude of the terminal with SIGTERM when the terminal is closed, not with SIGHUP', async () => {
    const main = await startMain('obedient');
    await openAgentTerminal(main);
    const [pid] = main.started() as [number];
    main.send({ type: 'terminal.close', id: AGENT_TERMINAL_ID });
    await waitFor(() => !isAlive(pid), 'claude stopped');
    expect(main.signals()).toEqual(['SIGTERM']);
  });

  it('opens the agent terminal again right after claude stopped on SIGTERM', async () => {
    const main = await startMain('obedient');
    await openAgentTerminal(main);
    main.send({ type: 'terminal.close', id: AGENT_TERMINAL_ID });
    await waitFor(() => main.count('terminal.closed') === 1, 'the terminal announced closed');
    await waitFor(() => main.started().every((pid) => !isAlive(pid)), 'claude stopped');
    main.send(OPEN_AGENT);
    await waitFor(() => main.count('terminal.opened') === 2, 'the agent terminal opened again', 30_000);
    expect(main.errors()).toEqual([]);
  });

  it('ends the terminal mode when claude exits by itself, so the chat can be used again', async () => {
    const main = await startMain('exits');
    await openAgentTerminal(main);
    await waitFor(() => main.count('terminal.exit') === 1, 'claude exited', 15_000);
    main.send({ type: 'chat.send', text: 'hello from the chat' });
    await waitFor(() => main.messages.some((message) => JSON.stringify(message).includes('hello from the chat')), 'the message of the chat shown');
    expect(main.errors().filter((message) => IN_TERMINAL.test(message))).toEqual([]);
  });

  it('keeps the terminal mode while claude runs: the chat cannot send then', async () => {
    const main = await startMain('obedient');
    await openAgentTerminal(main);
    main.send({ type: 'chat.send', text: 'hello from the chat' });
    await waitFor(() => main.errors().find((message) => IN_TERMINAL.test(message)), 'the refusal to send');
  });

  it('stops the claude of the terminal when the core shuts down', async () => {
    const main = await startMain('obedient');
    await openAgentTerminal(main);
    const [pid] = main.started() as [number];
    main.child.kill('SIGTERM');
    await main.exited;
    expect(isAlive(pid)).toBe(false);
    expect(main.signals()).toEqual(['SIGTERM']);
  });

  describe('Esc typed in the terminal', () => {
    const MARKER = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    const ESC = '\x1b';
    const mentions = (main: Main, text: string) => main.messages.some((message) => JSON.stringify(message).includes(text));

    async function turnRunning() {
      const main = await startMain('turn');
      await openAgentTerminal(main);
      await waitFor(() => main.prompted(), 'the prompt submitted in the terminal', 15_000);
      await waitFor(() => mentions(main, 'refactor everything'), 'the prompt shown in the chat');
      return main;
    }

    it('confirms the marker of Esc in the transcript once Esc was typed into the agent terminal, and not before', async () => {
      const main = await turnRunning();
      main.writeTranscript(MARKER);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(mentions(main, 'error_during_execution')).toBe(false);
      main.send({ type: 'terminal.input', id: AGENT_TERMINAL_ID, data: ESC });
      main.writeTranscript(MARKER);
      await waitFor(() => mentions(main, 'error_during_execution'), 'the turn closed as interrupted');
    });

    it('does not take Esc typed into a shell terminal for the key', async () => {
      const main = await turnRunning();
      main.send({ type: 'terminal.open', id: 'shell1', cols: 80, rows: 24 });
      await waitFor(() => main.count('terminal.opened') === 2, 'the shell terminal opened', 15_000);
      main.send({ type: 'terminal.input', id: 'shell1', data: ESC });
      main.writeTranscript(MARKER);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(mentions(main, 'error_during_execution')).toBe(false);
    });

    it('counts the Esc CodeRay types for a stop as the key', async () => {
      const main = await turnRunning();
      main.send({ type: 'chat.stop' });
      main.writeTranscript(MARKER);
      await waitFor(() => mentions(main, 'error_during_execution'), 'the turn closed as interrupted');
    });
  });

  describe('a terminal closed while its hooks are checked', () => {
    // 'before': the check starts slowly and is still silent when the terminal is closed.
    // 'after': the check has reported and CodeRay is only waiting for it to stop, which takes seconds.
    // Either way the test waits until the check is over, and then a while longer, for what a launch that went on would do.
    async function closedDuringCheck(when: 'before' | 'after') {
      const main = await startMain('obedient', when === 'before' ? { FAKE_CLAUDE_PROBE_STARTUP_MS: '3000' } : { FAKE_CLAUDE_PROBE_IGNORES_SIGTERM: '1' });
      main.send(OPEN_AGENT);
      if (when === 'before') await waitFor(() => main.probes().length === 1, 'the hook check started');
      else await waitFor(() => main.checkBeingStopped(), 'the hook check reported and is being stopped');
      main.send({ type: 'terminal.close', id: AGENT_TERMINAL_ID });
      const [probe] = main.probes() as [number];
      await waitFor(() => !isAlive(probe), 'the hook check over', 20_000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return main;
    }

    describe.each(['before', 'after'] as const)('%s the hooks reported', (when) => {
      it('opens no terminal and never starts the interactive claude', async () => {
        const main = await closedDuringCheck(when);
        expect([main.count('terminal.opened'), main.started(), main.errors()]).toEqual([0, [], []]);
      });

      it('does not refuse the session or say that the hook did not start', async () => {
        const main = await closedDuringCheck(when);
        const everything = JSON.stringify(main.messages);
        expect(everything).not.toContain('hook did not start');
        expect(everything).not.toContain('"status":"refused"');
      });

      it('removes the gate and MCP files of the run dir', async () => {
        const main = await closedDuringCheck(when);
        expect(main.runFiles()).toEqual([]);
      });

      it('ends the terminal mode: the chat sends, starts its own claude and meets no in-terminal error', async () => {
        const main = await closedDuringCheck(when);
        main.send({ type: 'chat.send', text: 'hello from the chat' });
        await waitFor(() => main.chats().length === 1, 'the claude of the chat started');
        await waitFor(() => main.messages.some((message) => JSON.stringify(message).includes('hello from the chat')), 'the message of the chat shown');
        expect(main.errors()).toEqual([]);
        expect(main.started()).toEqual([]);
      });

      it('lets a terminal open normally afterwards', async () => {
        const main = await closedDuringCheck(when);
        main.send(OPEN_AGENT);
        await waitFor(() => main.count('terminal.opened') === 1 || main.errors()[0], 'the agent terminal opened', 40_000);
        expect(main.errors()).toEqual([]);
        await waitFor(() => main.started().length === 1, 'the claude of the terminal started');
        main.send({ type: 'chat.send', text: 'hello from the chat' });
        await waitFor(() => main.errors().find((message) => IN_TERMINAL.test(message)), 'the refusal to send while the terminal runs');
      });
    });
  });
});
