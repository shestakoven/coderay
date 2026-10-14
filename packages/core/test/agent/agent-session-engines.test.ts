import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ENGINE_CAPABILITIES, type EngineId } from '@ide/protocol';
import { AgentSession, type AgentSessionOptions } from '../../src/agent/agent-session';
import type { ClaudeCommand } from '../../src/agent/claude-process';
import { claudeEngine } from '../../src/agent/engines/claude';
import { EngineRegistry, type Engine } from '../../src/agent/engines/registry';
import type { Launch } from '../../src/agent/transport';
import { projectDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type Store } from '../../src/store/store';
import { transcriptPath } from '../../src/watchdog/recovery';
import { fakeClaude } from '../fake-claude/fake';
import { sessionRecord, tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  started: Launch[];
}

// The fake claude also stands in for Codex, under Codex's id and capabilities, so the session's engine rules run before Codex exists.
function registry(claude: ClaudeCommand, started: Launch[], ids: EngineId[]): EngineRegistry {
  const fake = claudeEngine({ command: () => claude, cwd: '/' });
  return new EngineRegistry(ids.map((id): Engine => ({
    ...fake, id, capabilities: ENGINE_CAPABILITIES[id],
    start: (launch, sink) => {
      started.push(launch);
      return fake.start(launch, sink);
    },
  })));
}

async function harness(options: { engines?: EngineId[]; seed?: (store: Store, root: string, transcriptsDir: string) => void; overrides?: Partial<AgentSessionOptions> } = {}): Promise<Harness> {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const transcriptsDir = tempDir('ide-transcripts-');
  const store = openStore(projectDir(home, root));
  onTestFinished(() => store.close());
  options.seed?.(store, root, transcriptsDir);
  const claude = fakeClaude('multi-turn', join(home, `record-${randomUUID()}.jsonl`));
  const started: Launch[] = [];
  const session = new AgentSession({ root, home, store, claude, transcriptsDir, engines: registry(claude, started, options.engines ?? ['claude', 'codex']), ...options.overrides });
  onTestFinished(() => session.close());
  await session.start();
  return { session, store, started };
}

// A chat on the stand-in Codex whose core was killed mid-turn: still marked running, with a message, and a Claude transcript beside it.
function crashedCodexChat(store: Store, root: string, transcriptsDir: string): void {
  store.saveSession({ ...sessionRecord('codex-chat', root), engine: 'codex', modelChoice: 'codex:gpt-6-luna' });
  store.saveMessage('codex-chat', { id: 'm1', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'hi', ts: 1 });
  const transcript = transcriptPath(transcriptsDir, root, 'claude-codex-chat');
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T12:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'from the transcript' }] } })}\n`);
}

describe('AgentSession on an engine other than Claude', () => {
  it("starts the chat's agent through the engine its record names", async () => {
    const h = await harness({ seed: crashedCodexChat });
    h.session.send('again');
    await waitFor(() => h.started.length === 1, "the chat's agent started");
    expect(h.started.map((launch) => [launch.engine, launch.engineSessionId])).toEqual([['codex', 'claude-codex-chat']]);
  });

  it('reads no Claude transcript after a crash when the engine keeps none, and says calls may be missing', async () => {
    const h = await harness({ seed: crashedCodexChat });
    const state = h.session.state();
    expect([state.items.map((item) => (item.kind === 'notice' ? `notice: ${item.text}` : item.kind === 'message' ? item.text : item.kind)), state.session?.status]).toEqual([
      ['hi', 'notice: Calls made while the core was down may be missing.'], 'crashed',
    ]);
  });

  it('refuses the terminal view for an engine that has none, and leaves the chat as it was', async () => {
    const h = await harness({ seed: crashedCodexChat });
    await expect(h.session.terminalLaunch()).rejects.toMatchObject({ code: 'no-terminal', message: 'This engine has no terminal view.' });
    expect([h.started, h.session.sessionId()]).toEqual([[], 'codex-chat']);
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

const turnClosed = (h: Harness) => waitFor(() => h.session.state().turns.some((turn) => turn.closedAt !== null), 'turn closed');

describe('the model decides the engine', () => {
  it("replaces a new chat's unstarted agent when a model of another engine is chosen before the first message", async () => {
    const h = await harness();
    await h.session.newSession();
    await waitFor(() => h.started.length === 1, "the new chat's agent started");
    const claudePid = h.store.session(h.session.sessionId() ?? '')?.pid ?? -1;
    await h.session.configure('codex:gpt-6-luna', 'minimal');
    await waitFor(() => h.started.length === 2, 'the agent started again');
    expect([h.started.map((launch) => launch.engine), h.session.state().session, h.store.session(h.session.sessionId() ?? '')?.engine, isAlive(claudePid)]).toMatchObject([
      ['claude', 'codex'], { engine: 'codex', modelChoice: 'codex:gpt-6-luna', effort: 'minimal', status: 'running' }, 'codex', false,
    ]);
  });

  it('refuses a model of another engine once the chat is in use, with engine-locked, and keeps the chat as it was', async () => {
    const h = await harness();
    h.session.send('hi');
    await turnClosed(h);
    await expect(h.session.configure('codex:gpt-6-luna', null)).rejects.toMatchObject({
      code: 'engine-locked', message: 'This chat runs on another engine. Start a new chat to use that model.',
    });
    expect([h.session.state().session?.engine, h.session.state().session?.modelChoice, h.started.length]).toEqual(['claude', 'sonnet', 1]);
  });

  it("refuses even a Claude model on a chat of an engine CodeRay does not know, before its first message too, and keeps the chat's own", async () => {
    const h = await harness({
      seed: (store, root) => store.saveSession({ ...sessionRecord('gemini-chat', root), foreignEngine: 'gemini', modelChoice: 'gemini:pro', status: 'ended', conversationStarted: false }),
    });
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
