import { describe, expect, it } from 'vitest';
import type { TaskView, TurnView } from '@ide/protocol';
import type { AgentEvent, TaskNotice } from '../../src/agent/hook-events';
import { TurnTracker, type Change } from '../../src/agent/tracker';
import type { MessageRecord, ToolEventRecord } from '../../src/store/store';

function tracker(): TurnTracker {
  let id = 0;
  let clock = 1000;
  return new TurnTracker({ now: () => (clock += 1), newId: () => `id${++id}` });
}

const prompt = (text: string, task: TaskNotice | null = null): AgentEvent => ({ type: 'prompt', text, task });
const toolStart = (toolUseId: string, tool = 'Bash', agentId: string | null = null, input: unknown = {}): AgentEvent => ({ type: 'tool-start', toolUseId, tool, input, agentId });
const subagentStart = (agentId: string, agentType = 'general-purpose'): AgentEvent => ({ type: 'subagent-start', agentId, agentType });
const toolEnd = (toolUseId: string, status: 'ok' | 'error' = 'ok', agentId: string | null = null, launched: { id: string; kind: 'shell' | 'subagent' } | null = null): AgentEvent =>
  ({ type: 'tool-end', toolUseId, status, agentId, launched });
const turnEnd = (lastMessage: string | null = 'Done.', options: { failed?: boolean; running?: string[] | null } = {}): AgentEvent =>
  ({ type: 'turn-end', lastMessage, failed: options.failed ?? false, runningTaskIds: options.running === undefined ? [] : options.running });
const said = (text: string): AgentEvent => ({ type: 'assistant-text', text });
const notice = (taskId: string, toolUseId: string | null, status = 'completed'): TaskNotice => ({ taskId, toolUseId, status });

function feed(t: TurnTracker, events: AgentEvent[]) {
  const turns = new Map<string, TurnView>();
  const messages = new Map<string, MessageRecord>();
  const tools = new Map<string, ToolEventRecord>();
  const tasks = new Map<string, TaskView>();
  const all: Change[] = events.flatMap((event) => t.agentEvent(event));
  for (const change of all) {
    if (change.kind === 'turn') turns.set(change.turn.id, change.turn);
    else if (change.kind === 'message') messages.set(change.message.id, change.message);
    else if (change.kind === 'tool') tools.set(change.tool.toolUseId, change.tool);
    else if (change.kind === 'task') tasks.set(change.task.id, change.task);
  }
  return { changes: all, turns: [...turns.values()], messages: [...messages.values()], tools: [...tools.values()], tasks: [...tasks.values()] };
}

