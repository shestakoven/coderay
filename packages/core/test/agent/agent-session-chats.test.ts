import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { EMPTY_USAGE, type SessionServerMessage } from '@ide/protocol';
import { AgentSession, SessionError, type AgentSessionOptions } from '../../src/agent/agent-session';
import { projectDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type SessionRecord, type Store } from '../../src/store/store';
import { argValue, fakeClaude, hasArg, readRecords } from '../fake-claude/fake';
import { tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  home: string;
  root: string;
  broadcasts: SessionServerMessage[];
  argvs: () => string[][];
  pids: () => number[];
  setModels: () => (string | null)[];
}

async function harness(scenario: string, overrides: Partial<AgentSessionOptions> = {}, scenarioFile?: string): Promise<Harness> {
  const home = overrides.home ?? tempDir('ide-home-');
  const root = overrides.root ?? tempDir('ide-root-');
  const store = overrides.store ?? openStore(projectDir(home, root));
  if (!overrides.store) onTestFinished(() => store.close());
  const recordFile = join(home, `record-${randomUUID()}.jsonl`);
  const claude = fakeClaude(scenarioFile ?? scenario, recordFile);
  const session = new AgentSession({ root, home, store, claude, ...overrides });
  const broadcasts: SessionServerMessage[] = [];
  session.onMessage((message) => broadcasts.push(message));
  onTestFinished(() => session.close());
  await session.start();
  return {
    session, store, home, root, broadcasts,
    argvs: () => readRecords(recordFile).flatMap((r) => (r.argv ? [r.argv] : [])),
    pids: () => readRecords(recordFile).flatMap((r) => (r.pid ? [r.pid] : [])),
    setModels: () => readRecords(recordFile).flatMap((r) => (r.setModel !== undefined ? [r.setModel] : [])),
  };
}

const flag = argValue;
const closedTurns = (h: Harness) => h.session.state().turns.filter((turn) => turn.closedAt !== null);
const texts = (h: Harness) => h.session.state().items.flatMap((item) => (item.kind === 'message' ? [item.text] : []));
const current = (h: Harness) => {
  const session = h.session.state().session;
  if (!session) throw new Error('no session');
  return session;
};
const lastSnapshot = (h: Harness) => h.broadcasts.filter((message) => message.type === 'session.snapshot').at(-1);

async function ask(h: Harness, text: string, closedAfter = 1): Promise<void> {
  h.session.send(text);
  await waitFor(() => closedTurns(h).length === closedAfter, `turn for "${text}" closed`);
}

async function twoChats(h: Harness) {
  await ask(h, 'first question');
  const a = current(h);
  await h.session.newSession();
  await ask(h, 'second question');
  return { a, b: current(h) };
}

function longBackgroundShell(): string {
  const S = '$SESSION';
  const line = (o: object) => JSON.stringify(o);
  const file = join(tempDir('ide-scenario-'), 'long-background-shell.jsonl');
  writeFileSync(file, [
    line({ fake: 'await-user' }),
    line({ type: 'system', subtype: 'init', cwd: '/fake/project', session_id: S, mcp_servers: [], model: 'm', permissionMode: 'bypassPermissions', claude_code_version: '2.1.296' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'sleep 500', run_in_background: true } }] }, parent_tool_use_id: null, session_id: S }),
    line({ type: 'system', subtype: 'task_started', task_id: 'task_sh', tool_use_id: 'toolu_sh', description: 'sleep 500', is_backgrounded: true, task_type: 'local_bash', session_id: S }),
    line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_sh', type: 'tool_result', content: 'started' }] }, parent_tool_use_id: null, session_id: S }),
    line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: S }),
    line({ fake: 'sleep', ms: 60_000 }),
  ].join('\n'));
  return file;
}

const record = (id: string, startedAt: number, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'stopped', model: null, modelChoice: null, effort: null, cliVersion: null,
  pid: null, launchId: null, conversationStarted: true, startedAt, accountId: null, ...overrides,
});

function seededStore(): { home: string; root: string; store: Store } {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const store = openStore(projectDir(home, root));
  onTestFinished(() => store.close());
  store.saveSession(record('older', 1));
  store.saveMessage('older', { id: 'm-older', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'in the older chat', ts: 2 });
  store.saveSession(record('newer', 10));
  store.saveMessage('newer', { id: 'm-newer', seq: 1, turnId: null, parentToolUseId: null, role: 'user', text: 'in the newer chat', ts: 11 });
  return { home, root, store };
}

