import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openStore, type GateEventRecord, type MessageRecord, type PlanRecord, type SessionRecord, type ToolDecisionRecord } from '../../src/store/store';
import { DatabaseSync } from '../../src/store/sqlite';
import { tempDir } from '../helpers';

const session = (id: string, startedAt: number, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'stopped', model: null, modelChoice: null, effort: null, cliVersion: null,
  pid: null, launchId: null, conversationStarted: false, startedAt, accountId: null, ...overrides,
});

let counter = 0;
const message = (seq: number, role: MessageRecord['role'], text: string, ts: number): MessageRecord => {
  counter += 1;
  return { id: `m${counter}`, seq, turnId: null, parentToolUseId: null, role, text, ts };
};

function freshStore(dir = tempDir('ide-store-')) {
  const store = openStore(dir);
  onTestFinished(() => store.close());
  return store;
}

describe('schema 4 migration', () => {
  it('adds the model and effort columns to a version 3 history and keeps its sessions, messages and meta', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveSession(session('s1', 5));
    first.saveMessage('s1', message(1, 'user', 'hello', 6));
    first.setMeta('keep', 'me');
    first.close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('ALTER TABLE sessions DROP COLUMN model_choice; ALTER TABLE sessions DROP COLUMN effort; ALTER TABLE sessions DROP COLUMN title; ALTER TABLE sessions DROP COLUMN title_manual; ALTER TABLE plans DROP COLUMN flow; ALTER TABLE sessions DROP COLUMN account_id; ALTER TABLE baselines DROP COLUMN sig; PRAGMA user_version = 3');
    db.close();

    const store = freshStore(dir);
    expect(store.latestSession()).toMatchObject({ id: 's1', startedAt: 5, modelChoice: null, effort: null });
    expect(store.history('s1').messages.map((m) => m.text)).toEqual(['hello']);
    expect(store.meta('keep')).toBe('me');
    store.saveSession(session('s1', 5, { modelChoice: 'opus', effort: 'max' }));
    expect(store.session('s1')).toMatchObject({ modelChoice: 'opus', effort: 'max' });
    store.close();

    const check = new DatabaseSync(join(dir, 'history.sqlite'));
    const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    expect(version).toBe(8);
  });

  it('reads a session row written by an older CodeRay, with no model or effort, as the defaults', () => {
    const dir = tempDir('ide-store-');
    openStore(dir).close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.prepare("INSERT INTO sessions (id, claude_session_id, cwd, status, conversation_started, started_at) VALUES ('old','c','/p','stopped',1,3)").run();
    db.close();
    expect(freshStore(dir).session('old')).toMatchObject({ modelChoice: null, effort: null, conversationStarted: true });
  });

  it('reads an effort CodeRay does not know as the default', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveSession(session('s1', 1, { effort: 'low' }));
    first.close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec("UPDATE sessions SET effort = 'bogus'");
    db.close();
    expect(freshStore(dir).session('s1')?.effort).toBeNull();
  });
});

describe('model choice and effort on a session', () => {
  it('round-trips both through saveSession, latestSession and session', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1, { modelChoice: 'claude-opus-5-5', effort: 'xhigh' }));
    expect(store.latestSession()).toMatchObject({ id: 's1', modelChoice: 'claude-opus-5-5', effort: 'xhigh' });
    expect(store.session('s1')).toMatchObject({ modelChoice: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it('keeps them across a reopen of the history', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveSession(session('s1', 1, { modelChoice: 'haiku', effort: 'low' }));
    first.close();
    expect(freshStore(dir).session('s1')).toMatchObject({ modelChoice: 'haiku', effort: 'low' });
  });

  it('updates both when the session is saved again, and can set them back to the defaults', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1, { modelChoice: 'opus', effort: 'high' }));
    store.saveSession(session('s1', 1, { modelChoice: 'sonnet', effort: 'low' }));
    expect(store.session('s1')).toMatchObject({ modelChoice: 'sonnet', effort: 'low' });
    store.saveSession(session('s1', 1, { modelChoice: null, effort: null }));
    expect(store.session('s1')).toMatchObject({ modelChoice: null, effort: null });
  });

  it('keeps the model of one session out of another', () => {
    const store = freshStore();
    store.saveSession(session('a', 1, { modelChoice: 'opus', effort: 'max' }));
    store.saveSession(session('b', 2));
    expect([store.session('a')?.modelChoice, store.session('b')?.modelChoice, store.session('b')?.effort]).toEqual(['opus', null, null]);
  });

  it('returns null for a session that does not exist', () => {
    expect(freshStore().session('nope')).toBeNull();
  });
});

