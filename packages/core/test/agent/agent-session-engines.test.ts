import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { EngineId } from '@ide/protocol';
import { AccountStore } from '../../src/accounts/account-store';
import { AgentSession, type AgentSessionOptions, type SessionGate } from '../../src/agent/agent-session';
import type { ClaudeCommand } from '../../src/agent/claude-process';
import type { CodexCommand } from '../../src/agent/codex/command';
import { claudeEngine } from '../../src/agent/engines/claude';
import { codexEngine } from '../../src/agent/engines/codex';
import { EngineRegistry, type Engine } from '../../src/agent/engines/registry';
import type { Launch } from '../../src/agent/transport';
import { projectDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type Store } from '../../src/store/store';
import { transcriptPath } from '../../src/watchdog/recovery';
import { argValue, fakeClaude } from '../fake-claude/fake';
import { codexRecords, fakeCodex, type CodexRecord } from '../fake-codex/fake';
import { sessionRecord, SONNET, tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  started: Launch[];
  codexRecords: () => CodexRecord[];
}

// Each engine runs on its own fake; every start is recorded with the engine's launch.
function registry(claude: ClaudeCommand, codex: CodexCommand, started: Launch[], ids: EngineId[]): EngineRegistry {
  const engines: Record<string, Engine> = {
    claude: claudeEngine({ command: () => claude, cwd: '/' }),
    codex: codexEngine({ command: () => codex, cwd: '/', signedOut: () => 'Sign in.' }),
  };
  return new EngineRegistry(ids.map((id): Engine => {
    const engine = engines[id]!;
    return { ...engine, start: (launch, sink) => { started.push(launch); return engine.start(launch, sink); } };
  }));
}

async function harness(options: {
  engines?: EngineId[]; seed?: (store: Store, root: string, transcriptsDir: string) => void; overrides?: Partial<AgentSessionOptions>;
  claudeScenario?: string; codexScenario?: string; codexEnv?: Record<string, string>;
} = {}): Promise<Harness> {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const transcriptsDir = tempDir('ide-transcripts-');
  const store = openStore(projectDir(home, root));
  onTestFinished(() => store.close());
  options.seed?.(store, root, transcriptsDir);
  const claude = fakeClaude(options.claudeScenario ?? 'multi-turn', join(home, `record-${randomUUID()}.jsonl`));
  const codexRecord = join(home, `codex-${randomUUID()}.jsonl`);
  const codex = fakeCodex(options.codexScenario ?? 'multi-turn', codexRecord, options.codexEnv);
  const started: Launch[] = [];
  const session = new AgentSession({
    root, home, store, claude, codex, transcriptsDir, engines: registry(claude, codex, started, options.engines ?? ['claude', 'codex']), defaultModel: SONNET, ...options.overrides,
  });
  onTestFinished(() => session.close());
  await session.start();
  return { session, store, started, codexRecords: () => codexRecords(codexRecord) };
}

