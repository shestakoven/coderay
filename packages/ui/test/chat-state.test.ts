import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type ChatItem, type SessionPatch, type SessionState, type TaskKind, type TaskView, type ToolStatus, type TurnView } from '@ide/protocol';
import { canSend, canStop, chatReducer, childItems, decisionLabel, initialChatState, stopControl, turnGroups } from '../src/chat/chat-state';
import { matchSkills } from '../src/chat/skills';

const session = {
  id: 's1', engine: 'claude' as const, engineSessionId: 'c1', status: 'running' as const, model: 'haiku', modelChoice: null, effort: null, cliVersion: '2.1.281', permissionMode: 'bypassPermissions', startedAt: 1,
};
const turn = (id: string, kind: TurnView['kind'], state: 'waiting' | 'running' | 'closed' = 'closed'): TurnView => ({
  id, kind, openedAt: 1, startedAt: state === 'waiting' ? null : 2, closedAt: state === 'closed' ? 3 : null, resultSubtype: state === 'closed' ? 'success' : null,
});
const message = (id: string, seq: number, turnId: string | null, text: string): ChatItem =>
  ({ kind: 'message', id, seq, turnId, parentToolUseId: null, role: 'assistant', text, ts: seq });
const tool = (id: string, seq: number, turnId: string | null, parentToolUseId: string | null = null, status: ToolStatus = 'ok'): ChatItem =>
  ({ kind: 'tool', id, seq, turnId, parentToolUseId, tool: 'Bash', summary: 'npm test', status, startedAt: seq, endedAt: status === 'running' ? null : seq, decision: null, targets: [] });
const task = (id: string, kind: TaskKind, endedAt: number | null = null): TaskView =>
  ({ id, toolUseId: null, kind, description: id, status: endedAt === null ? 'running' : 'completed', startedAt: 1, endedAt });
const chat = (partial: Partial<SessionState>) =>
  chatReducer(initialChatState, { type: 'snapshot', state: { session, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE, ...partial } });

describe('chatReducer', () => {
  it('replaces the whole chat on a snapshot', () => {
    const before = chat({ turns: [turn('t1', 'user')], items: [message('m1', 1, 't1', 'old')] });
    const after = chatReducer(before, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE } });
    expect([after.session, Object.keys(after.turns), Object.keys(after.items)]).toEqual([null, [], []]);
  });

  it('upserts turns and items from a patch by id', () => {
    const before = chat({ turns: [turn('t1', 'user', 'running')], items: [tool('b1', 1, 't1', null, 'running')] });
    const after = chatReducer(before, { type: 'patch', patch: { turns: [turn('t1', 'user')], items: [tool('b1', 1, 't1'), message('m2', 2, 't1', 'done')] } });
    expect(after.turns.t1?.closedAt).toBe(3);
    expect(Object.values(after.items).map((item) => (item.kind === 'tool' ? item.status : item.kind === 'message' ? item.text : ''))).toEqual(['ok', 'done']);
  });
});