describe('listSessions', () => {
  it('is empty for a new history', () => {
    expect(freshStore().listSessions()).toEqual([]);
  });

  it('describes a chat by its id, status, model, effort, start, last activity and message count', () => {
    const store = freshStore();
    store.saveSession(session('s1', 10, { status: 'running', modelChoice: 'opus', effort: 'high' }));
    store.saveMessage('s1', message(1, 'user', 'first question', 20));
    store.saveMessage('s1', message(2, 'assistant', 'answer', 35));
    expect(store.listSessions()).toEqual([
      { id: 's1', title: 'first question', startedAt: 10, lastActivityAt: 35, status: 'running', modelChoice: 'opus', effort: 'high', messages: 2 },
    ]);
  });

  it('orders chats by their last activity, newest first, not by start', () => {
    const store = freshStore();
    store.saveSession(session('old-but-busy', 1));
    store.saveMessage('old-but-busy', message(1, 'user', 'x', 500));
    store.saveSession(session('newer-but-quiet', 100));
    store.saveSession(session('middle', 50));
    store.saveMessage('middle', message(1, 'user', 'x', 300));
    expect(store.listSessions().map((chat) => chat.id)).toEqual(['old-but-busy', 'middle', 'newer-but-quiet']);
  });

  it('uses the start time as the activity of a chat with no messages', () => {
    const store = freshStore();
    store.saveSession(session('a', 10));
    store.saveSession(session('b', 30));
    expect(store.listSessions().map((chat) => [chat.id, chat.lastActivityAt])).toEqual([['b', 30], ['a', 10]]);
  });

  it('counts the time a tool call started and ended as activity', () => {
    const store = freshStore();
    store.saveSession(session('tool-ended', 1));
    store.saveToolEvent('tool-ended', { toolUseId: 't1', seq: 1, turnId: null, parentToolUseId: null, tool: 'Bash', input: {}, status: 'ok', toolUseAt: 100, endedAt: 900 });
    store.saveSession(session('tool-running', 2));
    store.saveToolEvent('tool-running', { toolUseId: 't2', seq: 1, turnId: null, parentToolUseId: null, tool: 'Bash', input: {}, status: 'running', toolUseAt: 400, endedAt: null });
    store.saveSession(session('talk', 3));
    store.saveMessage('talk', message(1, 'user', 'x', 200));
    expect(store.listSessions().map((chat) => [chat.id, chat.lastActivityAt])).toEqual([['tool-ended', 900], ['tool-running', 400], ['talk', 200]]);
  });

  it('puts the chat saved later first when two have the same activity', () => {
    const store = freshStore();
    store.saveSession(session('first', 10));
    store.saveSession(session('second', 10));
    expect(store.listSessions().map((chat) => chat.id)).toEqual(['second', 'first']);
  });

  it('titles a chat with its first user message by sequence, ignoring replies and notices before it', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveMessage('s1', message(3, 'user', 'second question', 9));
    store.saveMessage('s1', message(1, 'notice', 'Claude started', 1));
    store.saveMessage('s1', message(2, 'assistant', 'welcome', 2));
    store.saveMessage('s1', message(4, 'user', 'first question by seq is 3 not 4', 10));
    expect(store.listSessions()[0]?.title).toBe('second question');
  });

  it('collapses runs of whitespace and newlines in the title to single spaces and trims the ends', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveMessage('s1', message(1, 'user', '  \n hello \t\n  big   world \n', 2));
    expect(store.listSessions()[0]?.title).toBe('hello big world');
  });

  it('cuts the title to 60 characters', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveMessage('s1', message(1, 'user', 'a'.repeat(59) + 'bcdef', 2));
    expect(store.listSessions()[0]?.title).toBe('a'.repeat(59) + 'b');
  });

  it('keeps a title of exactly 60 characters whole', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveMessage('s1', message(1, 'user', 'a'.repeat(60), 2));
    expect(store.listSessions()[0]?.title).toBe('a'.repeat(60));
  });

  it('does not leave a space at the end of a title that is cut right after a word', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveMessage('s1', message(1, 'user', `${'a'.repeat(59)} next`, 2));
    expect(store.listSessions()[0]?.title).toBe('a'.repeat(59));
  });

  it('titles a chat with no messages, only a reply, or only a blank first message New chat', () => {
    const store = freshStore();
    store.saveSession(session('none', 1));
    store.saveSession(session('reply', 2));
    store.saveMessage('reply', message(1, 'assistant', 'hello', 3));
    store.saveSession(session('blank', 3));
    store.saveMessage('blank', message(1, 'user', '  \n ', 4));
    expect(store.listSessions().map((chat) => [chat.id, chat.title])).toEqual([['blank', 'New chat'], ['reply', 'New chat'], ['none', 'New chat']]);
  });

  it('counts user and assistant messages of each chat, not notices and not other chats', () => {
    const store = freshStore();
    store.saveSession(session('a', 1));
    store.saveSession(session('b', 2));
    store.saveSession(session('c', 3));
    store.saveMessage('a', message(1, 'user', 'q', 4));
    store.saveMessage('a', message(2, 'assistant', 'r', 5));
    store.saveMessage('a', message(3, 'notice', 'n', 6));
    store.saveMessage('b', message(1, 'user', 'q', 7));
    const counts = Object.fromEntries(store.listSessions().map((chat) => [chat.id, chat.messages]));
    expect(counts).toEqual({ a: 2, b: 1, c: 0 });
  });

  it('returns at most the requested number of chats, the most recently active', () => {
    const store = freshStore();
    for (let i = 1; i <= 5; i += 1) store.saveSession(session(`s${i}`, i));
    expect(store.listSessions(2).map((chat) => chat.id)).toEqual(['s5', 's4']);
  });

  it('returns 50 chats when no limit is given', () => {
    const store = freshStore();
    for (let i = 1; i <= 55; i += 1) store.saveSession(session(`s${i}`, i));
    const chats = store.listSessions();
    expect([chats.length, chats[0]?.id, chats.at(-1)?.id]).toEqual([50, 's55', 's6']);
  });
});

