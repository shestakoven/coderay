import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { EMPTY_USAGE, type ChatItem, type SessionServerMessage } from '@ide/protocol';
import { AgentSession, SessionError, type AgentSessionOptions, type SessionGate } from '../../src/agent/agent-session';
import { CLI_REJECTION } from '../../src/agent/prompts';
import type { ToolEndInfo } from '../../src/agent/tracker';
import { systemPrompt } from '../../src/agent/system-prompt';
import { projectDir, runDir } from '../../src/home';
import { aliveRoute, Canary } from '../../src/gate/canary';
import { UNCLEAN_STOP_KEY } from '../../src/watchdog/recovery';
import { removeGateFiles, writeGateFiles } from '../../src/hook/gate-files';
import { isAlive } from '../../src/os-process';
import { startServer } from '../../src/server/server';
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

async function harness(scenario: string, overrides: Partial<AgentSessionOptions> = {}, fakeEnv: Record<string, string> = {}): Promise<Harness> {
  const home = overrides.home ?? tempDir('ide-home-');
  const root = overrides.root ?? tempDir('ide-root-');
  const store = overrides.store ?? openStore(projectDir(home, root));
  const recordFile = join(home, `record-${randomUUID()}.jsonl`);
  const claude = fakeClaude(scenario, recordFile);
  const session = new AgentSession({ root, home, store, claude: { ...claude, env: { ...claude.env, ...fakeEnv } }, ...overrides });
  const broadcasts: SessionServerMessage[] = [];
  session.onMessage((message) => broadcasts.push(message));
  onTestFinished(async () => {
    await session.close();
    if (!overrides.store) store.close();
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
    id: 'session-1', claudeSessionId: seed.claudeSessionId, cwd: root, status: 'running', model: null, modelChoice: null, effort: null, cliVersion: null,
    pid: seed.pid, launchId: seed.claudeSessionId, conversationStarted: true, startedAt: 1, accountId: null,
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
  it('spawns claude in stream-json mode with a per-session MCP config, the disallowed tools, bypass permissions and prompts on stdio', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    const [argv] = await waitFor(() => h.argvs().length === 1 && h.argvs(), 'claude spawned');
    const session = h.session.state().session;
    expect(argv).toEqual([
      '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
      '--session-id', session?.claudeSessionId,
      '--model', 'sonnet', '--effort', 'medium',
      '--mcp-config', join(runDir(h.home), `${basename(projectDir(h.home, h.root))}-${session?.id}.mcp.json`),
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

  it('writes images as base64 blocks before the text block of one user message', async () => {
    const h = await harness('multi-turn');
    h.session.send('what is this?', { images: [{ mediaType: 'image/png', data: 'AAEC' }, { mediaType: 'image/webp', data: 'Zm9v' }] });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.stdin()).toEqual([{
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAEC' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'Zm9v' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    }]);
  });

  it('allows a message of images only and writes no text block', async () => {
    const h = await harness('multi-turn');
    h.session.send('', { images: [{ mediaType: 'image/jpeg', data: 'AAEC' }] });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.stdin()).toEqual([{
      type: 'user',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAEC' } }] },
    }]);
  });

  it('shows the image count in the user turn', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi', { images: [{ mediaType: 'image/png', data: 'AAEC' }, { mediaType: 'image/png', data: 'AAEC' }] });
    expect(texts(h.session.state().items)[0]).toBe('hi\n[2 images attached]');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
  });

  it('refuses a blank message without images as empty and an empty image list too', async () => {
    const h = await harness('multi-turn');
    expect(() => h.session.send('  ')).toThrow(new SessionError('empty'));
    expect(() => h.session.send('', { images: [] })).toThrow(new SessionError('empty'));
    expect(h.stdin()).toEqual([]);
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

  it('keeps the skills claude lists in its init', async () => {
    const h = await harness('skills-init');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.state().skills).toEqual(['repo-probe', 'superpowers:brainstorming']);
  });

  it('lists no skills when claude reports none', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.state().skills).toEqual([]);
  });

  it('sends clients the skills of an init in a session patch', async () => {
    const h = await harness('skills-init');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    const patched = h.broadcasts.flatMap((message) => (message.type === 'session.patch' && message.patch.skills ? [message.patch.skills] : []));
    expect(patched).toEqual([['repo-probe', 'superpowers:brainstorming']]);
  });

  it('forgets the skills on New session and sends the empty list in the snapshot', async () => {
    const h = await harness('skills-init');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.state().skills).toHaveLength(2);
    h.broadcasts.length = 0;
    await h.session.newSession();
    const snapshot = h.broadcasts.find((message) => message.type === 'session.snapshot');
    expect([h.session.state().skills, snapshot?.type === 'session.snapshot' ? snapshot.state.skills : null]).toEqual([[], []]);
  });

  it('lists the skills again once the next claude after New session reports them', async () => {
    const h = await harness('skills-init');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    await h.session.newSession();
    h.session.send('hello again');
    await waitFor(() => closedTurns(h).length === 1 && h.session.state().skills.length === 2, 'skills reported by the second claude');
    expect(h.session.state().skills).toEqual(['repo-probe', 'superpowers:brainstorming']);
  });

  it('sends clients a snapshot for a new session and then the chat items as patches', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    const [first, ...rest] = h.broadcasts;
    const patchedItems = rest.flatMap((message) => (message.type === 'session.patch' ? (message.patch.items ?? []) : []));
    expect([first?.type, texts(patchedItems)]).toEqual(['session.snapshot', ['hi', 'OK']]);
  });

  it('delivers a message sent while a turn is open into that turn, without opening another', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    h.session.send('again');
    expect(texts(h.session.state().items)).toEqual(['run it', 'again']);
    expect(h.session.state().turns).toHaveLength(1);
    await waitFor(() => JSON.stringify(h.stdin()).includes('again'), 'the second message written to claude');
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

  it('tells interrupt listeners once when stop or interrupt sends the interrupt, and not when it does not', async () => {
    const h = await harness('interrupt-bash');
    const heard = vi.fn();
    h.session.onInterrupt(heard);
    expect(h.session.interrupt()).toBe(false);
    h.session.send('run it');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool'), 'tool call started');
    expect(h.session.interrupt()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    h.session.send('again');
    await waitFor(() => closedTurns(h).length === 2, 'second turn closed');
    expect(h.session.stop()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reports whether its process is alive', async () => {
    const h = await harness('multi-turn');
    expect(h.session.processAlive()).toBe(false);
    h.session.send('hi');
    expect(h.session.processAlive()).toBe(true);
    await h.session.close();
    expect(h.session.processAlive()).toBe(false);
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
    expect(isAlive(unrelated.pid ?? -1)).toBe(true);
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
    expect(h.session.state()).toEqual({ session: null, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE });
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

  it('logs and still tells the exit, tool-end and idle listeners when a message listener throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const h = await harness('crash-mid-turn');
    let armed = false;
    const ended: string[] = [];
    let idles = 0;
    let exits = 0;
    h.session.onMessage((message) => {
      if (armed && message.type === 'session.patch') throw new Error('boom');
    });
    h.session.onToolResult((info) => ended.push(info.toolUseId));
    h.session.onIdle(() => {
      idles += 1;
    });
    h.session.onProcessExit(() => {
      exits += 1;
    });
    h.session.send('go');
    armed = true;
    const handled = () => exits === 1 || errors.mock.calls.some(([line]) => line === 'agent: could not process claude exit');
    await waitFor(handled, 'claude exit handled');
    expect([exits, ended, idles, h.session.state().session?.status]).toEqual([1, ['toolu_fx_crash'], 1, 'crashed']);
    expect(errors).toHaveBeenCalledWith('agent: a session listener threw', expect.any(Error));
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

const COMPONENTS = [{ id: 'auth', name: 'Auth' }];
const gateBase = (home: string, root: string, sessionId: string) => `${basename(projectDir(home, root))}-${sessionId}`;
const gateFiles = (home: string, root: string, sessionId: string | null) => {
  const base = join(runDir(home), gateBase(home, root, sessionId ?? 'none'));
  return [`${base}.settings.json`, `${base}.hook.json`];
};

function realGate(home: string, root: string): SessionGate {
  return {
    write: (sessionId) => ({
      settingsPath: writeGateFiles(runDir(home), gateBase(home, root, sessionId), { url: 'http://127.0.0.1:1/hook', secret: 'test-secret' }).settingsPath,
    }),
    remove: (sessionId) => removeGateFiles(runDir(home), gateBase(home, root, sessionId)),
    systemPrompt: () => systemPrompt(COMPONENTS),
  };
}

async function gatedHarness(scenario: string, overrides: Partial<AgentSessionOptions> = {}): Promise<Harness> {
  const home = overrides.home ?? tempDir('ide-home-');
  const root = overrides.root ?? tempDir('ide-root-');
  return harness(scenario, { home, root, gate: realGate(home, root), ...overrides });
}

const decision = (toolUseId: string) => ({
  toolUseId, decision: 'allow' as const, planId: 'plan-1', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'], reason: 'IDE: allowed', decidedAt: 1,
});

describe('AgentSession with the gate', () => {
  it('passes the hook settings, the IDE system prompt and a fresh system prompt before the permission flags, on the first spawn and on resume', async () => {
    const h = await gatedHarness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'first turn closed');
    await h.session.restart();
    h.session.send('again');
    const [first, resumed] = await waitFor(() => h.argvs().length === 2 && h.argvs(), 'claude resumed');
    const files = gateFiles(h.home, h.root, h.session.sessionId());
    const tail = (argv: string[] | undefined) => argv?.slice(argv.indexOf('--disallowedTools') + 2);
    const expected = [
      '--settings', files[0], '--append-system-prompt', systemPrompt(COMPONENTS), '--system-prompt-snapshot', 'off',
      '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    ];
    expect([flag(resumed, '--resume'), tail(first), tail(resumed)]).toEqual([flag(first, '--session-id'), expected, expected]);
    expect(files.map((file) => existsSync(file))).toEqual([true, true]);
  });

  it('does not start claude when the hook settings cannot be written, and says why', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const home = tempDir('ide-home-');
    writeFileSync(runDir(home), 'not a directory');
    const h = await gatedHarness('multi-turn', { home });
    expect(() => h.session.send('hi')).toThrow(new SessionError('no-gate').message);
    const { session, turns, items } = h.session.state();
    expect([session?.status, turns, items.length]).toEqual(['stopped', [], 1]);
    expect(texts(items)[0]).toMatch(/^The IDE could not write the hook settings for claude \(.+\), so the agent was not started\.$/);
    expect(texts(items)[0]).toContain(runDir(home));
  });

  it('still shows an AskUserQuestion prompt and answers it when the IDE hook is active (spike c39)', async () => {
    const h = await gatedHarness('ask-user-question');
    h.session.send('ask me');
    const prompt = await pendingPrompt(h);
    h.session.answerPrompt(prompt.id, { kind: 'answers', answers: { 'Which color?': 'Blue', 'Which sizes?': 'S' } });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect([prompt, controlResponse(h)?.response]).toMatchObject([{ body: { tool: 'AskUserQuestion' } },{ subtype: 'success', request_id: 'req_fx_ask' }]);
  });

  it('removes the gate files of the session when claude exits', async () => {
    const h = await gatedHarness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    const files = gateFiles(h.home, h.root, h.session.sessionId());
    const whileRunning = files.map((file) => existsSync(file));
    await h.session.restart();
    expect([whileRunning, files.map((file) => existsSync(file))]).toEqual([[true, true], [false, false]]);
  });

  it("deletes a stale session's gate files at core start", async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    seedRunningSession(home, root, { claudeSessionId: randomUUID(), pid: await deadPid() });
    realGate(home, root).write('session-1');
    const files = gateFiles(home, root, 'session-1');

    await gatedHarness('multi-turn', { home, root });

    expect(files.map((file) => existsSync(file))).toEqual([false, false]);
  });

  it('shows a decision that arrives before its tool call on the chat row when the call appears', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    h.session.recordDecision(decision('toolu_fx_bash'));
    const item = await waitFor(() => h.session.state().items.find((candidate) => candidate.kind === 'tool'), 'tool row');
    expect(item).toMatchObject({ decision: 'allow', targets: ['src/app.ts'] });
  });

  it('adds a decision that arrives after its tool call to the chat row, and sends the row again', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    await waitFor(() => h.session.state().items.some((candidate) => candidate.kind === 'tool'), 'tool row');
    h.session.recordDecision({ ...decision('toolu_fx_bash'), decision: 'ask-approved' });
    const patched = h.broadcasts.flatMap((message) => (message.type === 'session.patch' ? (message.patch.items ?? []) : []));
    const row = h.session.state().items.find((candidate) => candidate.id === 'toolu_fx_bash');
    expect([patched.at(-1), row]).toMatchObject([
      { id: 'toolu_fx_bash', decision: 'ask-approved', targets: ['src/app.ts'] },
      { id: 'toolu_fx_bash', decision: 'ask-approved', targets: ['src/app.ts'] },
    ]);
  });

  it('keeps the decisions of a session across a core restart', async () => {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    const first = await harness('explain-then-bash', { home, root });
    first.session.send('test it');
    await waitFor(() => closedTurns(first).length === 1, 'turn closed');
    first.session.recordDecision(decision('toolu_fx_tests'));
    await first.session.close();
    const second = await harness('explain-then-bash', { home, root, store: first.store });
    expect(second.session.state().items.find((item) => item.kind === 'tool')).toMatchObject({ decision: 'allow' });
  });

  it('gives the last assistant message before a tool call as its context, and the latest one for a call not seen yet', async () => {
    const h = await harness('explain-then-bash');
    h.session.send('test it');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect([h.session.context('toolu_fx_tests'), h.session.context('toolu_later')]).toEqual([
      { parentToolUseId: null, lastMessage: 'Running the tests first.' },
      { parentToolUseId: null, lastMessage: null },
    ]);
  });

  it("returns the open turn's latest assistant text as lastMessage, and null once the turn is closed", async () => {
    const h = await harness('text-then-wait');
    h.session.send('look');
    await waitFor(() => h.session.lastMessage() === 'Looking at it.', 'message of the open turn');
    h.session.stop();
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(h.session.lastMessage()).toBeNull();
  });

  it('reports null as the reason of a call in a turn where the agent wrote nothing, although an earlier turn has a message', async () => {
    const h = await harness('silent-tool-turn');
    h.session.send('one');
    await waitFor(() => closedTurns(h).length === 1, 'first turn closed');
    h.session.send('two');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool'), 'tool row');
    expect([h.session.context('toolu_fx_silent'), h.session.lastMessage()]).toEqual([{ parentToolUseId: null, lastMessage: null }, null]);
  });

  it('tells user-message listeners for every delivered message, including one sent mid-turn, and not for a refused one', async () => {
    const h = await harness('multi-turn');
    let messages = 0;
    const stop = h.session.onUserMessage(() => {
      messages += 1;
    });
    expect(() => h.session.send(' ')).toThrow(SessionError);
    expect(messages).toBe(0);
    h.session.send('hi');
    h.session.send('again');
    expect(messages).toBe(2);
    await waitFor(() => closedTurns(h).length >= 1, 'turn closed');
    stop();
    h.session.send('more');
    expect(messages).toBe(2);
  });

  it('is idle when no turn is open, and tells listeners once when it becomes idle again', async () => {
    const h = await harness('multi-turn');
    let signals = 0;
    h.session.onIdle(() => {
      signals += 1;
    });
    expect(h.session.isIdle()).toBe(true);
    h.session.send('hi');
    expect(h.session.isIdle()).toBe(false);
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect([h.session.isIdle(), signals]).toEqual([true, 1]);
  });

  it('is not idle while a background subagent runs after the turn closed', async () => {
    const h = await harness('async-subagent');
    const idleWhenATurnCloses: boolean[] = [];
    h.session.onMessage((message) => {
      if (message.type === 'session.patch' && message.patch.turns?.some((turn) => turn.closedAt !== null)) idleWhenATurnCloses.push(h.session.isIdle());
    });
    h.session.send('start a subagent');
    await waitFor(() => closedTurns(h).length === 2, 'agent-initiated turn closed');
    expect([idleWhenATurnCloses, h.session.isIdle()]).toEqual([[false, true], true]);
  });

  it('tells listeners when a tool call ends and when claude exits', async () => {
    const h = await harness('crash-mid-turn');
    const ended: string[] = [];
    let exits = 0;
    h.session.onToolResult((info) => ended.push(info.toolUseId));
    h.session.onProcessExit(() => {
      exits += 1;
    });
    h.session.send('go');
    await waitFor(() => exits === 1, 'claude exited');
    expect(ended).toEqual(['toolu_fx_crash']);
  });

  it('still ends the session and tells the other listeners when a tool-result, idle or exit listener throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const h = await harness('crash-mid-turn');
    let exits = 0;
    h.session.onToolResult(() => {
      throw new Error('tool-result listener');
    });
    h.session.onIdle(() => {
      throw new Error('idle listener');
    });
    h.session.onProcessExit(() => {
      throw new Error('exit listener');
    });
    h.session.onProcessExit(() => {
      exits += 1;
    });
    h.session.send('go');
    await waitFor(() => errors.mock.calls.length > 0, 'an error logged');
    expect([exits, h.session.state().session?.status, texts(h.session.state().items).at(-1)]).toEqual([
      1, 'crashed', 'claude stopped unexpectedly (exit code 1): fatal: simulated crash',
    ]);
  });
});

const SECRET = 'canary-secret';

async function canaryHarness(scenario: string, hooks: 'on' | 'off', canaryMs: number) {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const canary = new Canary();
  const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [aliveRoute({ secret: SECRET, canary })] });
  onTestFinished(() => server.close());
  const gate: SessionGate = {
    write: (sessionId) => ({
      settingsPath: writeGateFiles(runDir(home), gateBase(home, root, sessionId), { url: `http://127.0.0.1:${server.port}/hook`, secret: SECRET, sessionId }).settingsPath,
    }),
    remove: (sessionId) => removeGateFiles(runDir(home), gateBase(home, root, sessionId)),
    systemPrompt: () => systemPrompt(COMPONENTS),
    canary,
  };
  const h = await harness(scenario, { home, root, gate, canaryMs }, { FAKE_CLAUDE_HOOKS: hooks });
  const ping = () => fetch(`http://127.0.0.1:${server.port}/hook/alive`, {
    method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ sessionId: h.session.sessionId() }),
  });
  return { ...h, ping };
}