describe('claude flags for the model and effort', () => {
  it('starts claude with an explicit sonnet and medium when none is chosen', async () => {
    const h = await harness('multi-turn');
    h.session.send('hi');
    const [argv] = await waitFor(() => h.argvs().length === 1 && h.argvs(), 'claude spawned');
    expect([flag(argv, '--model'), flag(argv, '--effort')]).toEqual(['sonnet', 'medium']);
  });

  it('starts claude with --model and --effort after both were chosen on a chat that has not started yet', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    expect(h.argvs()).toEqual([]);
    h.session.send('hi');
    const [argv] = await waitFor(() => h.argvs().length === 1 && h.argvs(), 'claude spawned');
    expect([flag(argv, '--model'), flag(argv, '--effort'), flag(argv, '--session-id')]).toEqual(['opus', 'high', current(h).claudeSessionId]);
  });

  it('passes only --model when no effort is chosen and only --effort when no model is chosen', async () => {
    const modelOnly = await harness('multi-turn');
    await modelOnly.session.configure('claude-haiku-4-5-20251001', null);
    modelOnly.session.send('hi');
    const [a] = await waitFor(() => modelOnly.argvs().length === 1 && modelOnly.argvs(), 'claude spawned');
    const effortOnly = await harness('multi-turn');
    await effortOnly.session.configure(null, 'low');
    effortOnly.session.send('hi');
    const [b] = await waitFor(() => effortOnly.argvs().length === 1 && effortOnly.argvs(), 'claude spawned');
    expect([hasArg(a, '--model'), hasArg(a, '--effort'), flag(a, '--model'), hasArg(b, '--model'), hasArg(b, '--effort'), flag(b, '--effort')]).toEqual([
      true, false, 'claude-haiku-4-5-20251001', false, true, 'low',
    ]);
  });
});

