import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { EngineId } from '@ide/protocol';
import { AccountStore } from '../../src/accounts/account-store';
import { AgentSession, type AgentSessionOptions, type SessionGate } from '../../src/agent/agent-session';
import type { ClaudeCommand } from '../../src/agent/claude-process';
import type { CodexCommand } from '../../src/agent/codex/command';
import { claudeEngine } from '../../src/agent/engines/claude';
import { codexEngine } from '../../src/agent/engines/codex';
import { opencodeEngine } from '../../src/agent/engines/opencode';
import { EngineRegistry, type Engine } from '../../src/agent/engines/registry';
import type { OpencodeCommand } from '../../src/agent/opencode/command';
import { OPENCODE_RULES } from '../../src/agent/system-prompt';
import type { Launch } from '../../src/agent/transport';
import { projectDir, runDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type Store } from '../../src/store/store';
import { transcriptPath } from '../../src/watchdog/recovery';
import { argValue, fakeClaude } from '../fake-claude/fake';
import { codexRecords, fakeCodex, type CodexRecord } from '../fake-codex/fake';
import { fakeOpencode, opencodeHomes, opencodeRecords, type OpencodeRecord } from '../fake-opencode/fake';
import { fixture, NEMOTRON, sessionRecord, SONNET, tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  home: string;
  root: string;
  started: Launch[];
  codexRecords: () => CodexRecord[];
  opencodeRecords: () => OpencodeRecord[];
}

// Each engine runs on its own fake; every start is recorded with the engine's launch.
function registry(claude: ClaudeCommand, codex: CodexCommand, opencode: OpencodeCommand, started: Launch[], ids: EngineId[]): EngineRegistry {
  const engines: Record<string, Engine> = {
    claude: claudeEngine({ command: () => claude, cwd: '/' }),
    codex: codexEngine({ command: () => codex, cwd: '/', signedOut: () => 'Sign in.' }),
    opencode: opencodeEngine({ command: () => opencode, cwd: '/', userServers: () => [] }),
  };
  return new EngineRegistry(ids.map((id): Engine => {
    const engine = engines[id]!;
    return { ...engine, start: (launch, sink) => { started.push(launch); return engine.start(launch, sink); } };
  }));
}