describe('AgentSession waiting for the session-start hook', () => {
  const userMessages = (h: Harness) => h.stdin().filter((message) => message.type === 'user');

  it('holds the first message until the session-start hook has reported', async () => {
    const h = await canaryHarness('multi-turn', 'off', 5000);
    h.session.send('hi');
    await waitFor(() => h.argvs().length === 1, 'claude started');
    expect([userMessages(h).length, h.session.state().session?.status]).toEqual([0, 'running']);
    expect((await h.ping()).status).toBe(204);
    await waitFor(() => userMessages(h).length === 1, 'message delivered');
    expect(userMessages(h)[0]).toMatchObject({ message: { content: 'hi' } });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
  });

  it('delivers images queued before the hook reported, in the same message', async () => {
    const h = await canaryHarness('multi-turn', 'off', 5000);
    h.session.send('look', { images: [{ mediaType: 'image/gif', data: 'R0lG' }] });
    await waitFor(() => h.argvs().length === 1, 'claude started');
    expect(userMessages(h)).toEqual([]);
    await h.ping();
    await waitFor(() => userMessages(h).length === 1, 'message delivered');
    expect(userMessages(h)[0]).toMatchObject({
      message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lG' } }, { type: 'text', text: 'look' }] },
    });
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
  });

  it('delivers the message at once when the real hook of the fake claude reports', async () => {
    const h = await canaryHarness('multi-turn', 'on', 5000);
    h.session.send('hi');
    await waitFor(() => userMessages(h).length === 1, 'message delivered');
  });

  it('refuses the session when the hook never reports, and writes nothing to claude', async () => {
    const h = await canaryHarness('multi-turn', 'off', 200);
    h.session.send('hi');
    await waitFor(() => h.session.state().session?.status === 'refused', 'session refused');
    expect(texts(h.session.state().items).some((text) => text.includes('hook did not start'))).toBe(true);
    expect(() => h.session.send('again')).toThrow(new SessionError('hook-off'));
    expect(userMessages(h)).toEqual([]);
  });

  it('starts again after restart, when the hook reports', async () => {
    const h = await canaryHarness('multi-turn', 'off', 5000);
    h.session.send('hi');
    await waitFor(() => h.session.state().session?.status === 'refused', 'session refused', 30_000);
    await h.session.restart();
    h.session.send('again');
    await waitFor(() => h.argvs().length === 2, 'claude started again', 30_000);
    await h.ping();
    await waitFor(() => userMessages(h).length === 1, 'message delivered', 30_000);
    expect(h.session.state().session?.status).toBe('running');
    expect(userMessages(h)[0]).toMatchObject({ message: { content: 'again' } });
  }, 60_000);
});

