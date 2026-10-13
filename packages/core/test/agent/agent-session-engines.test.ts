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