describe('active chat in meta', () => {
  it('has no active chat before one is set', () => {
    expect(freshStore().meta('activeSessionId')).toBeNull();
  });

  it('keeps the chat that was set, replaces it on the next set and keeps it across a reopen', () => {
    const dir = tempDir('ide-store-');
    const store = openStore(dir);
    store.setMeta('activeSessionId', 's1');
    store.setMeta('activeSessionId', 's2');
    expect(store.meta('activeSessionId')).toBe('s2');
    store.close();
    expect(freshStore(dir).meta('activeSessionId')).toBe('s2');
  });

  it('tells an empty value apart from no value', () => {
    const store = freshStore();
    store.setMeta('activeSessionId', '');
    expect(store.meta('activeSessionId')).toBe('');
  });
});

describe('deleting chats', () => {
  const fill = (store: ReturnType<typeof freshStore>, id: string, startedAt: number) => {
    store.saveSession(session(id, startedAt));
    store.saveTurn(id, { id: `t-${id}`, kind: 'user', openedAt: startedAt, startedAt, closedAt: null, resultSubtype: null });
    store.saveMessage(id, message(1, 'user', `hello ${id}`, startedAt + 1));
    store.saveToolEvent(id, {
      toolUseId: `tool-${id}`, seq: 2, turnId: null, parentToolUseId: null, tool: 'Bash', input: '{}', status: 'running', toolUseAt: startedAt + 2, endedAt: null,
    });
  };

  it('removes one chat with its conversation and leaves the others', () => {
    const store = freshStore();
    fill(store, 'a', 10);
    fill(store, 'b', 20);
    store.deleteSession('a');
    expect(store.session('a')).toBeNull();
    expect(store.history('a')).toMatchObject({ messages: [], turns: [], toolEvents: [] });
    expect(store.listSessions().map((chat) => chat.id)).toEqual(['b']);
    expect(store.history('b').messages.map((m) => m.text)).toEqual(['hello b']);
    expect(store.history('b').toolEvents).toHaveLength(1);
  });

  it('removes every chat', () => {
    const store = freshStore();
    fill(store, 'a', 10);
    fill(store, 'b', 20);
    store.deleteAllSessions();
    expect([store.listSessions(), store.latestSession(), store.history('a').messages, store.history('b').toolEvents]).toEqual([[], null, [], []]);
  });

  it('does nothing for an unknown id', () => {
    const store = freshStore();
    fill(store, 'a', 10);
    store.deleteSession('missing');
    expect(store.listSessions().map((chat) => chat.id)).toEqual(['a']);
  });
});