describe('AgentSession.configure', () => {
  it.each([
    ['a model that starts with a dash', '--evil'],
    ['a model with a single dash', '-x'],
    ['an empty model', ''],
    ['a model with a space', 'opus 4'],
    ['a model of 65 characters', 'a'.repeat(65)],
  ])('refuses %s and changes nothing', async (_label, model) => {
    const h = await harness('multi-turn');
    await expect(h.session.configure(model, null)).rejects.toMatchObject({ code: 'bad-model', message: 'That model name is not valid.' });
    expect([h.session.state().session, h.store.listSessions(), h.argvs()]).toEqual([null, [], []]);
  });

  it('refuses an effort that is not a known level and changes nothing', async () => {
    const h = await harness('multi-turn');
    await expect(h.session.configure(null, 'ultra' as never)).rejects.toMatchObject({ code: 'bad-effort', message: 'That effort level is not valid.' });
    expect([h.session.state().session, h.store.listSessions()]).toEqual([null, []]);
  });

  it('keeps the model and effort of a chat when a later configure is refused', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await expect(h.session.configure('--evil', 'low')).rejects.toBeInstanceOf(SessionError);
    expect(h.store.session(current(h).id)).toMatchObject({ modelChoice: 'opus', effort: 'high' });
  });

  it('is refused while a turn is open, and the running claude is left alone', async () => {
    const h = await harness('hang');
    h.session.send('work');
    await waitFor(() => h.argvs().length === 1, 'claude spawned');
    await expect(h.session.configure('opus', 'high')).rejects.toMatchObject({
      code: 'busy-configure', message: 'Wait for the agent to finish or press Stop before changing the model.',
    });
    expect([current(h).modelChoice, current(h).effort, current(h).status, h.argvs().length]).toEqual(['sonnet', 'medium', 'running', 1]);
    expect(h.store.session(current(h).id)).toMatchObject({ modelChoice: 'sonnet', effort: 'medium' });
  });

  it('is refused while a background task still runs after the turn closed', async () => {
    const h = await harness('multi-turn', {}, longBackgroundShell());
    h.session.send('start a shell');
    await waitFor(() => closedTurns(h).length === 1 && h.session.runningShell(), 'turn closed with the shell running');
    await expect(h.session.configure('opus', null)).rejects.toMatchObject({ code: 'busy-configure' });
    expect([current(h).modelChoice, current(h).status, h.argvs().length]).toEqual(['sonnet', 'running', 1]);
  });

  it('stops a running claude and starts it again with --resume and the new model and effort on the next message', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    const before = current(h);
    const [firstPid] = h.pids();
    await h.session.configure('sonnet', 'low');
    expect(isAlive(firstPid ?? -1)).toBe(false);
    expect(current(h).status).toBe('stopped');
    await ask(h, 'again', 2);
    const argvs = h.argvs();
    expect(argvs).toHaveLength(2);
    expect([flag(argvs[1], '--resume'), hasArg(argvs[1], '--session-id'), flag(argvs[1], '--model'), flag(argvs[1], '--effort')]).toEqual([
      before.claudeSessionId, false, 'sonnet', 'low',
    ]);
  });

  it('does not start a claude by itself when it restarts one', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    await h.session.configure('sonnet', null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.argvs()).toHaveLength(1);
  });

  it('does not restart claude when nothing changes', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.configure('opus', 'high');
    expect([current(h).status, h.argvs().length]).toEqual(['running', 1]);
  });

  it('restarts claude when the effort changes and switches the model inside the running claude', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.configure('opus', 'low');
    expect(current(h).status).toBe('stopped');
    await ask(h, 'again', 2);
    await h.session.configure('haiku', 'low');
    expect([current(h).status, current(h).modelChoice, h.setModels()]).toEqual(['running', 'haiku', ['haiku']]);
    await ask(h, 'third', 3);
    expect(h.argvs().map((argv) => [flag(argv, '--model'), flag(argv, '--effort')])).toEqual([['opus', 'high'], ['opus', 'low']]);
    await h.session.configure(null, 'low');
    expect(h.setModels()).toEqual(['haiku', null]);
  });

  it('ignores the echo claude prints for a model switch: no turn, no prompt, no message', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.configure('haiku', 'high');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect([h.setModels(), h.session.state().turns.map((turn) => turn.kind), h.session.hasOpenTurn()]).toEqual([['haiku'], ['user'], false]);
    await ask(h, 'again', 2);
    const { items } = h.session.state();
    expect([items.filter((item) => item.kind === 'prompt').length, texts(h).some((text) => text.includes('Set model'))]).toEqual([0, false]);
  });

  it('removes the flags again when the choice goes back to the default', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.configure(null, null);
    await ask(h, 'again', 2);
    const second = h.argvs()[1];
    expect([hasArg(second, '--model'), hasArg(second, '--effort')]).toEqual([false, false]);
  });

  it('saves the model and effort in the history', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('claude-opus-5-5', 'xhigh');
    expect(h.store.session(current(h).id)).toMatchObject({ modelChoice: 'claude-opus-5-5', effort: 'xhigh' });
    expect(h.store.listSessions()[0]).toMatchObject({ modelChoice: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it('tells clients the updated session with the chosen model and effort', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    h.broadcasts.length = 0;
    await h.session.configure('opus', 'high');
    const views = h.broadcasts.flatMap((message) => (message.type === 'session.patch' && message.patch.session ? [message.patch.session] : []));
    expect(views.at(-1)).toMatchObject({ id: current(h).id, modelChoice: 'opus', effort: 'high' });
    expect(h.session.state().session).toMatchObject({ modelChoice: 'opus', effort: 'high' });
  });

  it('keeps the chosen model apart from the model claude reports', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', null);
    await ask(h, 'hi');
    expect(current(h)).toMatchObject({ modelChoice: 'opus', model: 'claude-haiku-4-5-20251001' });
  });

  it('opens a new chat with the choice when the previous chat was ended', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.newSession();
    await h.session.configure('haiku', null);
    const fresh = current(h);
    expect([fresh.status, fresh.modelChoice, fresh.effort, h.store.listSessions()]).toMatchObject(['stopped', 'haiku', null, [{ id: fresh.id }, {}]]);
    h.session.send('hello');
    const argv = await waitFor(() => h.argvs()[1], 'second claude spawned');
    expect([flag(argv, '--session-id'), flag(argv, '--model'), hasArg(argv, '--effort')]).toEqual([fresh.claudeSessionId, 'haiku', false]);
  });
});

