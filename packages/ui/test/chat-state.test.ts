import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type ChatItem, type SessionState, type TaskKind, type TaskView, type ToolStatus, type TurnView } from '@ide/protocol';
import { canSend, canStop, chatReducer, childItems, decisionLabel, initialChatState, stopControl, turnGroups } from '../src/chat/chat-state';

const session = {
  id: 's1', claudeSessionId: 'c1', status: 'running' as const, model: 'haiku', modelChoice: null, effort: null, cliVersion: '2.1.281', permissionMode: 'bypassPermissions', startedAt: 1,
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
  chatReducer(initialChatState, { type: 'snapshot', state: { session, turns: [], items: [], tasks: [], mcpServers: [], usage: EMPTY_USAGE, ...partial } });

describe('chatReducer', () => {
  it('replaces the whole chat on a snapshot', () => {
    const before = chat({ turns: [turn('t1', 'user')], items: [message('m1', 1, 't1', 'old')] });
    const after = chatReducer(before, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], usage: EMPTY_USAGE } });
    expect([after.session, Object.keys(after.turns), Object.keys(after.items)]).toEqual([null, [], []]);
  });

  it('upserts turns and items from a patch by id', () => {
    const before = chat({ turns: [turn('t1', 'user', 'running')], items: [tool('b1', 1, 't1', null, 'running')] });
    const after = chatReducer(before, { type: 'patch', patch: { turns: [turn('t1', 'user')], items: [tool('b1', 1, 't1'), message('m2', 2, 't1', 'done')] } });
    expect(after.turns.t1?.closedAt).toBe(3);
    expect(Object.values(after.items).map((item) => (item.kind === 'tool' ? item.status : item.kind === 'message' ? item.text : ''))).toEqual(['ok', 'done']);
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