describe('deleting a chat that has a plan', () => {
  const plan: PlanRecord = {
    id: 'plan-1', version: 1, goal: 'Fix the bug', status: 'approved', approvedBy: 'auto',
    steps: [{ key: 'edit', order: 1, title: 'Edit app', rationale: 'the bug is there', targets: [{ path: 'src/app.ts', op: 'modify' }] }],
    scope: { paths: ['src/app.ts'], globs: [] }, owners: { 'src/app.ts': 'app' }, review: { auto: true, notes: [] },
    feedback: null, flow: null, proposedAt: 10, decidedAt: 10,
  };
  const decision: ToolDecisionRecord = {
    toolUseId: 'toolu_1', decision: 'allow', planId: 'plan-1', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'], reason: 'CodeRay: allowed', decidedAt: 11,
  };
  const gateEvent: GateEventRecord = {
    id: 'ev-1', toolUseId: 'toolu_2', kind: 'pre-execution', mode: 'A', targets: ['src/other.ts'], prompt: null, resolution: 'denied', ts: 12, resolvedAt: 12,
  };
  const withPlan = (store: ReturnType<typeof freshStore>, id: string) => {
    store.saveSession(session(id, 10));
    store.savePlan(id, { ...plan, id: `plan-${id}` });
    store.saveStepState(`plan-${id}`, 'edit', 'done');
    store.saveToolDecision(id, decision);
    store.saveGateEvent(id, { ...gateEvent, id: `ev-${id}` });
  };

  it('removes the plan, its step states, the decisions and the gate events with the chat', () => {
    const store = freshStore();
    withPlan(store, 'a');
    withPlan(store, 'b');
    store.deleteSession('a');
    expect(store.plans('a')).toEqual({ plans: [], stepStates: {} });
    expect(store.history('a').decisions).toEqual([]);
    expect(store.gateEvents('a')).toEqual([]);
    expect(store.plans('b').plans.map((p) => p.id)).toEqual(['plan-b']);
    expect(store.plans('b').stepStates).toEqual({ 'plan-b': { edit: 'done' } });
    expect(store.history('b').decisions).toHaveLength(1);
    expect(store.gateEvents('b')).toHaveLength(1);
  });

  it('removes them all with every chat', () => {
    const store = freshStore();
    withPlan(store, 'a');
    withPlan(store, 'b');
    store.deleteAllSessions();
    expect([store.plans('b').plans, store.history('b').decisions, store.gateEvents('a'), store.listSessions()]).toEqual([[], [], [], []]);
  });
});