describe('a new chat inherits the model and effort', () => {
  it('takes them from the chat that was ended by New session', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('opus', 'high');
    await ask(h, 'hi');
    await h.session.newSession();
    h.session.send('hello');
    const argv = await waitFor(() => h.argvs()[1], 'second claude spawned');
    expect([current(h).modelChoice, current(h).effort, flag(argv, '--model'), flag(argv, '--effort')]).toEqual(['opus', 'high', 'opus', 'high']);
    expect(h.store.session(current(h).id)).toMatchObject({ modelChoice: 'opus', effort: 'high' });
  });

  it('takes them from the chat that ended before a core restart', async () => {
    const first = await harness('multi-turn');
    await first.session.configure('sonnet', 'max');
    await ask(first, 'hi');
    await first.session.newSession();
    await first.session.close();
    const second = await harness('multi-turn', { home: first.home, root: first.root });
    expect(second.session.state().session).toBeNull();
    second.session.send('hello');
    const argv = await waitFor(() => second.argvs()[0], 'claude spawned');
    expect([flag(argv, '--model'), flag(argv, '--effort')]).toEqual(['sonnet', 'max']);
  });

  it('takes them from the chat that is open', async () => {
    const h = await harness('multi-turn');
    const { a } = await twoChats(h);
    await h.session.configure('haiku', 'low');
    await h.session.newSession();
    h.session.send('third');
    await waitFor(() => current(h).modelChoice === 'haiku', 'third chat created');
    expect([a.modelChoice, current(h).modelChoice, current(h).effort]).toEqual(['sonnet', 'haiku', 'low']);
  });
});

describe('AgentSession.listChats', () => {
  it('lists the stored chats with the open one marked, newest activity first', async () => {
    const h = await harness('multi-turn');
    const { a, b } = await twoChats(h);
    const { activeId, sessions } = h.session.listChats();
    expect(activeId).toBe(b.id);
    expect(sessions.map((chat) => [chat.id, chat.title, chat.messages])).toEqual([[b.id, 'second question', 2], [a.id, 'first question', 2]]);
  });

  it('has no open chat after New session but still lists the ended chat', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    const { id } = current(h);
    await h.session.newSession();
    const { activeId, sessions } = h.session.listChats();
    expect([activeId, sessions.map((chat) => [chat.id, chat.status])]).toEqual([null, [[id, 'ended']]]);
  });

  it('has nothing for a project without chats', async () => {
    const h = await harness('multi-turn');
    expect(h.session.listChats()).toEqual({ activeId: null, sessions: [] });
  });
});