describe('chatReducer skills', () => {
  const patch = (state: ReturnType<typeof chat>, p: SessionPatch) => chatReducer(state, { type: 'patch', patch: p });

  it('starts with no skills', () => {
    expect(initialChatState.skills).toEqual([]);
  });

  it('takes the skills, and whether the agent has said them, from a snapshot', () => {
    const after = chat({ skills: ['wiki', 'superpowers:brainstorming'], skillsKnown: true });
    expect([after.skills, after.skillsKnown]).toEqual([['wiki', 'superpowers:brainstorming'], true]);
  });

  it('replaces the skills on a snapshot, including with an empty list', () => {
    const before = chat({ skills: ['wiki'] });
    const next = chatReducer(before, { type: 'snapshot', state: { session, turns: [], items: [], tasks: [], mcpServers: [], skills: ['review'], usage: EMPTY_USAGE } });
    const cleared = chatReducer(next, { type: 'snapshot', state: { session, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE } });
    expect([next.skills, cleared.skills]).toEqual([['review'], []]);
  });

  it('replaces the skills with the ones in a patch, and learns that they are known', () => {
    const after = patch(chat({ skills: ['wiki'] }), { skills: ['review', 'p:deploy'], skillsKnown: true });
    expect([after.skills, after.skillsKnown]).toEqual([['review', 'p:deploy'], true]);
  });

  it('clears the skills with an empty list in a patch', () => {
    expect(patch(chat({ skills: ['wiki'] }), { skills: [] }).skills).toEqual([]);
  });

  it('keeps the skills, and that they are known, on a patch that has none', () => {
    const after = patch(chat({ skills: ['wiki'], skillsKnown: true }), { turns: [turn('t1', 'user')] });
    expect([after.skills, after.skillsKnown]).toEqual([['wiki'], true]);
  });

  it('keeps the skills on a patch that only carries the usage or the MCP servers', () => {
    const before = chat({ skills: ['wiki'] });
    expect([patch(before, { usage: EMPTY_USAGE }).skills, patch(before, { mcpServers: [{ name: 'docs', status: 'connected' }] }).skills]).toEqual([['wiki'], ['wiki']]);
  });

  it('keeps the MCP servers on a patch that only carries skills', () => {
    const before = chat({ mcpServers: [{ name: 'docs', status: 'connected' }] });
    expect(patch(before, { skills: ['wiki'] }).mcpServers).toEqual([{ name: 'docs', status: 'connected' }]);
  });

  describe('against a core that sends no skills', () => {
    const { skills: _skills, ...oldState } = { session, turns: [], items: [], tasks: [], mcpServers: [], skills: ['wiki'], usage: EMPTY_USAGE };
    const oldSnapshot = (before = initialChatState) => chatReducer(before, { type: 'snapshot', state: oldState as unknown as SessionState });

    it('has an empty skill list, not known, after a snapshot without the skills fields', () => {
      const after = oldSnapshot(chat({ skills: ['wiki'], skillsKnown: true }));
      expect([after.skills, after.skillsKnown]).toEqual([[], false]);
    });

    it('keeps the empty skill list on a later patch and matches nothing for the slash menu', () => {
      const after = patch(oldSnapshot(), { turns: [turn('t1', 'user')] });
      expect([after.skills, matchSkills(after.skills, '')]).toEqual([[], []]);
    });
  });
});

describe('chatReducer draft', () => {
  const delta = (state: ReturnType<typeof chat>, text: string) => chatReducer(state, { type: 'delta', text });
  const streaming = () => delta(delta(chat({ turns: [turn('t1', 'user', 'running')] }), 'Hel'), 'lo');
  const patch = (state: ReturnType<typeof chat>, p: SessionPatch) => chatReducer(state, { type: 'patch', patch: p });

  it('starts with an empty draft', () => {
    expect(chat({}).draft).toBe('');
  });

  it('appends streamed text deltas in order', () => {
    expect(streaming().draft).toBe('Hello');
  });

  it('clears the draft on a snapshot', () => {
    const after = chatReducer(streaming(), { type: 'snapshot', state: { session, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE } });
    expect(after.draft).toBe('');
  });

  it('clears the draft when the finished top-level assistant message arrives', () => {
    expect(patch(streaming(), { items: [message('m1', 1, 't1', 'Hello')] }).draft).toBe('');
  });

  it('clears the draft when the turn closes', () => {
    expect(patch(streaming(), { turns: [turn('t1', 'user')] }).draft).toBe('');
  });

  it('keeps the draft on a patch that only changes a still-open turn', () => {
    expect(patch(streaming(), { turns: [turn('t1', 'user', 'running')] }).draft).toBe('Hello');
  });

  it('keeps the draft when a tool item arrives', () => {
    expect(patch(streaming(), { items: [tool('b1', 2, 't1')] }).draft).toBe('Hello');
  });

  it('keeps the draft when a user message arrives', () => {
    const user: ChatItem = { kind: 'message', id: 'u1', seq: 2, turnId: 't1', parentToolUseId: null, role: 'user', text: 'more', ts: 2 };
    expect(patch(streaming(), { items: [user] }).draft).toBe('Hello');
  });

  it('keeps the draft when a subagent message arrives', () => {
    const sub: ChatItem = { ...message('s1', 2, null, 'sub text'), parentToolUseId: 'agent' };
    expect(patch(streaming(), { items: [sub] }).draft).toBe('Hello');
  });

  it('keeps the draft on a usage patch', () => {
    expect(patch(streaming(), { usage: EMPTY_USAGE }).draft).toBe('Hello');
  });
});