describe('AgentSession feeds for the watchdog', () => {
  const S = '$SESSION';
  const line = (o: object) => JSON.stringify(o);
  const backgroundShell = (kind = 'shell') => {
    const file = join(tempDir('ide-scenario-'), 'background-shell.jsonl');
    writeFileSync(file, [
      line({ fake: 'await-user' }),
      line({ type: 'system', subtype: 'init', cwd: '/fake/project', session_id: S, mcp_servers: [], model: 'm', permissionMode: 'bypassPermissions', claude_code_version: '2.1.281' }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sh', name: kind === 'monitor' ? 'Monitor' : 'Bash', input: { command: 'sleep 5', run_in_background: true } }] }, parent_tool_use_id: null, session_id: S }),
      line({ type: 'system', subtype: 'task_started', task_id: 'task_sh', tool_use_id: 'toolu_sh', description: 'sleep 5', is_backgrounded: true, task_type: kind === 'monitor' ? 'monitor' : 'local_bash', session_id: S }),
      line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_sh', type: 'tool_result', content: 'started' }] }, parent_tool_use_id: null, session_id: S }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: S }),
      line({ fake: 'sleep', ms: 20 }),
      line({ type: 'system', subtype: 'task_updated', task_id: 'task_sh', patch: { status: 'completed' }, session_id: S }),
      line({ fake: 'await-user' }),
    ].join('\n'));
    return { FAKE_CLAUDE_SCENARIO: file };
  };

  it('reports every tool result with monotonic stamps, its status and its parent', async () => {
    const h = await harness('async-subagent');
    const ended: ToolEndInfo[] = [];
    h.session.onToolResult((info) => ended.push(info));
    const before = performance.now();
    h.session.send('start a subagent');
    await waitFor(() => ended.length === 2, 'both tool results');
    const after = performance.now();
    expect(ended.map((e) => [e.toolUseId, e.tool, e.parentToolUseId, e.status])).toEqual([
      ['toolu_fx_agent', 'Agent', null, 'ok'],
      ['toolu_fx_sub_write', 'Write', 'toolu_fx_agent', 'ok'],
    ]);
    for (const e of ended) {
      expect(e.toolUseAt).toBeGreaterThanOrEqual(before);
      expect(e.endedAt).toBeGreaterThanOrEqual(e.toolUseAt);
      expect(e.endedAt).toBeLessThanOrEqual(after);
    }
  });

  it('keeps the stored times of a tool call as dates', async () => {
    const h = await harness('async-subagent');
    h.session.send('start a subagent');
    await waitFor(() => h.store.history(h.session.sessionId() as string).toolEvents.some((t) => t.toolUseId === 'toolu_fx_sub_write' && t.endedAt !== null), 'stored');
    const stored = h.store.history(h.session.sessionId() as string).toolEvents;
    for (const t of stored) expect(Math.abs((t.toolUseAt as number) - Date.now())).toBeLessThan(60_000);
  });

  it('reports a call cut short by a crash as unfinished', async () => {
    const h = await harness('crash-mid-turn');
    const ended: ToolEndInfo[] = [];
    h.session.onToolResult((info) => ended.push(info));
    h.session.send('go');
    await waitFor(() => ended.length === 1, 'tool result');
    expect(ended[0]).toMatchObject({ toolUseId: 'toolu_fx_crash', status: 'unfinished' });
  });

  it('tells when a background task ends, once, with the tool call that started it, and counts running subagents', async () => {
    const h = await harness('async-subagent');
    const taskEnds: string[] = [];
    const running: number[] = [];
    h.session.onTaskEnd((toolUseId) => taskEnds.push(toolUseId));
    h.session.onMessage((message) => {
      if (message.type === 'session.patch' && message.patch.tasks) running.push(h.session.runningSubagents());
    });
    h.session.send('start a subagent');
    await waitFor(() => closedTurns(h).length === 2, 'agent-initiated turn closed');
    expect([taskEnds, running, h.session.runningSubagents()]).toEqual([['toolu_fx_agent'], [1, 0], 0]);
  });

  it('names the running subagents by their description', async () => {
    const h = await harness('async-subagent');
    const names: string[][] = [];
    h.session.onMessage((message) => {
      if (message.type === 'session.patch' && message.patch.tasks) names.push(h.session.runningSubagentNames());
    });
    h.session.send('start a subagent');
    await waitFor(() => closedTurns(h).length === 2, 'agent-initiated turn closed');
    expect(names).toEqual([['Create sub.txt with hello'], []]);
    expect(h.session.runningSubagents()).toBe(0);
  });

  it('tells when a turn closes, once per turn, and whether a turn is open', async () => {
    const h = await harness('async-subagent');
    const closed: boolean[] = [];
    h.session.onTurnClosed(() => closed.push(h.session.hasOpenTurn()));
    h.session.onTurnClosed(() => {
      throw new Error('listener failure');
    });
    const opened = h.session.hasOpenTurn();
    h.session.send('start a subagent');
    const during = h.session.hasOpenTurn();
    await waitFor(() => closedTurns(h).length === 2, 'agent-initiated turn closed');
    expect([opened, during, closed.length, h.session.hasOpenTurn()]).toEqual([false, true, 2, false]);
    expect(closed).toEqual([false, false]);
  });

  it('tells once when an interrupted turn ends with its result, and not when a crash closes the turn', async () => {
    const interrupted = await harness('interrupt-bash');
    const closed: string[] = [];
    interrupted.session.onTurnClosed(() => closed.push('interrupted'));
    interrupted.session.send('run it');
    await waitFor(() => interrupted.session.state().items.some((item) => item.kind === 'tool'), 'tool call started');
    interrupted.session.stop();
    await waitFor(() => closedTurns(interrupted).length === 1, 'turn closed');
    const crashed = await harness('crash-mid-turn');
    crashed.session.onTurnClosed(() => closed.push('crashed'));
    crashed.session.send('go');
    await waitFor(() => crashed.session.state().session?.status === 'crashed', 'session crashed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([closed, crashed.session.state().turns[0]?.resultSubtype]).toEqual([['interrupted'], 'crashed']);
  });

  it('counts running background shell calls', async () => {
    const h = await harness('async-subagent', {}, backgroundShell());
    const shell: boolean[] = [];
    const taskEnds: string[] = [];
    h.session.onTaskEnd((toolUseId) => taskEnds.push(toolUseId));
    h.session.onMessage((message) => {
      if (message.type === 'session.patch' && message.patch.tasks) shell.push(h.session.runningShell());
    });
    h.session.send('start a shell');
    await waitFor(() => taskEnds.length === 1, 'shell task ended');
    expect([shell, taskEnds, h.session.runningShell(), h.session.runningSubagents()]).toEqual([[true, false], ['toolu_sh'], false, 0]);
  });

  it('counts a running Monitor as a shell too', async () => {
    const h = await harness('async-subagent', {}, backgroundShell('monitor'));
    const shell: boolean[] = [];
    h.session.onMessage((message) => {
      if (message.type === 'session.patch' && message.patch.tasks) shell.push(h.session.runningShell());
    });
    h.session.send('start a monitor');
    await waitFor(() => shell.length === 2, 'monitor task ended');
    expect([shell, h.session.runningShell()]).toEqual([[true, false], false]);
  });

  it('stops telling a listener that unsubscribed, and tells the others when one throws', async () => {
    const h = await harness('async-subagent');
    const seen: string[] = [];
    const off = h.session.onToolResult(() => seen.push('off'));
    h.session.onToolResult(() => {
      throw new Error('listener boom');
    });
    h.session.onToolResult((info) => seen.push(info.toolUseId));
    off();
    h.session.send('start a subagent');
    await waitFor(() => seen.length === 2, 'results delivered');
    expect(seen).toEqual(['toolu_fx_agent', 'toolu_fx_sub_write']);
  });
});

describe('AgentSession notes from the watchdog', () => {
  const userWrites = (h: Harness) => h.stdin().filter((message) => message.type === 'user');

  it('prepends a queued note to the next user message and shows it as a notice, with the message text unchanged', async () => {
    const h = await harness('multi-turn');
    h.session.queueNote('[IDE] The user kept a.ts.');
    h.session.send('continue please');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(userWrites(h)).toEqual([{ type: 'user', message: { role: 'user', content: '[IDE] The user kept a.ts.\n\ncontinue please' } }]);
    const items = h.session.state().items;
    expect(items.find((item) => item.kind === 'message' && item.role === 'user')).toMatchObject({ text: 'continue please' });
    expect(items.find((item) => item.kind === 'notice')).toMatchObject({ text: '[IDE] The user kept a.ts.' });
    h.session.send('and once more');
    await waitFor(() => closedTurns(h).length === 2, 'second turn closed');
    expect(userWrites(h)[1]).toMatchObject({ message: { content: 'and once more' } });
  });

  it('keeps the queued notes when writing the message to claude fails', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    h.session.queueNote('[IDE] note');
    const child = (h.session as unknown as { process: { write: (m: object) => void } }).process;
    const write = child.write.bind(child);
    child.write = () => { throw new Error('pipe closed'); };
    expect(() => h.session.send('again')).toThrow('pipe closed');
    child.write = write;
    h.session.send('again');
    await waitFor(() => closedTurns(h).length === 2, 'second turn closed');
    expect(userWrites(h)[1]).toMatchObject({ message: { content: '[IDE] note\n\nagain' } });
  });

  it('writes an absorbed note into the open turn without opening a turn of its own', async () => {
    const h = await harness('interrupt-bash');
    h.session.send('run it');
    await waitFor(() => userWrites(h).length === 1, 'first message delivered');
    const turnsBefore = h.session.state().turns.length;
    h.session.sendAbsorbed('[IDE] note');
    await waitFor(() => userWrites(h).length === 2, 'note delivered');
    expect(userWrites(h)[1]).toEqual({ type: 'user', message: { role: 'user', content: '[IDE] note' } });
    const state = h.session.state();
    expect(state.turns).toHaveLength(turnsBefore);
    expect(state.items.filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(1);
    expect(state.items.find((item) => item.kind === 'notice')).toMatchObject({ text: 'IDE note sent to the agent' });
  });

  it('refuses an absorbed note when there is no process or no open turn', async () => {
    const h = await harness('multi-turn');
    expect(() => h.session.sendAbsorbed('[IDE] note')).toThrow(SessionError);
    h.session.send('hi');
    await waitFor(() => closedTurns(h).length === 1, 'turn closed');
    expect(() => h.session.sendAbsorbed('[IDE] note')).toThrow(SessionError);
    expect(userWrites(h)).toHaveLength(1);
  });

  it('holds an absorbed note behind the session-start hook like the first message', async () => {
    const h = await canaryHarness('interrupt-bash', 'off', 5000);
    h.session.send('run it');
    await waitFor(() => h.argvs().length === 1, 'claude started');
    h.session.sendAbsorbed('[IDE] note');
    expect(userWrites(h)).toEqual([]);
    await h.ping();
    await waitFor(() => userWrites(h).length === 2, 'both delivered');
    expect(userWrites(h).map((m) => (m.message as { content: string }).content)).toEqual(['run it', '[IDE] note']);
  });
});

describe('AgentSession after a core crash', () => {
  const T = (iso: string): number => Date.parse(iso);

  function crashedSession(o: { status?: 'running' | 'stopped'; transcript?: string | null; unparsable?: boolean; body?: (id: string, root: string) => string; storedTool?: 'running' | 'unfinished' } = {}) {
    const home = tempDir('ide-home-');
    const root = tempDir('ide-root-');
    const transcriptsDir = tempDir('ide-transcripts-');
    const claudeSessionId = randomUUID();
    const store = openStore(projectDir(home, root));
    store.saveSession({
      id: 'session-1', claudeSessionId, cwd: root, status: o.status ?? 'running', model: null, modelChoice: null, effort: null, cliVersion: null,
      pid: null, launchId: null, conversationStarted: true, startedAt: 1, accountId: null,
    });
    store.saveTurn('session-1', { id: 'turn-1', kind: 'user', openedAt: 2, startedAt: 3, closedAt: null, resultSubtype: null });
    store.saveMessage('session-1', { id: 'm1', seq: 1, turnId: 'turn-1', parentToolUseId: null, role: 'assistant', text: 'I will write the config.', ts: T('2026-09-30T12:00:02.000Z') });
    store.saveToolEvent('session-1', {
      toolUseId: 'toolu_gap_a', seq: 2, turnId: 'turn-1', parentToolUseId: null, tool: 'Write', input: { file_path: join(root, 'config.json') },
      status: 'ok', toolUseAt: T('2026-09-30T12:00:03.000Z'), endedAt: T('2026-09-30T12:00:04.000Z'),
    });
    if (o.storedTool) {
      store.saveToolEvent('session-1', {
        toolUseId: 'toolu_open', seq: 3, turnId: 'turn-1', parentToolUseId: null, tool: 'Bash', input: { command: 'npm test' },
        status: o.storedTool, toolUseAt: T('2026-09-30T12:00:05.000Z'), endedAt: o.storedTool === 'running' ? null : T('2026-09-30T12:00:05.500Z'),
      });
    }
    if (o.transcript !== null) {
      const dir = join(transcriptsDir, realpathSync(root).replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const body = o.body ? o.body(claudeSessionId, root) : o.unparsable
        ? 'torn\nalso torn\n'
        : readFileSync(fixture('transcripts/crash-gap.jsonl'), 'utf8').replaceAll('$SESSION', claudeSessionId).replaceAll('$CWD', root);
      writeFileSync(join(dir, `${claudeSessionId}.jsonl`), body);
    }
    store.close();
    return { home, root, transcriptsDir, claudeSessionId };
  }

  const GAP = [
    'I will write the config.', 'Write:ok', 'Now the tests.', 'Bash:ok', 'Write:error', 'The report could not be written.', 'Read:unfinished',
  ];

  it('reports that it started from a crash only when the last session was running', async () => {
    const crashed = crashedSession({ transcript: null });
    const a = await harness('multi-turn', { home: crashed.home, root: crashed.root, transcriptsDir: crashed.transcriptsDir });
    expect(a.session.startedFromCrash()).toBe(true);
    const clean = crashedSession({ status: 'stopped', transcript: null });
    const b = await harness('multi-turn', { home: clean.home, root: clean.root, transcriptsDir: clean.transcriptsDir });
    expect(b.session.startedFromCrash()).toBe(false);
    const fresh = await harness('multi-turn');
    expect(fresh.session.startedFromCrash()).toBe(false);
  });

  it('adds the calls made in the gap after the last stored row, marked recovered, without duplicating a stored call', async () => {
    const c = crashedSession();
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    const items = h.session.state().items;
    expect(texts(items)).toEqual(GAP);
    expect(items.map((item) => item.kind !== 'notice' && item.kind !== 'prompt' && item.recovered === true)).toEqual([false, false, true, true, true, true, true]);
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(items.filter((item) => item.kind === 'tool').map((item) => item.id)).toEqual(['toolu_gap_a', 'toolu_gap_b', 'toolu_gap_c', 'toolu_gap_d']);
  });

  it('adds them once: a second start of the same store adds nothing', async () => {
    const c = crashedSession();
    const first = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    await first.session.close();
    const reopened = openStore(projectDir(c.home, c.root));
    reopened.saveSession({ ...reopened.latestSession()!, status: 'running' });
    reopened.close();
    const second = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(second.session.startedFromCrash()).toBe(true);
    expect(texts(second.session.state().items)).toEqual(GAP);
  });

  it('adds nothing after a clean stop', async () => {
    const c = crashedSession({ status: 'stopped' });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(texts(h.session.state().items)).toEqual(['I will write the config.', 'Write:ok']);
  });

  it('adds one notice when the transcript is missing', async () => {
    const c = crashedSession({ transcript: null });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(texts(h.session.state().items)).toEqual([
      'I will write the config.', 'Write:ok', "Calls made while the core was down may be missing; claude's transcript could not be read.",
    ]);
  });

  it('adds one notice when the transcript cannot be parsed', async () => {
    const c = crashedSession({ unparsable: true });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(h.session.state().items.filter((item) => item.kind === 'notice')).toHaveLength(1);
    expect(texts(h.session.state().items)).toHaveLength(3);
  });

  describe('unclean-stop marker and transcript merging', () => {
  const assistant = (uuid: string, at: string, block: object): string =>
    JSON.stringify({ type: 'assistant', uuid, timestamp: at, message: { role: 'assistant', content: [block] } });
  const result = (uuid: string, at: string, id: string, isError = false): string =>
    JSON.stringify({ type: 'user', uuid, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] } });

  it('keeps reporting a crash until the recovery cleared the marker', async () => {
    const c = crashedSession({ transcript: null });
    const first = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(first.session.startedFromCrash()).toBe(true);
    await first.session.close();
    const second = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(second.session.state().session?.status).toBe('crashed');
    expect(second.session.startedFromCrash()).toBe(true);
    await second.session.close();
    const store = openStore(projectDir(c.home, c.root));
    store.setMeta(UNCLEAN_STOP_KEY, '');
    store.close();
    const third = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(third.session.startedFromCrash()).toBe(false);
  });

  it('never sets the marker after a clean stop', async () => {
    const c = crashedSession({ status: 'stopped', transcript: null });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(h.session.startedFromCrash()).toBe(false);
    expect(h.store.meta(UNCLEAN_STOP_KEY)).toBeNull();
  });

  it('does not drop a legitimately repeated short text', async () => {
    const c = crashedSession({
      body: () => [
        assistant('x1', '2026-09-30T12:00:02.000Z', { type: 'text', text: 'I will write the config.' }),
        assistant('x2', '2026-09-30T12:00:06.000Z', { type: 'text', text: 'I will write the config.' }),
      ].join('\n'),
    });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    expect(texts(h.session.state().items)).toEqual(['I will write the config.', 'Write:ok', 'I will write the config.']);
  });

  it('leaves a stored finished call as it is when the transcript shows it again a moment later', async () => {
    const c = crashedSession({
      body: () => [
        assistant('z1', '2026-09-30T12:00:06.000Z', { type: 'tool_use', id: 'toolu_gap_a', name: 'Write', input: {} }),
        result('z2', '2026-09-30T12:00:07.000Z', 'toolu_gap_a', true),
      ].join('\n'),
    });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    const tools = h.session.state().items.filter((item) => item.kind === 'tool');
    expect(tools.map((t) => [t.id, t.status, t.seq, t.recovered])).toEqual([['toolu_gap_a', 'ok', 2, undefined]]);
  });

  it.each(['running', 'unfinished'] as const)('updates a stored %s call whose result arrived in the gap, without a second row', async (storedTool) => {
    const c = crashedSession({
      storedTool,
      body: () => [
        assistant('y1', '2026-09-30T12:00:05.000Z', { type: 'tool_use', id: 'toolu_open', name: 'Bash', input: { command: 'npm test' } }),
        result('y2', '2026-09-30T12:00:08.000Z', 'toolu_open', true),
      ].join('\n'),
    });
    const h = await harness('multi-turn', { home: c.home, root: c.root, transcriptsDir: c.transcriptsDir });
    const tools = h.session.state().items.filter((item) => item.kind === 'tool');
    expect(tools.map((t) => [t.id, t.status, t.seq])).toEqual([['toolu_gap_a', 'ok', 2], ['toolu_open', 'error', 3]]);
    expect(tools[1]).toMatchObject({ endedAt: Date.parse('2026-09-30T12:00:08.000Z') });
  });
});
});
