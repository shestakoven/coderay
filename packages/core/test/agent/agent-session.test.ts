import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatItem, SessionServerMessage } from '@ide/protocol';
import { AgentSession, SessionError, type AgentSessionOptions } from '../../src/agent/agent-session';
import { CLI_REJECTION } from '../../src/agent/prompts';
import { projectDir, runDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type Store } from '../../src/store/store';
import { FAKE_CLAUDE, fakeClaude, readRecords } from '../fake-claude/fake';
import { fixture, tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  home: string;
  root: string;
  broadcasts: SessionServerMessage[];
  argvs: () => string[][];
  stdin: () => { type: string; [key: string]: unknown }[];
}

async function harness(scenario: string, overrides: Partial<AgentSessionOptions> = {}): Promise<Harness> {
  const home = overrides.home ?? tempDir('ide-home-');
  const root = overrides.root ?? tempDir('ide-root-');
  const store = openStore(projectDir(home, root));
  const recordFile = join(home, `record-${randomUUID()}.jsonl`);
  const session = new AgentSession({ root, home, store, claude: fakeClaude(scenario, recordFile), ...overrides });
  const broadcasts: SessionServerMessage[] = [];
  session.onMessage((message) => broadcasts.push(message));
  onTestFinished(async () => {
    await session.close();
    store.close();
  });
  await session.start();
  const records = () => readRecords(recordFile);
  return {
    session, store, home, root, broadcasts,
    argvs: () => records().flatMap((r) => (r.argv ? [r.argv] : [])),
    stdin: () => records().flatMap((r) => (r.stdin ? [r.stdin] : [])),
  };
}

interface Seed {
  claudeSessionId: string;
  pid: number;
}

function seedRunningSession(home: string, root: string, seed: Seed): void {
  const store = openStore(projectDir(home, root));
  store.saveSession({
    id: 'session-1', claudeSessionId: seed.claudeSessionId, cwd: root, status: 'running', model: null, cliVersion: null,
    pid: seed.pid, launchId: seed.claudeSessionId, conversationStarted: true, startedAt: 1,
  });
  store.saveTurn('session-1', { id: 'turn-1', kind: 'user', openedAt: 2, startedAt: 3, closedAt: null, resultSubtype: null });
  store.close();
}