describe('AgentSession.switchSession', () => {
  it('opens the other chat with its saved messages, stopped, and remembers it as the active chat', async () => {
    const h = await harness('multi-turn');
    const { a } = await twoChats(h);
    await h.session.switchSession(a.id);
    expect([current(h).id, current(h).status, texts(h)]).toEqual([a.id, 'stopped', ['first question', 'OK']]);
    expect([h.store.meta('activeSessionId'), h.session.listChats().activeId, h.session.sessionId()]).toEqual([a.id, a.id, a.id]);
  });

  it('stops the claude of the chat it leaves and leaves that chat stopped, not ended', async () => {
    const h = await harness('multi-turn');
    const { b } = await twoChats(h);
    const secondPid = h.pids()[1];
    expect(isAlive(secondPid ?? -1)).toBe(true);
    await h.session.switchSession((h.store.listSessions().find((chat) => chat.id !== b.id) ?? { id: '' }).id);
    expect(isAlive(secondPid ?? -1)).toBe(false);
    expect(h.store.session(b.id)).toMatchObject({ status: 'stopped', pid: null });
  });

  it('starts the next message of the opened chat with --resume of its own claude session', async () => {
    const h = await harness('multi-turn');
    const { a, b } = await twoChats(h);
    await h.session.switchSession(a.id);
    expect(h.argvs()).toHaveLength(2);
    await ask(h, 'back again', 2);
    const argv = h.argvs()[2];
    expect([flag(argv, '--resume'), hasArg(argv, '--session-id'), flag(argv, '--resume') === b.claudeSessionId]).toEqual([a.claudeSessionId, false, false]);
    expect(texts(h)).toEqual(['first question', 'OK', 'back again', 'OK']);
  });

  it('can go back and forth between chats, resuming each one', async () => {
    const h = await harness('multi-turn');
    const { a, b } = await twoChats(h);
    await h.session.switchSession(a.id);
    await ask(h, 'in a', 2);
    await h.session.switchSession(b.id);
    await ask(h, 'in b', 2);
    expect(h.argvs().slice(2).map((argv) => flag(argv, '--resume'))).toEqual([a.claudeSessionId, b.claudeSessionId]);
    expect(texts(h)).toEqual(['second question', 'OK', 'in b', 'OK']);
  });

  it('reopens an ended chat as stopped and resumes it on the next message', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'old talk');
    const old = current(h);
    await h.session.newSession();
    expect(h.store.session(old.id)?.status).toBe('ended');
    await h.session.switchSession(old.id);
    expect([current(h).status, h.store.session(old.id)?.status]).toEqual(['stopped', 'stopped']);
    await ask(h, 'more', 2);
    const argv = h.argvs()[1];
    expect([flag(argv, '--resume'), hasArg(argv, '--session-id')]).toEqual([old.claudeSessionId, false]);
  });

  it('opens a chat when no chat is open', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    const { id } = current(h);
    await h.session.newSession();
    expect(h.session.state().session).toBeNull();
    await h.session.switchSession(id);
    expect([current(h).id, texts(h), h.store.meta('activeSessionId')]).toEqual([id, ['hi', 'OK'], id]);
  });

  it('tells clients a snapshot of the opened chat', async () => {
    const h = await harness('multi-turn');
    const { a } = await twoChats(h);
    h.broadcasts.length = 0;
    await h.session.switchSession(a.id);
    const snapshot = lastSnapshot(h);
    expect(snapshot?.type === 'session.snapshot' && [snapshot.state.session?.id, snapshot.state.session?.status]).toEqual([a.id, 'stopped']);
  });

  it('tells new-session listeners once', async () => {
    const h = await harness('multi-turn');
    const { a } = await twoChats(h);
    let fired = 0;
    h.session.onNewSession(() => {
      fired += 1;
    });
    await h.session.switchSession(a.id);
    expect(fired).toBe(1);
  });

  it('forgets the MCP servers and permission mode of the chat it leaves until the next claude reports them', async () => {
    const h = await harness('multi-turn');
    const { a } = await twoChats(h);
    expect([h.session.state().mcpServers, current(h).permissionMode]).toEqual([[{ name: 'spike', status: 'connected' }], 'bypassPermissions']);
    await h.session.switchSession(a.id);
    expect([h.session.state().mcpServers, current(h).permissionMode]).toEqual([[], null]);
  });

  it('forgets the skills of the chat it leaves until the next claude reports them', async () => {
    const h = await harness('skills-init');
    const { a } = await twoChats(h);
    expect(h.session.state().skills).toEqual(['repo-probe', 'superpowers:brainstorming']);
    await h.session.switchSession(a.id);
    expect(h.session.state().skills).toEqual([]);
  });

  it('sends clients an empty skills list in the snapshot of the chat it switches to', async () => {
    const h = await harness('skills-init');
    const { a } = await twoChats(h);
    await h.session.switchSession(a.id);
    const snapshot = lastSnapshot(h);
    expect(snapshot?.type === 'session.snapshot' && snapshot.state.skills).toEqual([]);
  });

  it('does nothing when the chat is already open', async () => {
    const h = await harness('multi-turn');
    const { b } = await twoChats(h);
    let fired = 0;
    h.session.onNewSession(() => {
      fired += 1;
    });
    h.broadcasts.length = 0;
    await h.session.switchSession(b.id);
    expect([current(h).status, fired, h.broadcasts.length, isAlive(h.pids()[1] ?? -1)]).toEqual(['running', 0, 0, true]);
  });

  it('refuses a chat that does not exist and leaves the open chat running', async () => {
    const h = await harness('multi-turn');
    const { b } = await twoChats(h);
    await expect(h.session.switchSession('no-such-chat')).rejects.toMatchObject({ code: 'no-chat', message: 'That chat does not exist.' });
    expect([current(h).id, current(h).status, isAlive(h.pids()[1] ?? -1)]).toEqual([b.id, 'running', true]);
  });

  it('refuses while a turn is open and leaves the running claude alone', async () => {
    const h = await harness('hang');
    const other = record('other', 1);
    h.store.saveSession(other);
    h.session.send('work');
    await waitFor(() => h.argvs().length === 1, 'claude spawned');
    const open = current(h);
    await expect(h.session.switchSession('other')).rejects.toMatchObject({
      code: 'busy-switch', message: 'Wait for the agent to finish or press Stop before switching chats.',
    });
    expect([current(h).id, current(h).status, isAlive(h.pids()[0] ?? -1), h.store.meta('activeSessionId')]).toEqual([open.id, 'running', true, open.id]);
  });

  it('refuses while a background task runs after the turn closed', async () => {
    const h = await harness('multi-turn', {}, longBackgroundShell());
    h.store.saveSession(record('other', 1));
    h.session.send('start a shell');
    await waitFor(() => closedTurns(h).length === 1 && h.session.runningShell(), 'turn closed with the shell running');
    await expect(h.session.switchSession('other')).rejects.toMatchObject({ code: 'busy-switch' });
    expect(current(h).status).toBe('running');
  });

  it('refuses with the reason canLeave gives and leaves the chat as it was', async () => {
    let reason: string | null = 'Answer the waiting plan before switching chats.';
    const h = await harness('multi-turn', { canLeave: () => reason });
    const { a, b } = await twoChats(h);
    await expect(h.session.switchSession(a.id)).rejects.toMatchObject({ code: 'busy-switch', message: 'Answer the waiting plan before switching chats.' });
    expect([current(h).id, current(h).status, isAlive(h.pids()[1] ?? -1), h.store.meta('activeSessionId')]).toEqual([b.id, 'running', true, b.id]);
    reason = null;
    await h.session.switchSession(a.id);
    expect(current(h).id).toBe(a.id);
  });

  it('asks canLeave only for a chat other than the open one and only when the agent is idle', async () => {
    let asked = 0;
    const h = await harness('hang', { canLeave: () => {
      asked += 1;
      return null;
    } });
    h.store.saveSession(record('other', 1));
    h.session.send('work');
    await waitFor(() => h.argvs().length === 1, 'claude spawned');
    await expect(h.session.switchSession('other')).rejects.toMatchObject({ code: 'busy-switch' });
    await h.session.switchSession(current(h).id);
    expect(asked).toBe(0);
  });
});