describe('turnGroups', () => {
  it('groups top-level items by turn in sequence order', () => {
    const state = chat({
      turns: [turn('t1', 'user'), turn('t2', 'agent-initiated')],
      items: [message('m3', 3, 't2', 'c'), message('m1', 1, 't1', 'a'), message('m2', 2, 't1', 'b')],
    });
    expect(turnGroups(state).map((group) => [group.turn?.id, group.items.map((item) => item.id)])).toEqual([['t1', ['m1', 'm2']], ['t2', ['m3']]]);
  });

  it('starts a new group when items outside a turn interrupt it', () => {
    const state = chat({ turns: [turn('t1', 'user')], items: [message('m1', 1, 't1', 'a'), message('n2', 2, null, 'notice'), message('m3', 3, 't1', 'b')] });
    expect(turnGroups(state).map((group) => group.items.map((item) => item.id))).toEqual([['m1'], ['n2'], ['m3']]);
  });

  it("nests a subagent's items under the Agent call that started them", () => {
    const state = chat({ turns: [turn('t1', 'user')], items: [tool('agent', 1, 't1'), tool('sub', 2, null, 'agent')] });
    expect(turnGroups(state).flatMap((group) => group.items.map((item) => item.id))).toEqual(['agent']);
    expect(childItems(state, 'agent').map((item) => item.id)).toEqual(['sub']);
  });
});

describe('canSend and canStop', () => {
  it('does not allow sending while any turn is open', () => {
    expect([canSend(chat({ turns: [turn('t1', 'user', 'running')] })), canSend(chat({ turns: [turn('t1', 'agent-initiated', 'running')] }))]).toEqual([false, false]);
  });

  it('allows stopping only a turn claude has started', () => {
    expect([canStop(chat({ turns: [turn('t1', 'user', 'waiting')] })), canStop(chat({ turns: [turn('t1', 'user', 'running')] }))]).toEqual([false, true]);
  });

  it('names on the Stop control the running background subagents an interrupt also stops', () => {
    const tasks = [task('a1', 'subagent'), task('a2', 'subagent'), task('a3', 'subagent', 5), task('b1', 'shell')];
    const running = { turns: [turn('t1', 'user', 'running')] };
    expect([stopControl(chat(running)).label, stopControl(chat({ ...running, tasks })).label]).toEqual(['Stop', 'Stop (+2 subagents)']);
    expect(stopControl(chat({ ...running, tasks })).title).toContain('also stops 2 running background subagents');
  });

  it('keeps the Stop label plain when Stop is disabled, even with running subagents', () => {
    const tasks = [task('a1', 'subagent')];
    expect(stopControl(chat({ tasks })).label).toBe('Stop');
    expect(stopControl(chat({ turns: [turn('t1', 'user', 'waiting')], tasks })).label).toBe('Stop');
  });
});

describe('decisionLabel', () => {
  it('labels a tool row by the decision the gate made', () => {
    expect([null, 'allow', 'unchecked', 'deny', 'ask-approved', 'ask-denied', 'flag'].map((decision) => decisionLabel(decision as never)))
      .toEqual(['', '', '', 'blocked', 'allowed by you', 'denied by you', 'flagged']);
  });

  it.each([['hook-missing', 'the hook did not run'], ['hook-pending', 'the hook was still waiting']])('labels %s', (decision, text) => {
    expect(decisionLabel(decision as never)).toBe(text);
  });
});
