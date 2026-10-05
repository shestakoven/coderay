import { describe, expect, it } from 'vitest';
import type { TaskView, TurnView } from '@ide/protocol';
import { parseHookEvent, type AgentEvent } from '../../src/agent/hook-events';
import { TurnTracker, type Change } from '../../src/agent/tracker';
import type { MessageRecord, ToolEventRecord } from '../../src/store/store';
import { AT, CALL, CODEX_SESSION, codexHooks, SUBAGENT, type RawHook } from './codex-fixture';

const hooks = codexHooks();
const at = (index: number): RawHook => hooks[index] as RawHook;
const prompt = (index: number) => at(index).prompt as string;
const SPAWN_INPUT = at(AT.spawnStart).tool_input;

describe('the recorded Codex session', () => {
  it('holds every event of the session: a subagent, its calls, Stop, a second prompt and Esc', () => {
    expect(hooks.map((hook) => hook.hook_event_name)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse',
      'PreToolUse', 'PostToolUse', 'SubagentStop', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'Interrupt', 'SessionEnd',
    ]);
  });

  it('keeps no path of the machine it was recorded on', () => {
    expect(JSON.stringify(hooks)).not.toMatch(/\/Users\/|\/private\/|\/tmp\//);
  });
});

describe('parseHookEvent on Codex hooks', () => {
  const expected: [number, string, AgentEvent | null][] = [
    [AT.sessionStart, 'the start of the session', { type: 'conversation', claudeSessionId: CODEX_SESSION, source: 'startup' }],
    [AT.prompt, 'the prompt of the user', { type: 'prompt', text: prompt(AT.prompt), task: null }],
    [AT.bashStart, 'the start of a shell call', { type: 'tool-start', toolUseId: CALL.bash, tool: 'Bash', input: { command: 'echo hi' }, agentId: null }],
    [AT.bashEnd, 'the end of a shell call, whose output is a plain string', { type: 'tool-end', toolUseId: CALL.bash, status: 'ok', agentId: null, launched: null }],
    [AT.spawnStart, 'the start of spawn_agent', { type: 'tool-start', toolUseId: CALL.spawn, tool: 'spawn_agent', input: SPAWN_INPUT, agentId: null }],
    [AT.spawnEnd, 'the end of spawn_agent, which names the new agent in a JSON string', { type: 'tool-end', toolUseId: CALL.spawn, status: 'ok', agentId: null, launched: { id: SUBAGENT, kind: 'subagent' } }],
    [AT.subagentStart, 'the start of the subagent, with its type', { type: 'subagent-start', agentId: SUBAGENT, agentType: 'default' }],
    [AT.subagentPrompt, 'the prompt the subagent gets, which is not the user', null],
    [AT.waitStart, 'the start of waiting for the subagent, a call of the main agent', { type: 'tool-start', toolUseId: CALL.wait, tool: 'multi_agent_v1wait_agent', input: at(AT.waitStart).tool_input, agentId: null }],
    [AT.subBashStart, 'the start of a call of the subagent', { type: 'tool-start', toolUseId: CALL.subBash, tool: 'Bash', input: { command: 'echo sub' }, agentId: SUBAGENT }],
    [AT.subBashEnd, 'the end of a call of the subagent', { type: 'tool-end', toolUseId: CALL.subBash, status: 'ok', agentId: SUBAGENT, launched: null }],
    [AT.subagentStop, 'the stop of the subagent with its last message', { type: 'subagent-stop', agentId: SUBAGENT, lastMessage: 'sub done' }],
    [AT.waitEnd, 'the end of waiting, whose JSON output launches nothing', { type: 'tool-end', toolUseId: CALL.wait, status: 'ok', agentId: null, launched: null }],
    [AT.closeStart, 'the start of closing the subagent', { type: 'tool-start', toolUseId: CALL.close, tool: 'multi_agent_v1close_agent', input: at(AT.closeStart).tool_input, agentId: null }],
    [AT.closeEnd, 'the end of closing, whose JSON output launches nothing', { type: 'tool-end', toolUseId: CALL.close, status: 'ok', agentId: null, launched: null }],
    [AT.stop, 'Stop, which lists no background tasks', { type: 'turn-end', lastMessage: 'A done', failed: false, runningTaskIds: null }],
    [AT.secondPrompt, 'the second prompt', { type: 'prompt', text: prompt(AT.secondPrompt), task: null }],
    [AT.interrupt, 'Esc', { type: 'interrupted' }],
    [AT.sessionEnd, 'the end of the session, which the IDE does not follow', null],
  ];

  it.each(expected)('event %i reads %s', (index, _what, event) => {
    expect(parseHookEvent(at(index))).toEqual(event);
  });

  describe('the prompt of a subagent', () => {
    it('is not a prompt of the user, however it is worded', () => {
      expect(parseHookEvent({ ...at(AT.prompt), agent_id: SUBAGENT, agent_type: 'default' })).toBeNull();
      expect(parseHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', agent_id: 'ag1' })).toBeNull();
    });

    it('is a prompt of the user once it carries no agent_id', () => {
      expect(parseHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })).toEqual({ type: 'prompt', text: 'hello', task: null });
    });
  });

  describe('Interrupt', () => {
    it('reads as an interruption by itself', () => {
      expect(parseHookEvent({ hook_event_name: 'Interrupt' })).toEqual({ type: 'interrupted' });
    });
  });

  describe('the end of spawn_agent', () => {
    const ended = (response: unknown) =>
      parseHookEvent({ hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_input: SPAWN_INPUT, tool_use_id: CALL.spawn, tool_response: response });

    it('launches the subagent a JSON string names', () => {
      expect(ended('{"agent_id":"ag-7","nickname":"Pascal"}')).toMatchObject({ type: 'tool-end', launched: { id: 'ag-7', kind: 'subagent' } });
    });

    it.each([
      ['a string that is not JSON', 'could not spawn: no capacity'],
      ['an empty string', ''],
      ['JSON without an agent_id', '{"nickname":"Pascal"}'],
      ['JSON whose agent_id is not a string', '{"agent_id":42}'],
      ['JSON that is not an object', '["ag-7"]'],
      ['JSON null', 'null'],
      ['an object that names the agent, as claude gives them', { agent_id: 'ag-7', nickname: 'Pascal' }],
      ['no response at all', undefined],
    ])('launches nothing when the response is %s', (_what, response) => {
      expect(ended(response)).toMatchObject({ type: 'tool-end', launched: null });
    });
  });
});