describe('AgentSession.start with several chats', () => {
  it('opens the chat the meta names as active, not the newest one', async () => {
    const { home, root, store } = seededStore();
    store.setMeta('activeSessionId', 'older');
    const h = await harness('multi-turn', { home, root, store });
    expect([current(h).id, current(h).status, texts(h)]).toEqual(['older', 'stopped', ['in the older chat']]);
  });

  it('opens the newest chat when no active chat was ever saved', async () => {
    const { home, root, store } = seededStore();
    const h = await harness('multi-turn', { home, root, store });
    expect(current(h).id).toBe('newer');
  });

  it('opens the newest chat when the active chat is gone', async () => {
    const { home, root, store } = seededStore();
    store.setMeta('activeSessionId', 'deleted-long-ago');
    const h = await harness('multi-turn', { home, root, store });
    expect(current(h).id).toBe('newer');
  });

  it('opens no chat when the active chat is empty because the user ended it, even though older chats exist', async () => {
    const { home, root, store } = seededStore();
    store.setMeta('activeSessionId', '');
    const h = await harness('multi-turn', { home, root, store });
    expect([h.session.state(), h.session.sessionId()]).toEqual([{ session: null, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE }, null]);
  });

  it('opens no chat when the active chat was ended', async () => {
    const { home, root, store } = seededStore();
    store.saveSession(record('older', 1, { status: 'ended' }));
    store.setMeta('activeSessionId', 'older');
    const h = await harness('multi-turn', { home, root, store });
    expect(h.session.state().session).toBeNull();
  });

  it('remembers the chat created by the first message as the active chat, and clears it on New session', async () => {
    const h = await harness('multi-turn');
    await ask(h, 'hi');
    expect(h.store.meta('activeSessionId')).toBe(current(h).id);
    await h.session.newSession();
    expect(h.store.meta('activeSessionId')).toBe('');
  });

  it('keeps a new chat as the active one after a core restart', async () => {
    const first = await harness('multi-turn');
    const { a } = await twoChats(first);
    await first.session.switchSession(a.id);
    await first.session.close();
    const second = await harness('multi-turn', { home: first.home, root: first.root });
    expect([current(second).id, texts(second)]).toEqual([a.id, ['first question', 'OK']]);
  });
});