async function harness(options: {
  engines?: EngineId[]; seed?: (store: Store, root: string, transcriptsDir: string) => void; overrides?: Partial<AgentSessionOptions>;
  claudeScenario?: string; codexScenario?: string; codexEnv?: Record<string, string>; opencodeScenario?: string; opencodeEnv?: Record<string, string>;
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
  const opencodeRecord = join(home, `opencode-${randomUUID()}.jsonl`);
  const opencode = fakeOpencode(options.opencodeScenario ?? fixture('opencode/multi-turn.jsonl'), opencodeRecord, { ...opencodeHomes(home), ...options.opencodeEnv });
  const started: Launch[] = [];
  const session = new AgentSession({
    root, home, store, claude, codex, opencode, transcriptsDir,
    engines: registry(claude, codex, opencode, started, options.engines ?? ['claude', 'codex', 'opencode']), defaultModel: SONNET, ...options.overrides,
  });
  onTestFinished(() => session.close());
  await session.start();
  return { session, store, home, root, started, codexRecords: () => codexRecords(codexRecord), opencodeRecords: () => opencodeRecords(opencodeRecord) };
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

  it("starts a Codex chat under the active Codex account with Codex's prompt and the approvals paragraph, idecore in Codex's dialect, and codex's skills, and names that account beside Codex's state", async () => {
    const { codexAccounts, id } = signedInCodexAccount();
    const h = await harness({ overrides: {
      gate: allowAll, accounts: { codex: codexAccounts },
      mcpServers: () => ({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer core-secret' } } }),
    } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await turnClosed(h);
    const launch = h.started[0];
    const own = await harness({ overrides: { accounts: { codex: codexAccounts }, engines: undefined } });
    expect([
      launch !== undefined && 'codex' in launch && [launch.developerInstructions.startsWith('Use apply_patch.\n\n'), launch.developerInstructions.includes('require_escalated'), launch.config['mcp_servers.idecore.url'], launch.env, launch.codex.env?.CODEX_HOME, launch.codex.unset],
      h.session.state().skills,
      await own.session.engines.get('codex')?.status(),
    ]).toEqual([
      [true, true, 'http://127.0.0.1:9/mcp?readOnlyHints=1', { CODERAY_IDECORE_TOKEN: 'core-secret' }, codexAccounts.homeDir(id), ['OPENAI_API_KEY', 'CODEX_API_KEY']],
      ['probe-skill'],
      { engine: 'codex', state: 'ready', hint: null, account: codexAccounts.activeLabel() },
    ]);
  });

  it('shows a Codex refusal as a refused chat with its reason, tries again with the next message, and leaves it behind when the unused chat moves to Claude', async () => {
    const h = await harness({ codexEnv: { FAKE_CODEX_ACCOUNT: 'none' } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    await waitFor(() => h.session.state().session?.status === 'refused', 'the chat refused');
    h.session.send('hi');
    await waitFor(() => h.started.length === 2 && h.session.state().session?.status === 'refused', 'refused again');
    const signedOut = 'Codex is signed out: run codex login, or add an account in Settings → Accounts.';
    const said = notices(h);
    const absorbed = thrown(() => h.session.sendAbsorbed('note'));
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    await waitFor(() => h.started.length === 3 && h.session.state().session?.status === 'refused', 'the next chat refused');
    await h.session.configure('sonnet', 'medium');
    h.session.send('hi');
    await turnClosed(h);
    expect([said, absorbed, h.started.map((launch) => launch.engine)]).toMatchObject([[signedOut, signedOut], { code: 'refused', message: signedOut }, ['codex', 'codex', 'codex', 'claude']]);
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

  it("starts no Codex agent while the gate cannot decide yet, and says so once; nor where CodeRay runs no codex, or cannot give it its MCP servers", async () => {
    const h = await harness({ overrides: { gate: { ...allowAll, check: () => { throw new Error('the watchdog is not ready yet'); } } } });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    expect(() => h.session.send('hi')).toThrow('CodeRay could not get the gate ready, so the agent was not started.');
    const none = await harness({ overrides: { codex: undefined } });
    await none.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    expect(() => none.session.send('hi')).toThrow('That model needs an engine CodeRay does not have.');
    const odd = await harness({ overrides: { gate: allowAll, mcpServers: () => ({ 'my.docs': { type: 'http', url: 'http://127.0.0.1:9/mcp' } }) } });
    await odd.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    const unrendered = 'CodeRay could not give Codex its MCP servers (MCP server name "my.docs" cannot be rendered for Codex), so the agent was not started.';
    expect(() => odd.session.send('hi')).toThrow(unrendered);
    expect([notices(h), h.started, notices(none), none.started, notices(odd), odd.started]).toEqual([
      ['CodeRay could not get the gate ready for Codex (the watchdog is not ready yet).'], [], ['That model needs an engine CodeRay does not have.'], [], [unrendered], [],
    ]);
  });

  it("keeps each engine's account limits apart: Claude's one set across its accounts, each Codex account's its own, so a Claude chat after a Codex chat shows none", async () => {
    const { codexAccounts, id } = signedInCodexAccount();
    codexAccounts.setActive(null);
    const claudeAccounts = new AccountStore({ home: tempDir('ide-claude-accounts-'), engine: 'claude', logout: async () => {} });
    const claudeId = randomUUID();
    claudeAccounts.add({ id: claudeId, email: 'me@example.com', plan: 'Max', createdAt: 1 });
    claudeAccounts.createDir(claudeId);
    const h = await harness({ claudeScenario: 'usage', overrides: { accounts: { codex: codexAccounts, claude: claudeAccounts } } });
    const shown = () => h.session.state().usage.limits.map((window) => window.label);
    const closedTurns = (count: number) => waitFor(() => h.session.state().turns.filter((turn) => turn.closedAt !== null).length === count, `${count} turns closed`);
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await closedTurns(1);
    const codexChat = h.session.sessionId()!;
    const codexLimits = shown();
    await h.session.newSession({ modelChoice: 'sonnet', effort: 'medium' });
    const claudeLimits = shown();
    h.session.send('hi');
    await closedTurns(1);
    const claudeOwn = shown();
    await h.session.changeAccount('claude', () => claudeAccounts.setActive(claudeId));
    await h.session.newSession({ modelChoice: 'sonnet', effort: 'medium' });
    const claudeAnotherAccount = shown();
    await h.session.switchSession(codexChat);
    const again = shown();
    await h.session.changeAccount('codex', () => codexAccounts.setActive(id));
    h.session.send('hi');
    await closedTurns(2);
    expect([codexLimits, claudeLimits, claudeOwn, claudeAnotherAccount, again, shown()]).toEqual([['30d'], [], ['5h', '7d'], ['5h', '7d'], ['30d'], []]);
  });

  it("shows why a Codex turn failed, and says codex, not claude, when a Codex agent stops unexpectedly", async () => {
    const scenario = join(tempDir('codex-scenario-'), 'exit.jsonl');
    writeFileSync(scenario, ['{"fake":"fail","message":"unexpected status 503 Service Unavailable"}', '{"fake":"await-turn"}', '{"fake":"exit","code":3}'].join('\n'));
    const h = await harness({ codexScenario: scenario });
    await h.session.newSession({ modelChoice: 'codex:gpt-6-luna', effort: 'medium' });
    h.session.send('hi');
    await turnClosed(h);
    h.session.send('again');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'the agent crashed');
    expect(notices(h)).toEqual(['Codex: unexpected status 503 Service Unavailable', expect.stringMatching(/^codex stopped unexpectedly \(exit code 3\)/)]);
  });
});

describe('AgentSession on opencode', () => {
  const allowAll: SessionGate = {
    write: () => ({ settingsPath: '/dev/null' }), remove: () => {}, systemPrompt: (names) => `Use ${names.writeTools}; call ${names.idecore('propose_plan')}.`,
    check: () => {}, decide: async () => ({ permissionDecision: 'allow', permissionDecisionReason: 'ok' }),
  };
  const opencodeChat = (h: Harness) => h.session.newSession({ modelChoice: NEMOTRON.modelChoice!, effort: null });

  it("starts an opencode chat on its model and effort with the gate, opencode's prompt names, the rules and the project's instructions once each, idecore in opencode's dialect with the keep-alive and opencode's commands as skills, resumes opencode's session after a restart, and exempts from fail-opens only what its rules run without asking", async () => {
    const h = await harness({ overrides: { gate: allowAll, mcpServers: () => ({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer core-secret' } } }) } });
    writeFileSync(join(h.root, 'AGENTS.md'), '# Project rules\nBe brief.\n');
    symlinkSync('AGENTS.md', join(h.root, 'CLAUDE.md'));
    const before = h.session.exempt()('Read');
    await h.session.newSession({ modelChoice: NEMOTRON.modelChoice!, effort: 'high' });
    h.session.send('hi');
    await turnClosed(h);
    await h.session.restart();
    h.session.send('again');
    await waitFor(() => h.session.state().turns.filter((turn) => turn.closedAt !== null).length === 2, 'the second turn closed');
    const [launch, resumed] = h.started;
    const opened = h.opencodeRecords().find((record) => record.session)?.session?.id;
    const own = await harness({ overrides: { engines: undefined } });
    expect([
      launch !== undefined && 'opencode' in launch && [launch.model, launch.effort, typeof launch.decide, launch.system, launch.mcp.config.idecore],
      h.session.state().skills, [resumed?.resume, resumed?.engineSessionId === opened],
      before, ['Read', 'LS', 'Skill', 'mcp__idecore__step', 'Bash', 'Edit', 'Write', 'Task', 'WebFetch', 'mcp__docs__write'].filter(h.session.exempt()),
      // The core's own registry probes opencode with its shell in the run directory.
      await own.session.engines.get('opencode')?.status(), existsSync(join(runDir(own.home), 'opencode-shell')),
    ]).toEqual([
      ['opencode/nemotron-3.5-lightning-free', 'high', 'function', `Use edit, write, apply_patch; call idecore_propose_plan.\n\n${OPENCODE_RULES}\n\n## AGENTS.md\n# Project rules\nBe brief.\n`,
        { type: 'remote', url: 'http://127.0.0.1:9/mcp?keepAlive=1', headers: { Authorization: 'Bearer core-secret' }, enabled: true, timeout: 86_400_000 }],
      ['probe-skill'], [true, true],
      false, ['Read', 'LS', 'Skill', 'mcp__idecore__step'],
      { engine: 'opencode', state: 'ready', hint: null }, true,
    ]);
  });

  it("shows an opencode refusal as a refused chat with its reason in the words of the chat's account and tries again with the next message, and starts no opencode while the gate cannot decide yet", async () => {
    const h = await harness({ opencodeEnv: { FAKE_OPENCODE_UNKNOWN_MODEL: '1' } });
    await opencodeChat(h);
    h.session.send('hi');
    await waitFor(() => h.session.state().session?.status === 'refused', 'the chat refused');
    h.session.send('again');
    await waitFor(() => h.started.length === 2 && h.session.state().session?.status === 'refused', 'refused again');
    const reason = 'opencode has no provider "opencode" connected for this model. Run opencode auth login in a terminal to connect a provider, or pick a free opencode/* model.';
    const blocked = await harness({ overrides: { gate: { ...allowAll, check: () => { throw new Error('the watchdog is not ready yet'); } } } });
    await opencodeChat(blocked);
    expect(() => blocked.session.send('hi')).toThrow('CodeRay could not get the gate ready, so the agent was not started.');
    expect([notices(h), notices(blocked), blocked.started]).toEqual([[reason, reason], ['CodeRay could not get the gate ready for opencode (the watchdog is not ready yet).'], []]);
  });

  it("says once that the project's instructions were cut, names the server a chat runs on, the second one after the one that read the user's servers, and reads its crash in opencode's words", async () => {
    const h = await harness({ opencodeScenario: fixture('opencode/hang.jsonl'), opencodeEnv: { FAKE_OPENCODE_CONFIG: JSON.stringify({ mcp: { usersrv: { type: 'local', command: ['node'] } } }) } });
    writeFileSync(join(h.root, 'CLAUDE.md'), 'x'.repeat(70_000));
    await opencodeChat(h);
    h.session.send('hi');
    await waitFor(() => h.session.state().items.some((item) => item.kind === 'tool'), 'the server runs the turn');
    const servers = h.opencodeRecords().filter((record) => record.pid !== undefined);
    const chat = servers.at(-1)!;
    expect([servers.length, (chat.configContent as { mcp: Record<string, unknown> }).mcp.usersrv, h.store.session(h.session.sessionId()!)?.pid, existsSync(join(runDir(h.home), `opencode-${chat.pid}.pid.json`))])
      .toEqual([2, { enabled: false }, chat.pid, true]);
    process.kill(chat.pid!, 'SIGKILL');
    await waitFor(() => h.session.state().session?.status === 'crashed', 'the chat crashed');
    expect(notices(h)).toEqual([
      "The project's instructions (AGENTS.md, CLAUDE.md) are longer than 64 KB: opencode gets only their first 64 KB.", expect.stringMatching(/^opencode stopped unexpectedly \(signal SIGKILL\)/),
    ]);
  });
});