function fold(events: AgentEvent[]) {
  let id = 0;
  let clock = 1000;
  const tracker = new TurnTracker({ now: () => (clock += 1), newId: () => `id${++id}` });
  const changes: Change[] = events.flatMap((event) => tracker.agentEvent(event));
  const turns = new Map<string, TurnView>();
  const messages = new Map<string, MessageRecord>();
  const tools = new Map<string, ToolEventRecord>();
  const tasks = new Map<string, TaskView>();
  for (const change of changes) {
    if (change.kind === 'turn') turns.set(change.turn.id, change.turn);
    else if (change.kind === 'message') messages.set(change.message.id, change.message);
    else if (change.kind === 'tool') tools.set(change.tool.toolUseId, change.tool);
    else if (change.kind === 'task') tasks.set(change.task.id, change.task);
  }
  return {
    tracker, turns: [...turns.values()], tasks: [...tasks.values()],
    messages: [...messages.values()].sort((a, b) => a.seq - b.seq), tools: [...tools.values()].sort((a, b) => a.seq - b.seq),
  };
}

const parsed = (from: number, to: number): AgentEvent[] => hooks.slice(from, to + 1).flatMap((hook) => parseHookEvent(hook) ?? []);

describe('the recorded Codex session, through parseHookEvent and TurnTracker', () => {
  const run = fold(parsed(0, hooks.length - 1));

  it('makes two user turns: the first a success, the second stopped with Esc', () => {
    expect(run.turns).toMatchObject([
      { kind: 'user', closedAt: expect.any(Number), resultSubtype: 'success' },
      { kind: 'user', closedAt: expect.any(Number), resultSubtype: 'error_during_execution' },
    ]);
  });

  it('leaves no turn open at the end', () => {
    expect(run.tracker.hasOpenTurn()).toBe(false);
  });

  it('ends every call as ok, the call of the subagent under spawn_agent', () => {
    expect(run.tools.map((tool) => [tool.toolUseId, tool.tool, tool.status, tool.parentToolUseId])).toEqual([
      [CALL.bash, 'Bash', 'ok', null],
      [CALL.spawn, 'spawn_agent', 'ok', null],
      [CALL.wait, 'multi_agent_v1wait_agent', 'ok', null],
      [CALL.subBash, 'Bash', 'ok', CALL.spawn],
      [CALL.close, 'multi_agent_v1close_agent', 'ok', null],
    ]);
  });

  it('makes one subagent task of spawn_agent, completed when the subagent stopped', () => {
    expect(run.tasks).toMatchObject([{ id: SUBAGENT, toolUseId: CALL.spawn, kind: 'subagent', status: 'completed', endedAt: expect.any(Number) }]);
  });

  it('shows the two prompts of the user, the subagent as a child message and the answer of the agent', () => {
    expect(run.messages.map((m) => [m.role, m.text, m.parentToolUseId])).toEqual([
      ['user', prompt(AT.prompt), null],
      ['assistant', 'sub done', CALL.spawn],
      ['assistant', 'A done', null],
      ['user', prompt(AT.secondPrompt), null],
    ]);
    expect(run.messages.find((m) => m.text === 'A done')?.turnId).toBe(run.turns[0]?.id);
  });

  it('does not show the prompt the subagent was given', () => {
    expect(run.messages.filter((m) => m.text === prompt(AT.subagentPrompt))).toEqual([]);
  });

  describe('where Codex differs from claude', () => {
    it('does not end a running task at a Stop, which lists no background tasks', () => {
      const { tasks, turns, tracker } = fold(parsed(0, AT.spawnEnd).concat(parsed(AT.stop, AT.stop)));
      expect(turns).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'success' }]);
      expect(tasks).toMatchObject([{ id: SUBAGENT, endedAt: null }]);
      expect(tracker.hasOpenTurn()).toBe(false);
    });

    it('ends the task at the stop of the subagent, not at a Stop', () => {
      const { tasks } = fold(parsed(0, AT.subagentStop));
      expect(tasks).toMatchObject([{ id: SUBAGENT, endedAt: expect.any(Number) }]);
    });

    it('places the call of the subagent under spawn_agent, and the next call of the main agent under nothing', () => {
      const { tools } = fold(parsed(0, AT.waitStart));
      expect(tools.map((tool) => [tool.toolUseId, tool.parentToolUseId])).toEqual([[CALL.bash, null], [CALL.spawn, null], [CALL.wait, null]]);
      expect(fold(parsed(0, AT.subBashStart)).tools.find((tool) => tool.toolUseId === CALL.subBash)?.parentToolUseId).toBe(CALL.spawn);
    });

    it('opens no turn for the prompt of the subagent', () => {
      expect(fold(parsed(AT.sessionStart, AT.subagentPrompt)).turns).toHaveLength(1);
    });

    it('closes the turn on Interrupt as error_during_execution', () => {
      const { turns } = fold(parsed(AT.secondPrompt, AT.interrupt));
      expect(turns).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'error_during_execution' }]);
    });

    it('starts no task when spawn_agent returns something that does not name the agent', () => {
      const bad = (response: unknown): AgentEvent[] => [
        ...parsed(AT.prompt, AT.prompt), ...parsed(AT.spawnStart, AT.spawnStart),
        ...[parseHookEvent({ ...at(AT.spawnEnd), tool_response: response })].flatMap((event) => event ?? []),
      ];
      for (const response of ['not json', '{"nickname":"Pascal"}', { agent_id: SUBAGENT }]) expect(fold(bad(response)).tasks, JSON.stringify(response)).toEqual([]);
    });
  });
});