describe('TurnTracker.agentEvent', () => {
  describe('turns', () => {
    it('opens a started user turn at a prompt, with the prompt as a user message', () => {
      const t = tracker();
      const { turns, messages } = feed(t, [prompt('fix the login')]);
      expect(turns).toMatchObject([{ id: 'id1', kind: 'user', closedAt: null, startedAt: expect.any(Number), resultSubtype: null }]);
      expect(messages).toMatchObject([{ role: 'user', text: 'fix the login', turnId: 'id1' }]);
      expect(t.hasOpenTurn()).toBe(true);
    });

    it('keeps a prompt that comes while a turn is open in that turn', () => {
      const { turns, messages } = feed(tracker(), [prompt('fix the login'), prompt('and the logout')]);
      expect(turns).toHaveLength(1);
      expect(messages.map((m) => [m.role, m.text, m.turnId])).toEqual([['user', 'fix the login', 'id1'], ['user', 'and the logout', 'id1']]);
    });

    it('closes the turn as a success at the end of the turn, with the last message of the agent', () => {
      const t = tracker();
      const { turns, messages } = feed(t, [prompt('fix'), turnEnd('Fixed it.')]);
      expect(turns).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'success' }]);
      expect(messages.map((m) => [m.role, m.text])).toEqual([['user', 'fix'], ['assistant', 'Fixed it.']]);
      expect(t.hasOpenTurn()).toBe(false);
    });

    it('closes the turn as an error when the turn failed', () => {
      expect(feed(tracker(), [prompt('fix'), turnEnd('API Error', { failed: true })]).turns).toMatchObject([{ resultSubtype: 'error' }]);
    });

    it('opens a new turn for a prompt after the turn closed', () => {
      const { turns } = feed(tracker(), [prompt('one'), turnEnd(), prompt('two')]);
      expect(turns.map((turn) => turn.closedAt !== null)).toEqual([true, false]);
      expect(new Set(turns.map((turn) => turn.id)).size).toBe(2);
    });

    it('puts the text between tool calls into the open turn', () => {
      const { messages } = feed(tracker(), [prompt('fix'), said('Let me look.')]);
      expect(messages.map((m) => [m.role, m.text, m.turnId])).toEqual([['user', 'fix', 'id1'], ['assistant', 'Let me look.', 'id1']]);
    });

    it('does not repeat the last message when the text between calls was just that', () => {
      const { messages } = feed(tracker(), [prompt('fix'), said('Fixed it.'), turnEnd('Fixed it.')]);
      expect(messages.filter((m) => m.text === 'Fixed it.')).toHaveLength(1);
    });

    it('adds the last message when the text before it was another', () => {
      const { messages } = feed(tracker(), [prompt('fix'), said('Let me look.'), turnEnd('Fixed it.')]);
      expect(messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Let me look.', 'Fixed it.']);
    });

    it('adds no message for a turn that ends without a last message', () => {
      const { messages } = feed(tracker(), [prompt('fix'), turnEnd(null)]);
      expect(messages.map((m) => m.role)).toEqual(['user']);
    });
  });

  describe('tool calls', () => {
    it('starts a running call in the open turn and ends it with the status the hook reported', () => {
      const t = tracker();
      const started = feed(t, [prompt('go'), toolStart('toolu_1', 'Bash')]);
      expect(started.tools).toMatchObject([{ toolUseId: 'toolu_1', tool: 'Bash', status: 'running', turnId: 'id1', parentToolUseId: null, endedAt: null }]);
      expect(feed(t, [toolEnd('toolu_1', 'ok')]).tools).toMatchObject([{ toolUseId: 'toolu_1', status: 'ok', endedAt: expect.any(Number) }]);
    });

    it('ends a failed call as an error', () => {
      const t = tracker();
      feed(t, [prompt('go'), toolStart('toolu_1')]);
      expect(feed(t, [toolEnd('toolu_1', 'error')]).tools).toMatchObject([{ status: 'error' }]);
    });

    it('tells how a call ended, once it ended', () => {
      const t = tracker();
      feed(t, [prompt('go'), toolStart('toolu_1', 'Read')]);
      expect(t.endInfo('toolu_1')).toBeNull();
      feed(t, [toolEnd('toolu_1')]);
      expect(t.endInfo('toolu_1')).toMatchObject({ toolUseId: 'toolu_1', tool: 'Read', status: 'ok', parentToolUseId: null });
    });

    it('ends a rejected call as rejected', () => {
      const t = tracker();
      feed(t, [prompt('go'), toolStart('toolu_1', 'Write')]);
      const changes = t.toolRejected('toolu_1');
      expect(changes).toMatchObject([{ kind: 'tool', tool: { toolUseId: 'toolu_1', status: 'rejected', endedAt: expect.any(Number) } }]);
      expect(t.endInfo('toolu_1')).toMatchObject({ status: 'rejected' });
    });
  });

  describe('subagents', () => {
    it('places the calls of a background subagent under its Agent call', () => {
      const { tools } = feed(tracker(), [
        prompt('go'), toolStart('toolu_ag', 'Agent'), toolEnd('toolu_ag', 'ok', null, { id: 'ag1', kind: 'subagent' }), toolStart('toolu_r', 'Read', 'ag1'),
      ]);
      expect(tools.find((tool) => tool.toolUseId === 'toolu_r')).toMatchObject({ parentToolUseId: 'toolu_ag' });
    });

    const parentsOf = (tools: { toolUseId: string; parentToolUseId: string | null }[], ids: string[]) =>
      ids.map((id) => tools.find((tool) => tool.toolUseId === id)?.parentToolUseId);

    it('places the calls of a foreground subagent under the Agent call it started from', () => {
      const { tools } = feed(tracker(), [prompt('go'), toolStart('toolu_a', 'Agent'), subagentStart('ag1'), toolStart('toolu_x', 'Read', 'ag1')]);
      expect(parentsOf(tools, ['toolu_x'])).toEqual(['toolu_a']);
    });

    it('places the calls of parallel foreground subagents under the Agent calls in the order of the calls', () => {
      const { tools } = feed(tracker(), [
        prompt('go'), toolStart('toolu_a', 'Agent'), toolStart('toolu_b', 'Agent'), toolStart('toolu_c', 'Agent'),
        subagentStart('ag1'), subagentStart('ag2'), subagentStart('ag3'),
        toolStart('toolu_x', 'Read', 'ag1'), toolStart('toolu_y', 'Read', 'ag2'), toolStart('toolu_z', 'Read', 'ag3'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y', 'toolu_z'])).toEqual(['toolu_a', 'toolu_b', 'toolu_c']);
    });

    it('gives a subagent the oldest Agent call of its type, though an older call of another type waits', () => {
      const { tools } = feed(tracker(), [
        prompt('go'),
        toolStart('toolu_a', 'Agent', null, { subagent_type: 'Explore' }), toolStart('toolu_b', 'Agent', null, { subagent_type: 'general-purpose' }),
        subagentStart('ag1', 'general-purpose'), subagentStart('ag2', 'Explore'),
        toolStart('toolu_x', 'Read', 'ag1'), toolStart('toolu_y', 'Read', 'ag2'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y'])).toEqual(['toolu_b', 'toolu_a']);
    });

    it('gives two subagents of one type their calls oldest first', () => {
      const { tools } = feed(tracker(), [
        prompt('go'),
        toolStart('toolu_a', 'Agent', null, { subagent_type: 'Explore' }), toolStart('toolu_b', 'Agent', null, { subagent_type: 'Explore' }),
        subagentStart('ag1', 'Explore'), subagentStart('ag2', 'Explore'),
        toolStart('toolu_x', 'Read', 'ag1'), toolStart('toolu_y', 'Read', 'ag2'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y'])).toEqual(['toolu_a', 'toolu_b']);
    });

    it('gives a subagent the oldest free call when no call names its type', () => {
      const { tools } = feed(tracker(), [
        prompt('go'),
        toolStart('toolu_a', 'Agent', null, { subagent_type: 'Explore' }), toolStart('toolu_b', 'Agent', null, { description: 'no type' }),
        subagentStart('ag1', 'Plan'), subagentStart('ag2', 'Plan'),
        toolStart('toolu_x', 'Read', 'ag1'), toolStart('toolu_y', 'Read', 'ag2'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y'])).toEqual(['toolu_a', 'toolu_b']);
    });

    it('skips a call that already has a subagent, whatever its type', () => {
      const { tools } = feed(tracker(), [
        prompt('go'),
        toolStart('toolu_a', 'Agent', null, { subagent_type: 'Explore' }), toolStart('toolu_b', 'Agent', null, { subagent_type: 'Explore' }),
        subagentStart('ag1', 'Explore'), subagentStart('ag2', 'general-purpose'),
        toolStart('toolu_x', 'Read', 'ag1'), toolStart('toolu_y', 'Read', 'ag2'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y'])).toEqual(['toolu_a', 'toolu_b']);
    });

    it('pairs a subagent with a Task call as it does with an Agent call', () => {
      const { tools } = feed(tracker(), [
        prompt('go'), toolStart('toolu_a', 'Task', null, { subagent_type: 'Explore' }), toolStart('toolu_b', 'Task', null, { subagent_type: 'Plan' }),
        subagentStart('ag1', 'Plan'), toolStart('toolu_x', 'Read', 'ag1'),
      ]);
      expect(parentsOf(tools, ['toolu_x'])).toEqual(['toolu_b']);
    });

    it('pairs a subagent only with a call that starts one, not with another tool whose input names the same type', () => {
      const { tools } = feed(tracker(), [
        prompt('go'), toolStart('toolu_r', 'Read', null, { subagent_type: 'Explore' }), toolStart('toolu_a', 'Agent', null, { subagent_type: 'Plan' }),
        subagentStart('ag1', 'Explore'), toolStart('toolu_x', 'Read', 'ag1'),
      ]);
      expect(parentsOf(tools, ['toolu_x'])).toEqual(['toolu_a']);
    });

    it('does not pair the same subagent twice when its start is reported again', () => {
      const { tools } = feed(tracker(), [
        prompt('go'), toolStart('toolu_a', 'Agent'), toolStart('toolu_b', 'Agent'),
        subagentStart('ag1'), subagentStart('ag1'), toolStart('toolu_x', 'Read', 'ag1'),
        subagentStart('ag2'), toolStart('toolu_y', 'Read', 'ag2'),
      ]);
      expect(parentsOf(tools, ['toolu_x', 'toolu_y'])).toEqual(['toolu_a', 'toolu_b']);
    });

    it('keeps the parent of a subagent call when it ends', () => {
      const t = tracker();
      feed(t, [prompt('go'), toolStart('toolu_a', 'Agent'), subagentStart('ag1'), toolStart('toolu_x', 'Read', 'ag1'), toolEnd('toolu_x', 'ok', 'ag1')]);
      expect(t.endInfo('toolu_x')).toMatchObject({ parentToolUseId: 'toolu_a' });
    });

    it('shows the last message of a subagent under its Agent call', () => {
      const { messages } = feed(tracker(), [
        prompt('go'), toolStart('toolu_a', 'Agent'), subagentStart('ag1'), { type: 'subagent-stop', agentId: 'ag1', lastMessage: 'Found it.' },
      ]);
      expect(messages.filter((m) => m.role === 'assistant')).toMatchObject([{ text: 'Found it.', parentToolUseId: 'toolu_a' }]);
    });

    it('shows no message for a subagent that stopped without one', () => {
      const { messages } = feed(tracker(), [
        prompt('go'), toolStart('toolu_a', 'Agent'), subagentStart('ag1'), { type: 'subagent-stop', agentId: 'ag1', lastMessage: null },
      ]);
      expect(messages.filter((m) => m.role === 'assistant')).toEqual([]);
    });
  });

  describe('background tasks', () => {
    const launchShell = [prompt('go'), toolStart('toolu_sh'), toolEnd('toolu_sh', 'ok', null, { id: 'bg1', kind: 'shell' })];

    it('starts a task for the call that went to the background', () => {
      expect(feed(tracker(), launchShell).tasks).toMatchObject([{ id: 'bg1', toolUseId: 'toolu_sh', kind: 'shell', endedAt: null }]);
      const { tasks } = feed(tracker(), [prompt('go'), toolStart('toolu_ag', 'Agent'), toolEnd('toolu_ag', 'ok', null, { id: 'ag1', kind: 'subagent' })]);
      expect(tasks).toMatchObject([{ id: 'ag1', toolUseId: 'toolu_ag', kind: 'subagent', endedAt: null }]);
    });

    it('starts no task for a call that ended in the foreground', () => {
      expect(feed(tracker(), [prompt('go'), toolStart('toolu_1'), toolEnd('toolu_1')]).tasks).toEqual([]);
    });

    it('ends the task a notification names, and opens an agent-initiated turn for it', () => {
      const t = tracker();
      feed(t, [...launchShell, turnEnd('Started.', { running: ['bg1'] })]);
      const { tasks, turns } = feed(t, [prompt('<task-notification>', notice('bg1', 'toolu_sh'))]);
      expect(tasks).toMatchObject([{ id: 'bg1', endedAt: expect.any(Number) }]);
      expect(turns).toMatchObject([{ kind: 'agent-initiated', closedAt: null, startedAt: expect.any(Number) }]);
      expect(t.hasOpenTurn()).toBe(true);
    });

    it('does not show the notification as a message of the user', () => {
      const t = tracker();
      feed(t, [...launchShell, turnEnd('Started.', { running: ['bg1'] })]);
      const { messages } = feed(t, [prompt('<task-notification>', notice('bg1', 'toolu_sh'))]);
      expect(messages.filter((m) => m.role === 'user')).toEqual([]);
    });

    it('ends a background subagent when it stops', () => {
      const t = tracker();
      feed(t, [prompt('go'), toolStart('toolu_ag', 'Agent'), toolEnd('toolu_ag', 'ok', null, { id: 'ag1', kind: 'subagent' }), subagentStart('ag1')]);
      expect(feed(t, [{ type: 'subagent-stop', agentId: 'ag1', lastMessage: null }]).tasks).toMatchObject([{ id: 'ag1', endedAt: expect.any(Number) }]);
    });

    it('ends the tasks the end of a turn no longer lists, and only those', () => {
      const t = tracker();
      feed(t, [
        prompt('go'), toolStart('toolu_a'), toolEnd('toolu_a', 'ok', null, { id: 'bg1', kind: 'shell' }), toolStart('toolu_b'), toolEnd('toolu_b', 'ok', null, { id: 'bg2', kind: 'shell' }),
      ]);
      const { tasks } = feed(t, [turnEnd('Done.', { running: ['bg2'] })]);
      expect(tasks.map((task) => [task.id, task.endedAt !== null])).toEqual([['bg1', true]]);
    });

    it('leaves the tasks alone when the end of a turn does not list them', () => {
      const t = tracker();
      feed(t, launchShell);
      expect(feed(t, [turnEnd('Done.', { running: null })]).tasks).toEqual([]);
    });
  });

  describe('interruptions and exits', () => {
    it('closes the open turn as interrupted on Esc', () => {
      const t = tracker();
      feed(t, [prompt('go')]);
      expect(feed(t, [{ type: 'interrupted' }]).turns).toMatchObject([{ id: 'id1', closedAt: expect.any(Number), resultSubtype: 'error_during_execution' }]);
      expect(t.hasOpenTurn()).toBe(false);
    });

    it('closes every open turn on Esc, not only some of them', () => {
      const t = tracker();
      t.userMessage('first');
      t.userMessage('second');
      t.userMessage('third');
      const closed = feed(t, [{ type: 'interrupted' }]).turns;
      expect(closed).toHaveLength(3);
      expect(closed.every((turn) => turn.resultSubtype === 'error_during_execution')).toBe(true);
      expect(t.hasOpenTurn()).toBe(false);
    });

    it('changes nothing on Esc when no turn is open', () => {
      expect(feed(tracker(), [{ type: 'interrupted' }]).changes).toEqual([]);
    });

    it('ends the open turn, call and task when the process is gone', () => {
      const t = tracker();
      feed(t, [...[prompt('go'), toolStart('toolu_sh'), toolEnd('toolu_sh', 'ok', null, { id: 'bg1', kind: 'shell' })], toolStart('toolu_run')]);
      const changes = t.processExited();
      expect(changes).toContainEqual(expect.objectContaining({ kind: 'turn' }));
      expect(changes).toContainEqual({ kind: 'tool', tool: expect.objectContaining({ toolUseId: 'toolu_run', status: 'unfinished' }) });
      expect(changes).toContainEqual({ kind: 'task', task: expect.objectContaining({ id: 'bg1', endedAt: expect.any(Number) }) });
      expect(t.hasOpenTurn()).toBe(false);
    });
  });
});