// A Codex chat whose core was killed mid-turn: still marked running, with a message, and a Claude transcript beside it.
function crashedCodexChat(store: Store, root: string, transcriptsDir: string): void {
  store.saveSession({ ...sessionRecord('codex-chat', root), engine: 'codex', modelChoice: 'codex:gpt-6-luna' });
  store.saveMessage('codex-chat', { id: 'm1', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'hi', ts: 1 });
  const transcript = transcriptPath(transcriptsDir, root, 'claude-codex-chat');
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T12:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'from the transcript' }] } })}\n`);
}

describe('AgentSession on an engine other than Claude', () => {
  it('reads no Claude transcript after a crash when the engine keeps none, and says calls may be missing', async () => {
    const h = await harness({ seed: crashedCodexChat });
    const state = h.session.state();
    expect([state.items.map((item) => (item.kind === 'notice' ? `notice: ${item.text}` : item.kind === 'message' ? item.text : item.kind)), state.session?.status]).toEqual([
      ['hi', 'notice: Calls made while the core was down may be missing.'], 'crashed',
    ]);
  });

  it('refuses the terminal view for an engine that has none, and leaves its running agent alone', async () => {
    const h = await harness();
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: null });
    const pid = await waitFor(() => h.session.state().session?.status === 'running' && h.store.session(h.session.sessionId() ?? '')?.pid, "the chat's agent started");
    await expect(h.session.terminalLaunch()).rejects.toMatchObject({ code: 'no-terminal', message: 'This engine has no terminal view.' });
    expect([h.session.state().session?.status, isAlive(pid), h.started.map((launch) => launch.engine)]).toEqual(['running', true, ['codex']]);
  });

  it('refuses a chat of an engine CodeRay knows but has not registered, and starts no agent for it', async () => {
    const h = await harness({ engines: ['claude'], seed: crashedCodexChat });
    expect(() => h.session.send('again')).toThrow('That model needs an engine CodeRay does not have.');
    expect(h.started).toEqual([]);
  });

  it("keeps a chat of an engine this CodeRay does not know and never runs it, so claude never resumes that engine's conversation", async () => {
    const h = await harness({ seed: foreignChat });
    expect(() => h.session.send('again')).toThrow('This chat runs on gemini, which this CodeRay does not have.');
    await expect(h.session.terminalLaunch()).rejects.toMatchObject({ code: 'no-engine' });
    expect([h.started, h.store.session('gemini-chat')]).toMatchObject([[], { foreignEngine: 'gemini', status: 'crashed' }]);
    expect(h.session.state().items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []))).toEqual(['Calls made while the core was down may be missing.']);
  });
});

// A chat a later CodeRay wrote, on an engine this one does not know; its core stopped while it ran.
function foreignChat(store: Store, root: string): void {
  store.saveSession({ ...sessionRecord('gemini-chat', root), foreignEngine: 'gemini', modelChoice: 'gemini:pro' });
  store.saveMessage('gemini-chat', { id: 'm1', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'hi', ts: 1 });
}

// The same chat before its first message, left by a New chat.
function unusedForeignChat(store: Store, root: string): void {
  store.saveSession({ ...sessionRecord('gemini-chat', root), foreignEngine: 'gemini', modelChoice: 'gemini:pro', status: 'ended', conversationStarted: false });
}

// A chat whose first message went out but whose agent never answered: in use, though no conversation started.
function unansweredChat(store: Store, root: string): void {
  store.saveSession({ ...sessionRecord('unanswered', root), modelChoice: 'sonnet', status: 'stopped', conversationStarted: false });
  store.saveMessage('unanswered', { id: 'm1', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'hi', ts: 1 });
}

const turnClosed = (h: Harness) => waitFor(() => h.session.state().turns.some((turn) => turn.closedAt !== null), 'turn closed');

describe('the model decides the engine', () => {
  it("replaces a new chat's unstarted agent when a model of another engine is chosen before the first message, on the same effort too", async () => {
    const h = await harness();
    await h.session.newSession();
    const claudePid = await waitFor(() => h.started.length === 1 && h.store.session(h.session.sessionId() ?? '')?.pid, "the new chat's agent started");
    await h.session.configure('codex:gpt-6-luna', 'medium');
    await waitFor(() => h.started.length === 2, 'the agent started again');
    expect([h.started.map((launch) => launch.engine), h.session.state().session, h.store.session(h.session.sessionId() ?? '')?.engine, isAlive(claudePid)]).toMatchObject([
      ['claude', 'codex'], { engine: 'codex', modelChoice: 'codex:gpt-6-luna', effort: 'medium', status: 'running' }, 'codex', false,
    ]);
  });

  it('refuses a model of another engine once the chat has a message, though its agent never answered, with engine-locked, and keeps the chat as it was', async () => {
    const h = await harness({ seed: unansweredChat });
    await expect(h.session.configure('codex:gpt-6-luna', null)).rejects.toMatchObject({
      code: 'engine-locked', message: 'This chat runs on another engine. Start a new chat to use that model.',
    });
    expect([h.store.session('unanswered'), h.started]).toMatchObject([{ engine: 'claude', modelChoice: 'sonnet', conversationStarted: false }, []]);
  });

  it("refuses even a Claude model on a chat of an engine CodeRay does not know, before its first message too, and keeps the chat's own", async () => {
    const h = await harness({ seed: unusedForeignChat });
    await h.session.switchSession('gemini-chat');
    await expect(h.session.configure('opus', null)).rejects.toMatchObject({ code: 'engine-locked' });
    expect([h.store.session('gemini-chat'), h.started]).toMatchObject([{ foreignEngine: 'gemini', modelChoice: 'gemini:pro', effort: null }, []]);
  });

  it('refuses a model whose engine CodeRay does not run, and an effort its engine does not name', async () => {
    const h = await harness({ engines: ['claude'] });
    await expect(h.session.configure('opencode:opencode/nemotron-3.5-lightning-free', null)).rejects.toMatchObject({ code: 'no-engine' });
    await expect(h.session.configure('opus', 'minimal')).rejects.toMatchObject({ code: 'bad-effort' });
    expect(h.session.state().session).toBeNull();
  });

  it('starts a new chat on the chosen model when it belongs to another engine than the chat in use', async () => {
    const h = await harness();
    h.session.send('hi');
    await turnClosed(h);
    const first = h.session.sessionId();
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: null });
    await waitFor(() => h.started.length === 2, "the new chat's agent started");
    expect([h.session.sessionId() !== first, h.session.state().session?.engine, h.session.state().session?.modelChoice, h.started.at(-1)?.engine])
      .toEqual([true, 'codex', 'codex:gpt-6-luna', 'codex']);
  });
});

// A chat from before the model choice existed: no model, no effort, one message.
function oldChatWithoutModel(store: Store, root: string): void {
  store.saveSession({ ...sessionRecord('old-chat', root), status: 'stopped' });
  store.saveMessage('old-chat', { id: 'm-old', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'earlier', ts: 1 });
}

describe('the model of a new chat', () => {
  it('starts nothing on a project with no chat and no default model it can run until a model is chosen, then starts on that model', async () => {
    const unregistered = await harness({ engines: ['claude'], overrides: { defaultModel: { engine: 'codex', modelChoice: 'codex:gpt-6-luna', effort: null } } });
    expect([unregistered.session.nextPick(), unregistered.store.listSessions()]).toEqual([null, []]);
    const h = await harness({ overrides: { defaultModel: undefined } });
    expect(() => h.session.send('hi')).toThrow('Choose a model for this chat first.');
    await expect(h.session.configure(null, 'high')).rejects.toMatchObject({ code: 'no-model' });
    await expect(h.session.terminalLaunch()).rejects.toMatchObject({ code: 'no-model' });
    await h.session.newSession();
    expect([h.started, h.session.nextPick(), h.session.state().session, h.store.listSessions()]).toEqual([[], null, null, []]);
    await h.session.configure('opus', 'high');
    expect([h.started, h.session.nextPick()]).toEqual([[], { engine: 'claude', modelChoice: 'opus', effort: 'high' }]);
    h.session.send('hi');
    await waitFor(() => h.started.length === 1, "the chat's agent started");
    expect([h.started[0]?.model, h.started[0]?.effort]).toEqual(['opus', 'high']);
  });

  it("resumes an old chat that names no model on claude's own defaults, and starts the chat after it on sonnet and medium", async () => {
    const h = await harness({ overrides: { defaultModel: undefined }, seed: oldChatWithoutModel });
    h.session.send('again');
    await turnClosed(h);
    await h.session.newSession();
    await waitFor(() => h.started.length === 2, "the new chat's agent started");
    expect(h.started.map((launch) => [launch.engine, launch.model, launch.effort])).toEqual([['claude', null, null], ['claude', 'sonnet', 'medium']]);
  });

  it('opens a new chat on the model it is given at once, also on a project with no chat, and its terminal view on that model too', async () => {
    const h = await harness({ overrides: { defaultModel: undefined } });
    await h.session.newSession({ modelChoice: 'opus', effort: 'high' });
    await waitFor(() => h.started.length === 1, "the new chat's agent started");
    const terminal = await h.session.terminalLaunch();
    expect([h.started[0]?.model, h.started[0]?.effort, argValue(terminal?.args, '--model'), argValue(terminal?.args, '--effort')]).toEqual(['opus', 'high', 'opus', 'high']);
  });

  it('starts the chat after one of an engine CodeRay has not registered on the default model', async () => {
    const h = await harness({ engines: ['claude'], seed: crashedCodexChat });
    await h.session.newSession();
    await waitFor(() => h.started.length === 1, "the new chat's agent started");
    expect(h.started.map((launch) => [launch.engine, launch.model, launch.effort])).toEqual([['claude', 'sonnet', 'medium']]);
  });

  it('opens a fresh chat on the default model instead of reusing an unused chat of an engine this CodeRay does not know, or inheriting from it, and keeps that chat', async () => {
    const h = await harness({ seed: unusedForeignChat });
    await h.session.switchSession('gemini-chat');
    await h.session.newSession();
    await waitFor(() => h.started.length === 1, "the new chat's agent started");
    expect([h.started.map((launch) => [launch.engine, launch.model, launch.effort]), h.session.sessionId() === 'gemini-chat', h.store.session('gemini-chat')]).toMatchObject([
      [['claude', 'sonnet', 'medium']], false, { foreignEngine: 'gemini', modelChoice: 'gemini:pro' },
    ]);
  });
});

// A Codex account of CodeRay's, signed in and active.
function signedInCodexAccount(): { codexAccounts: AccountStore; id: string } {
  const codexAccounts = new AccountStore({ home: tempDir('ide-codex-accounts-'), engine: 'codex', logout: async () => {} });
  const id = randomUUID();
  codexAccounts.add({ id, email: 'work@example.com', plan: 'Plus', createdAt: 1 });
  codexAccounts.createDir(id);
  codexAccounts.setActive(id);
  writeFileSync(join(codexAccounts.homeDir(id)!, 'auth.json'), JSON.stringify({ type: 'chatgpt', email: 'work@example.com', planType: 'plus' }));
  return { codexAccounts, id };
}

const notices = (h: Harness): string[] => h.session.state().items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []));

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('AgentSession on Codex', () => {
  const allowAll: SessionGate = {
    write: () => ({ settingsPath: '/dev/null' }), remove: () => {}, systemPrompt: (names) => `Use ${names.writeTools}.`,
    check: () => {}, decide: async () => ({ permissionDecision: 'allow', permissionDecisionReason: 'ok' }),
  };

  it("starts a Codex chat under the active Codex account with Codex's prompt and the approvals paragraph, idecore in Codex's dialect, and codex's skills", async () => {
    const { codexAccounts, id } = signedInCodexAccount();
    const h = await harness({ overrides: {
      gate: allowAll, accounts: { codex: codexAccounts },
      mcpServers: () => ({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer core-secret' } } }),
    } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await turnClosed(h);
    const launch = h.started[0];
    expect([
      launch !== undefined && 'codex' in launch && [launch.developerInstructions.startsWith('Use apply_patch.\n\n'), launch.developerInstructions.includes('require_escalated'), launch.config['mcp_servers.idecore.url'], launch.env, launch.codex.env?.CODEX_HOME, launch.codex.unset],
      h.session.state().skills,
    ]).toEqual([
      [true, true, 'http://127.0.0.1:9/mcp?readOnlyHints=1', { CODERAY_IDECORE_TOKEN: 'core-secret' }, codexAccounts.homeDir(id), ['OPENAI_API_KEY', 'CODEX_API_KEY']],
      ['probe-skill'],
    ]);
  });

  it('shows a Codex refusal as a refused chat with its reason, and tries again with the next message', async () => {
    const h = await harness({ codexEnv: { FAKE_CODEX_ACCOUNT: 'none' } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    await waitFor(() => h.session.state().session?.status === 'refused', 'the chat refused');
    h.session.send('hi');
    await waitFor(() => h.started.length === 2 && h.session.state().session?.status === 'refused', 'refused again');
    const signedOut = 'Codex is signed out: run codex login, or add an account in Settings → Accounts.';
    expect([notices(h), thrown(() => h.session.sendAbsorbed('note'))]).toMatchObject([[signedOut, signedOut], { code: 'refused', message: signedOut }]);
  });

  it("moves a chat to the active account and the windows of the engine it changes to before its first message, never the other engine's, both ways", async () => {
    const h = await harness({ claudeScenario: 'usage' });
    h.session.send('hi');
    await turnClosed(h);
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await turnClosed(h);
    await h.session.newSession();
    const shown = () => h.session.state().usage.limits.map((window) => window.label);
    const onCodex = shown();
    await h.session.configure('sonnet', 'medium');
    const onClaude = shown();
    await h.session.configure('codex:gpt-6-luna', 'medium');
    const { codexAccounts, id } = signedInCodexAccount();
    const idle = await harness({ overrides: { accounts: { codex: codexAccounts }, defaultModel: undefined } });
    await idle.session.configure('sonnet', 'medium');
    await idle.session.configure('codex:gpt-6-luna', 'medium');
    expect([onCodex, onClaude, shown(), idle.started, idle.store.session(idle.session.sessionId()!)?.accountId]).toEqual([['30d'], ['5h', '7d'], ['30d'], [], id]);
  });

  it("starts no Codex agent while the gate cannot decide yet, and says so once; nor where CodeRay runs no codex", async () => {
    const h = await harness({ overrides: { gate: { ...allowAll, check: () => { throw new Error('the watchdog is not ready yet'); } } } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    expect(() => h.session.send('hi')).toThrow('CodeRay could not get the gate ready, so the agent was not started.');
    const none = await harness({ overrides: { codex: undefined } });
    await none.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    expect(() => none.session.send('hi')).toThrow('That model needs an engine CodeRay does not have.');
    expect([notices(h), h.started, notices(none), none.started]).toEqual([
      ['CodeRay could not get the gate ready for Codex (the watchdog is not ready yet).'], [], ['That model needs an engine CodeRay does not have.'], [],
    ]);
  });

  it("keeps each engine's account limits apart: a Claude chat after a Codex chat shows none, and the Codex chat its own again", async () => {
    const h = await harness();
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await turnClosed(h);
    const codexChat = h.session.sessionId()!;
    const codexLimits = h.session.state().usage.limits.map((window) => window.label);
    await h.session.newSession({ modelChoice: 'sonnet', effort: 'medium' });
    const claudeLimits = h.session.state().usage.limits.map((window) => window.label);
    await h.session.switchSession(codexChat);
    expect([codexLimits, claudeLimits, h.session.state().usage.limits.map((window) => window.label)]).toEqual([['30d'], [], ['30d']]);
  });

  it('says codex, not claude, when a Codex agent stops unexpectedly', async () => {
    const scenario = join(tempDir('codex-scenario-'), 'exit.jsonl');
    writeFileSync(scenario, '{"fake":"exit","code":3}\n');
    const h = await harness({ codexScenario: scenario });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'the agent crashed');
    expect(notices(h).at(-1)).toMatch(/^codex stopped unexpectedly \(exit code 3\)/);
  });
});