function spawnHanging(claudeSessionId: string, scenario = 'hang', recordFile = '') {
  const child = spawn(process.execPath, [FAKE_CLAUDE, '--session-id', claudeSessionId], {
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: fixture(`stream/${scenario}.jsonl`), FAKE_CLAUDE_RECORD: recordFile },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  onTestFinished(() => {
    child.kill('SIGKILL');
  });
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid ?? -1;
}

const exitSignal = (child: ReturnType<typeof spawn>) =>
  new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
const closedTurns = (h: Harness) => h.session.state().turns.filter((turn) => turn.closedAt !== null);
const texts = (items: ChatItem[]) =>
  items.map((item) => (item.kind === 'tool' ? `${item.tool}:${item.status}` : item.kind === 'prompt' ? `prompt:${item.status}` : item.text));
const flag = (argv: string[] | undefined, name: string) => argv?.[argv.indexOf(name) + 1];
const pendingPrompt = (h: Harness) =>
  waitFor(() => h.session.state().items.find((item) => item.kind === 'prompt' && item.status === 'pending'), 'prompt shown');
const controlResponse = (h: Harness) => h.stdin().find((message) => message.type === 'control_response');

describe('AgentSession', () => {
  it('spawns claude in stream-json mode with a per-session strict MCP config, the disallowed tools, bypass permissions and prompts on stdio', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    const [argv] = await waitFor(() => h.argvs().length === 1 && h.argvs(), 'claude spawned');
    const session = h.session.state().session;
    expect(argv).toEqual([
      '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--session-id', session?.claudeSessionId,
      '--mcp-config', join(runDir(h.home), `${basename(projectDir(h.home, h.root))}-${session?.id}.mcp.json`),
      '--strict-mcp-config',
      '--disallowedTools', 'SendMessage,CronCreate,CronDelete,CronList,ScheduleWakeup,RemoteTrigger,Workflow,EnterWorktree,ExitWorktree,DesignSync,PushNotification',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
    ]);
  });

  it("writes the user's message to claude and records the answer in a closed user turn", async () => {
    const h = await harness('multi-turn');
    h.session.send('Remember the number 42. Reply with only: OK');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.stdin()).toEqual([{ type: 'user', message: { role: 'user', content: 'Remember the number 42. Reply with only: OK' } }]);
    expect(texts(h.session.state().items)).toEqual(['Remember the number 42. Reply with only: OK', 'OK']);
    expect(closedTurns(h)).toMatchObject([{ kind: 'user', resultSubtype: 'success' }]);
  });

  it("keeps the model, CLI version, permission mode and MCP server statuses from claude's init", async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.state().session).toMatchObject({
      status: 'running', model: 'claude-haiku-4-5-20251001', cliVersion: '2.1.281', permissionMode: 'bypassPermissions',
    });
    expect(h.session.state().mcpServers).toEqual([{ name: 'spike', status: 'connected' }]);
  });

  it('sends clients a snapshot for a new session and then the chat items as patches', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    const [first, ...rest] = h.broadcasts;
    const patchedItems = rest.flatMap((message) => (message.type === 'session.patch' ? (message.patch.items ?? []) : []));
    expect([first?.type, texts(patchedItems)]).toEqual(['session.snapshot', ['hi', 'OK']]);
  });

  it('refuses a message while a turn is open', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    expect(() => h.session.send('again')).toThrow(SessionError);
  });

  it('stop interrupts a running foreground tool call, which ends rejected and is no background task, and the turn ends error_during_execution', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool'), 'tool call started');
    expect(h.session.stop()).toBe(true);
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(texts(h.session.state().items)).toEqual(['run it', 'Bash:rejected']);
    expect(closedTurns(h)[0]?.resultSubtype).toBe('error_during_execution');
    expect(h.session.state().tasks).toEqual([]);
  });

  it('answers the next message after a stop', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool'), 'tool call started');
    h.session.stop();
    await waitFor(() => closedTurns(h).length === 1, 'first turn closed');
    h.session.send('still there?');
    await waitFor(() => closedTurns(h).length === 2, 'second turn closed');
    expect(texts(h.session.state().items).at(-1)).toBe('ALIVE');
  });

  it('stop ends the turn and every running background subagent with it', async () => {
    const h = await harness('interrupt-subagent');
    h.session.send('start a subagent');
    await waitFor(() => closedTurns(h).length === 1, 'first turn closed');
    expect(h.session.state().tasks).toMatchObject([{ kind: 'subagent', status: 'running' }]);
    h.session.send('run it');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool' && item.tool === 'Bash'), 'tool call started');
    h.session.stop();
    await waitFor(() => closedTurns(h).length === 2, 'second turn closed');
    expect(h.session.state().tasks).toMatchObject([{ kind: 'subagent', status: 'killed' }]);
    expect(texts(h.session.state().items).slice(-3)).toEqual(['run it', 'Bash:rejected', 'Background subagent stopped: Run a slow command']);
  });

  it('does not interrupt when no turn is running', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.stop()).toBe(false);
    expect(h.stdin().filter((message) => message.type === 'control_request')).toEqual([]);
  });

  it('an agent-initiated turn does not shift turn matching', async () => {
    const h = await harness('async-subagent');
    h.session.send('start a subagent');
    await waitFor(() => closedTurns(h).length === 2, 'agent-initiated turn closed');
    h.session.send('next');
    await waitFor(() => closedTurns(h).length === 3, 'follow-up turn closed');
    const { turns, items } = h.session.state();
    expect(turns.map((turn) => [turn.kind, texts(items.filter((item) => item.turnId === turn.id))])).toEqual([
      ['user', ['start a subagent', 'Agent:ok', 'STARTED']],
      ['agent-initiated', ['The subagent created sub.txt.']],
      ['user', ['next', 'NEXT']],
    ]);
  });

  it('marks the session crashed and closes the open turn and tool call when claude exits unexpectedly', async () => {
    const h = await harness('crash-mid-turn');
    h.session.send('go');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'session crashed');
    expect(h.session.state().turns).toMatchObject([{ resultSubtype: 'crashed' }]);
    expect(texts(h.session.state().items)).toEqual(['go', 'Bash:unfinished', 'claude stopped unexpectedly (exit code 1): fatal: simulated crash']);
  });

  it('marks the session crashed with the spawn error when claude cannot be started', async () => {
    const h = await harness('multi-turn', { claude: { command: '/nonexistent/claude', args: [] } });
    h.session.send('hi');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'session crashed');
    expect(texts(h.session.state().items).at(-1)).toContain('ENOENT');
  });

  it('resumes the conversation with --resume on the next message after a crash', async () => {
    const h = await harness('crash-mid-turn');
    h.session.send('go');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'session crashed');
    h.session.send('again');
    const argvs = await waitFor(() => h.argvs().length === 2 && h.argvs(), 'claude respawned');
    expect(flag(argvs[1], '--resume')).toBe(flag(argvs[0], '--session-id'));
    expect(argvs[1]).not.toContain('--session-id');
  });

  it('keeps the chat history and resumes the same claude session after a core restart', async () => {
    const first = await harness('multi-turn');
    first.session.send('Remember the number 42. Reply with only: OK');
    await waitFor(() => closedTurns(first).length === 1, 'first turn closed');
    await first.session.close();

    const second = await harness('multi-turn', { home: first.home, root: first.root });
    expect(second.session.state().session?.status).toBe('stopped');
    expect(texts(second.session.state().items)).toEqual(['Remember the number 42. Reply with only: OK', 'OK']);
    second.session.send('What number did I ask you to remember?');
    const [argv] = await waitFor(() => second.argvs().length === 1 && second.argvs(), 'claude resumed');
    expect(flag(argv, '--resume')).toBe(flag(first.argvs()[0], '--session-id'));
  });

  it('stops the stale claude of a session that was running when the core died and closes its turn as crashed', async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    const claudeSessionId = randomUUID();
    const stale = spawnHanging(claudeSessionId);
    const staleExit = exitSignal(stale);
    seedRunningSession(home, root, { claudeSessionId, pid: stale.pid ?? -1 });

    const h = await harness('multi-turn', { home, root });

    expect(await staleExit).toBe('SIGTERM');
    expect(h.session.state().session?.status).toBe('crashed');
    expect(h.session.state().turns).toMatchObject([{ id: 'turn-1', resultSubtype: 'crashed' }]);
  });

  it('kills a stale claude that ignores SIGTERM, and its child processes, once the grace time is over', async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    const claudeSessionId = randomUUID();
    const record = join(home, 'stale-record.jsonl');
    const stale = spawnHanging(claudeSessionId, 'stubborn', record);
    const staleExit = exitSignal(stale);
    const sleeper = await waitFor(() => readRecords(record).find((r) => r.sleeperPid)?.sleeperPid, 'sleeper started');
    seedRunningSession(home, root, { claudeSessionId, pid: stale.pid ?? -1 });

    await harness('multi-turn', { home, root, killGraceMs: 200 });

    expect(await staleExit).toBe('SIGKILL');
    await waitFor(() => !isAlive(sleeper), 'sleeper stopped');
  });

  it('leaves alone a live process whose command line does not name the recorded session', async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    const unrelated = spawnHanging(randomUUID());
    const unrelatedExit = exitSignal(unrelated);
    seedRunningSession(home, root, { claudeSessionId: randomUUID(), pid: unrelated.pid ?? -1 });

    await harness('multi-turn', { home, root });
    unrelated.kill('SIGTERM');

    expect(await unrelatedExit).toBe('SIGTERM');
  });

  it("deletes a stale session's MCP config file at core start", async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    seedRunningSession(home, root, { claudeSessionId: randomUUID(), pid: await deadPid() });
    const stalePath = join(runDir(home), `${basename(projectDir(home, root))}-session-1.mcp.json`);
    mkdirSync(runDir(home), { recursive: true });
    writeFileSync(stalePath, '{"mcpServers":{}}');

    await harness('multi-turn', { home, root });

    expect(existsSync(stalePath)).toBe(false);
  });

  it('writes the MCP servers into a config only the user can read and deletes it when the session ends', async () => {
    const servers = { docs: { type: 'http', url: 'http://127.0.0.1:1/mcp' } };
    const h = await harness('multi-turn', { mcpServers: () => servers });
    h.session.send('hi');
    const [argv] = await waitFor(() => h.argvs().length === 1 && h.argvs(), 'claude spawned');
    const configPath = flag(argv, '--mcp-config') ?? '';
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ mcpServers: servers });
    await h.session.newSession();
    expect(existsSync(configPath)).toBe(false);
  });

  it('tightens a run directory that already exists to owner-only', async () => {
    const home = tempDir('ide-home-');
    mkdirSync(runDir(home), { recursive: true });
    chmodSync(runDir(home), 0o755);
    const h = await harness('multi-turn', { home });
    h.session.send('hi');
    await waitFor(() => h.argvs().length === 1, 'claude spawned');
    expect(statSync(runDir(home)).mode & 0o777).toBe(0o700);
  });

  it('shows an AskUserQuestion prompt in the chat and answers it inside the open turn', async () => {
    const h = await harness('ask-user-question');
    h.session.send('ask me');
    const prompt = await pendingPrompt(h);
    expect(prompt).toMatchObject({
      turnId: h.session.state().turns[0]?.id,
      body: { tool: 'AskUserQuestion', questions: [{ question: 'Which color?' }, { question: 'Which sizes?', multiSelect: true }] },
    });

    h.session.answerPrompt(prompt.id, { kind: 'answers', answers: { 'Which color?': 'Blue', 'Which sizes?': 'S, M' } });

    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(controlResponse(h)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_fx_ask',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: [
              { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'Red color' }, { label: 'Blue', description: 'Blue color' }], multiSelect: false },
              {
                question: 'Which sizes?', header: 'Sizes', multiSelect: true,
                options: [{ label: 'S', description: 'Small' }, { label: 'M', description: 'Medium' }, { label: 'L', description: 'Large' }],
              },
            ],
            answers: { 'Which color?': 'Blue', 'Which sizes?': 'S, M' },
          },
        },
      },
    });
  });

  it('refuses an answer that leaves a question unanswered', async () => {
    const h = await harness('ask-user-question');
    h.session.send('ask me');
    const prompt = await pendingPrompt(h);
    expect(() => h.session.answerPrompt(prompt.id, { kind: 'answers', answers: { 'Which color?': 'Blue' } })).toThrow('Answer "Which sizes?" first.');
  });

  it("shows plan mode while the agent plans and approves the agent's plan from the chat", async () => {
    const h = await harness('plan-approval');
    h.session.send('plan it');
    const prompt = await pendingPrompt(h);
    expect(h.session.state().session?.permissionMode).toBe('plan');
    h.session.answerPrompt(prompt.id, { kind: 'allow' });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(controlResponse(h)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: 'req_fx_plan',
        response: { behavior: 'allow', updatedInput: { plan: '1. Create plan.txt containing hello.\n', planFilePath: '/fake/home/.claude/plans/fx-plan.md' } },
      },
    });
    expect(h.session.state().session?.permissionMode).toBe('bypassPermissions');
    expect(texts(h.session.state().items)).toEqual([
      'plan it', 'EnterPlanMode:ok',
      'The agent entered plan mode: it explores and plans, and changes no files until you approve a plan.',
      'ExitPlanMode:ok', 'prompt:answered', 'The agent left plan mode.', 'Created plan.txt.',
    ]);
  });

  it("keeps planning with the CLI's own rejection text when the user does not approve the plan", async () => {
    const h = await harness('plan-approval');
    h.session.send('plan it');
    const prompt = await pendingPrompt(h);
    h.session.answerPrompt(prompt.id, { kind: 'deny', feedback: '' });
    await waitFor(() => controlResponse(h), 'answer written');
    expect(controlResponse(h)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_fx_plan', response: { behavior: 'deny', message: CLI_REJECTION } },
    });
  });

  it('drops a pending prompt when Stop ends its turn and refuses a late answer', async () => {
    const h = await harness('ask-user-question');
    h.session.send('ask me');
    const prompt = await pendingPrompt(h);
    h.session.stop();
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.state().items.find((item) => item.id === prompt.id)).toMatchObject({ status: 'dropped' });
    expect(() => h.session.answerPrompt(prompt.id, { kind: 'answers', answers: { 'Which color?': 'blue' } })).toThrow(SessionError);
  });

  it('denies a permission prompt for any other tool and says why in the chat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const h = await harness('unexpected-prompt');
    h.session.send('write the settings');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(controlResponse(h)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_fx_settings', response: { behavior: 'deny', message: 'The IDE does not answer permission prompts for Write.' } },
    });
    expect(texts(h.session.state().items)).toContain('Refused a "can_use_tool" request from claude: The IDE does not answer permission prompts for Write.');
  });

  it('ends the session on New session and starts a fresh claude conversation with the next message', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    await h.session.newSession();
    expect(h.session.state()).toEqual({ session: null, turns: [], items: [], tasks: [], mcpServers: [] });
    h.session.send('hello again');
    const argvs = await waitFor(() => h.argvs().length === 2 && h.argvs(), 'second claude spawned');
    expect(flag(argvs[1], '--session-id')).not.toBe(flag(argvs[0], '--session-id'));
  });

  it('refuses a message while the session is restarting', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    const restarting = h.session.restart();
    expect(() => h.session.send('again')).toThrow('The session is restarting.');
    await restarting;
  });

  it('notes in the chat when claude is older than the minimum version', async () => {
    const h = await harness('old-cli');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(texts(h.session.state().items)).toContain(
      'claude 2.1.100 is older than 2.1.281, the version the IDE was verified with; tool names and stream events may differ.',
    );
  });

  it('keeps the chat going in memory and logs when the history cannot be saved', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const h = await harness('multi-turn');
    h.session.send('hi');
    h.store.close();
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(texts(h.session.state().items)).toEqual(['hi', 'OK']);
    expect(errors).toHaveBeenCalledWith('agent: could not save session history', expect.any(Error));
  });
});