describe('AgentSession.deleteSession', () => {
  it('removes a chat that is not open and leaves the open one alone', async () => {
    const h = await harness('multi-turn');
    const { a, b } = await twoChats(h);
    await h.session.deleteSession(a.id);
    expect(h.session.listChats()).toMatchObject({ activeId: b.id, sessions: [{ id: b.id }] });
    expect(h.store.session(a.id)).toBeNull();
    expect(h.store.history(a.id).messages).toEqual([]);
    expect(current(h).id).toBe(b.id);
    expect(texts(h)).toContain('second question');
  });

  it('stops the claude of the open chat, forgets the chat and leaves an empty one', async () => {
    const h = await harness('hang');
    h.session.send('work');
    await waitFor(() => h.argvs().length === 1 && h.pids().length === 1, 'claude spawned');
    const open = current(h);
    const pid = h.pids()[0];
    await h.session.deleteSession(open.id);
    expect(isAlive(pid ?? -1)).toBe(false);
    expect(h.store.session(open.id)).toBeNull();
    expect(h.store.listSessions()).toEqual([]);
    expect(h.session.listChats()).toEqual({ activeId: null, sessions: [] });
    expect(h.session.state()).toMatchObject({ session: null, items: [], turns: [] });
    expect(lastSnapshot(h)).toMatchObject({ state: { session: null } });
  });

  it('starts the next message in a fresh chat that keeps the chosen model', async () => {
    const h = await harness('multi-turn');
    await h.session.configure('haiku', 'low');
    await ask(h, 'hi');
    const old = current(h);
    await h.session.deleteSession(old.id);
    await ask(h, 'again');
    expect(current(h)).toMatchObject({ modelChoice: 'haiku', effort: 'low' });
    expect(current(h).id).not.toBe(old.id);
    expect(h.store.listSessions().map((chat) => chat.id)).toEqual([current(h).id]);
  });

  it('refuses an unknown chat', async () => {
    const h = await harness('multi-turn');
    await expect(h.session.deleteSession('nope')).rejects.toMatchObject({ code: 'no-chat' });
  });
});

describe('AgentSession.deleteAllSessions', () => {
  it('stops claude and removes every chat', async () => {
    const h = await harness('multi-turn');
    await twoChats(h);
    const pid = h.pids().at(-1);
    await h.session.deleteAllSessions();
    expect(isAlive(pid ?? -1)).toBe(false);
    expect([h.store.listSessions(), h.store.latestSession(), h.session.listChats()]).toEqual([[], null, { activeId: null, sessions: [] }]);
  });

  it('works with no chats at all', async () => {
    const h = await harness('multi-turn');
    await h.session.deleteAllSessions();
    expect(h.session.listChats()).toEqual({ activeId: null, sessions: [] });
  });
});

describe('AgentSession usage', () => {
  it('reports the context of the chat and the account limits, and tells clients when they change', async () => {
    const h = await harness('usage');
    await ask(h, 'hi');
    expect(h.session.state().usage).toEqual({
      contextTokens: 96_010, contextWindow: 200_000, fiveHour: { utilization: 0.42, resetsAt: 1790898600 }, sevenDay: { utilization: 0.07, resetsAt: 1791482400 },
    });
    const patches = h.broadcasts.flatMap((message) => (message.type === 'session.patch' && message.patch.usage ? [message.patch.usage] : []));
    expect(patches.at(-1)).toEqual(h.session.state().usage);
    expect(patches.length).toBeGreaterThanOrEqual(2);
  });

  it('starts a new chat with an empty context but keeps the account limits', async () => {
    const h = await harness('usage');
    await ask(h, 'hi');
    await h.session.newSession();
    expect(h.session.state().usage).toEqual({ contextTokens: null, contextWindow: null, fiveHour: { utilization: 0.42, resetsAt: 1790898600 }, sevenDay: { utilization: 0.07, resetsAt: 1791482400 } });
    expect(lastSnapshot(h)).toMatchObject({ state: { usage: { contextTokens: null } } });
  });

  it('shows no usage before the agent has said anything', async () => {
    const h = await harness('usage');
    expect(h.session.state().usage).toEqual({ contextTokens: null, contextWindow: null, fiveHour: null, sevenDay: null });
  });
});
