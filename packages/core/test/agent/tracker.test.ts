import { describe, expect, it } from 'vitest';
import type { TaskView, TurnView } from '@ide/protocol';
import type { StreamEvent } from '../../src/agent/stream';
import { TurnTracker, type Change, type TrackerOptions } from '../../src/agent/tracker';
import type { MessageRecord, PromptRecord, ToolEventRecord } from '../../src/store/store';

function tracker(options: TrackerOptions = {}): TurnTracker {
  let id = 0;
  return new TurnTracker({ now: () => 1000, newId: () => `id${++id}`, ...options });
}

const init: StreamEvent = { type: 'init', sessionId: 's1', model: 'haiku', cliVersion: '2.1.281', permissionMode: 'bypassPermissions', mcpServers: [], skills: [] };
const text = (value: string, parentToolUseId: string | null = null): StreamEvent =>
  ({ type: 'assistant', parentToolUseId, blocks: [{ kind: 'text', text: value }] });
const toolUse = (id: string, name = 'Bash', parentToolUseId: string | null = null): StreamEvent =>
  ({ type: 'assistant', parentToolUseId, blocks: [{ kind: 'tool_use', id, name, input: {} }] });
const toolResult = (toolUseId: string, body = '', isError = false): StreamEvent =>
  ({ type: 'user', parentToolUseId: null, toolResults: [{ toolUseId, isError, text: body, images: [] }] });
const result = (subtype = 'success', origin: string | null = null): StreamEvent => ({ type: 'result', subtype, origin });
const taskStarted = (taskId: string, toolUseId: string, backgrounded = true): StreamEvent =>
  ({ type: 'task_started', taskId, toolUseId, backgrounded, description: 'Create sub.txt' });
const notification = (taskId: string, toolUseId: string, status = 'completed'): StreamEvent =>
  ({ type: 'task_notification', taskId, toolUseId, status });

type Step = StreamEvent | string | ((t: TurnTracker) => Change[]);

function fold(changes: Change[]) {
  const turns = new Map<string, TurnView>();
  const messages = new Map<string, MessageRecord>();
  const tools = new Map<string, ToolEventRecord>();
  const tasks = new Map<string, TaskView>();
  const prompts = new Map<string, PromptRecord>();
  for (const change of changes) {
    if (change.kind === 'turn') turns.set(change.turn.id, change.turn);
    else if (change.kind === 'message') messages.set(change.message.id, change.message);
    else if (change.kind === 'tool') tools.set(change.tool.toolUseId, change.tool);
    else if (change.kind === 'task') tasks.set(change.task.id, change.task);
    else if (change.kind === 'prompt') prompts.set(change.prompt.requestId, change.prompt);
  }
  return { turns: [...turns.values()], messages: [...messages.values()], tools: [...tools.values()], tasks: [...tasks.values()], prompts: [...prompts.values()] };
}

const run = (t: TurnTracker, steps: Step[]) =>
  fold(steps.flatMap((step) => (typeof step === 'string' ? t.userMessage(step) : typeof step === 'function' ? step(t) : t.event(step))));

const ask = (requestId: string) => (t: TurnTracker) => t.prompt(requestId, { tool: 'ExitPlanMode', plan: '1. Create plan.txt.' });
const mode = (permissionMode: string): StreamEvent => ({ type: 'mode', permissionMode });
const modes = (changes: Change[]) => changes.flatMap((change) => (change.kind === 'mode' ? [change.permissionMode] : []));

describe('TurnTracker', () => {
  it('opens a user turn with the message, starts it at the next init and closes it at the result', () => {
    const { turns, messages } = run(tracker(), ['hi', init, text('hello'), result()]);
    expect(turns).toEqual([{ id: 'id1', kind: 'user', openedAt: 1000, startedAt: 1000, closedAt: 1000, resultSubtype: 'success' }]);
    expect(messages.map((m) => [m.role, m.text, m.turnId])).toEqual([['user', 'hi', 'id1'], ['assistant', 'hello', 'id1']]);
  });

  it('opens an agent-initiated turn at an init when no message waits', () => {
    const t = tracker();
    const { turns } = run(t, [init, text('tick'), result('success', 'task-notification')]);
    expect(turns).toMatchObject([{ kind: 'agent-initiated', resultSubtype: 'success' }]);
    expect(t.hasOpenTurn()).toBe(false);
  });

  it('counts the agent-initiated turns a monitor starts without task notifications', () => {
    const { turns } = run(tracker(), [
      'watch', init, toolUse('mon', 'Monitor'), taskStarted('task1', 'mon'), toolResult('mon', 'Monitor started'),
      { type: 'task_updated', taskId: 'task1', status: 'completed' }, notification('task1', 'mon'), result(),
      init, result('success', 'task-notification'), init, result('success', 'task-notification'), init, result('success', 'task-notification'),
    ]);
    expect(turns.map((turn) => [turn.kind, turn.closedAt !== null])).toEqual([
      ['user', true], ['agent-initiated', true], ['agent-initiated', true], ['agent-initiated', true],
    ]);
  });

  it('opens no turn at a task notification', () => {
    const t = tracker();
    run(t, [taskStarted('task1', 'agent'), notification('task1', 'agent')]);
    expect(t.hasOpenTurn()).toBe(false);
  });

  it('gives the next init to the waiting user message', () => {
    const { turns } = run(tracker(), ['first', init, result(), 'hi', init, result()]);
    expect(turns.map((turn) => [turn.kind, turn.resultSubtype])).toEqual([['user', 'success'], ['user', 'success']]);
  });

  it("corrects a turn's kind at its result from the result's origin", () => {
    const { turns } = run(tracker(), ['hi', init, result('success', 'task-notification'), init, result()]);
    expect(turns.map((turn) => turn.kind)).toEqual(['agent-initiated', 'user']);
  });

  it('opens no turn at an init that arrives while a turn is running', () => {
    const { turns } = run(tracker(), [init, init, result('success', 'task-notification')]);
    expect(turns.map((turn) => [turn.kind, turn.closedAt === null])).toEqual([['agent-initiated', false]]);
  });

  it('shows no thinking block, neither as a message nor as a tool call', () => {
    const thinking: StreamEvent = { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'thinking', text: 'why' }, { kind: 'text', text: 'ok' }] };
    const { messages, tools } = run(tracker(), ['hi', init, thinking, result()]);
    expect([messages.map((m) => m.text), tools]).toEqual([['hi', 'ok'], []]);
  });

  it('reports the skills of an init in its init change', () => {
    const changes = tracker().event({ ...init, skills: ['wiki', 'superpowers:brainstorming'] });
    expect(changes.flatMap((change) => (change.kind === 'init' ? [change.skills] : []))).toEqual([['wiki', 'superpowers:brainstorming']]);
  });

  it('reports no skills in the init change of an init without any', () => {
    expect(tracker().event(init).flatMap((change) => (change.kind === 'init' ? [change.skills] : []))).toEqual([[]]);
  });

  it('closes a waiting user turn at a result that came without an init', () => {
    const { turns } = run(tracker(), ['hi', result('error_during_execution')]);
    expect(turns).toMatchObject([{ kind: 'user', startedAt: null, resultSubtype: 'error_during_execution' }]);
  });

  it('records tool results as ok, error or rejected', () => {
    const { tools } = run(tracker(), [
      'go', init, toolUse('a'), toolUse('b'), toolUse('c'), toolUse('d'),
      toolResult('a', 'fine'), toolResult('b', 'boom', true),
      toolResult('c', "The user doesn't want to proceed with this tool use. The tool use was rejected", true),
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'd', isError: true, rejected: true, text: 'declined', images: [] }] },
    ]);
    expect(tools.map((t) => [t.toolUseId, t.status])).toEqual([['a', 'ok'], ['b', 'error'], ['c', 'rejected'], ['d', 'rejected']]);
  });

  it("closes a turn's tool calls that got no result when the turn ends", () => {
    const { tools } = run(tracker(), ['go', init, toolUse('a'), result('error_during_execution')]);
    expect(tools).toMatchObject([{ toolUseId: 'a', status: 'unfinished', endedAt: 1000 }]);
  });

  it('names a background task by the tool that started it', () => {
    const { tasks } = run(tracker(), [
      'go', init, toolUse('a', 'Agent'), toolUse('t', 'Task'), toolUse('b', 'Bash'), toolUse('m', 'Monitor'), toolUse('x', 'Other'),
      taskStarted('ta', 'a'), taskStarted('tt', 't'), taskStarted('tb', 'b'), taskStarted('tm', 'm'), taskStarted('tx', 'x'),
    ]);
    expect(tasks.map((task) => [task.id, task.kind])).toEqual([
      ['ta', 'subagent'], ['tt', 'subagent'], ['tb', 'shell'], ['tm', 'monitor'], ['tx', 'other'],
    ]);
  });

  it('ignores the task events of a foreground call', () => {
    const { tasks, messages } = run(tracker(), [
      'go', init, toolUse('b', 'Bash'), taskStarted('tb', 'b', false), notification('tb', 'b', 'stopped'),
    ]);
    expect([tasks, messages.map((m) => m.role)]).toEqual([[], ['user']]);
  });

  it('ends a background task at task_updated only with a terminal status', () => {
    const t = tracker();
    const running = run(t, [taskStarted('task1', 'agent'), { type: 'task_updated', taskId: 'task1', status: 'running' }]);
    expect(running.tasks.map((task) => task.status)).toEqual(['running']);
    const { tasks } = run(t, [{ type: 'task_updated', taskId: 'task1', status: 'killed' }]);
    expect(tasks).toMatchObject([{ id: 'task1', status: 'killed', endedAt: 1000 }]);
  });

  it('ends a background task at a task notification only with a terminal status, recorded or not', () => {
    const { tasks } = run(tracker(), [
      taskStarted('task1', 'a1'), taskStarted('task2', 'a2'), taskStarted('task3', 'a3'),
      notification('task1', 'a1', 'stopped'), notification('task2', 'a2', 'failed'), notification('task3', 'a3', 'running'),
    ]);
    expect(tasks.map((task) => [task.id, task.status])).toEqual([['task1', 'stopped'], ['task2', 'failed'], ['task3', 'running']]);
  });

  it("gives a subagent's calls no turn and closes them when the subagent's task ends", () => {
    const { tools } = run(tracker(), [
      'go', init, toolUse('agent', 'Agent'), taskStarted('task1', 'agent'), toolResult('agent'), result(),
      toolUse('sub', 'Write', 'agent'), notification('task1', 'agent'),
    ]);
    expect(tools.find((t) => t.toolUseId === 'sub')).toMatchObject({ turnId: null, parentToolUseId: 'agent', status: 'unfinished' });
  });

  it('names the finished task in the notice when task_updated ended it before the notification', () => {
    const { messages } = run(tracker(), [
      'go', init, toolUse('agent', 'Agent'), taskStarted('task1', 'agent'), result(),
      { type: 'task_updated', taskId: 'task1', status: 'completed' }, notification('task1', 'agent'),
    ]);
    expect(messages.filter((m) => m.role === 'notice').map((m) => m.text)).toEqual(['Background subagent completed: Create sub.txt']);
  });

  it('notes a task notification in the chat with the kind and description of the task', () => {
    const { messages } = run(tracker(), [toolUse('agent', 'Agent'), taskStarted('task1', 'agent'), notification('task1', 'agent')]);
    expect(messages.map((m) => [m.role, m.text, m.turnId])).toEqual([['notice', 'Background subagent completed: Create sub.txt', null]]);
  });

  it('attaches a prompt to the running turn and drops it when that turn ends unanswered', () => {
    const { prompts } = run(tracker(), ['go', init, ask('req1'), result('error_during_execution')]);
    expect(prompts).toMatchObject([{ requestId: 'req1', turnId: 'id1', status: 'dropped' }]);
  });

  it('records the answer of an answered prompt', () => {
    const { prompts } = run(tracker(), ['go', init, ask('req1'), (t) => t.promptAnswered('req1', { kind: 'allow' })]);
    expect(prompts).toMatchObject([{ status: 'answered', answer: { kind: 'allow' } }]);
  });

  it('drops a prompt that claude cancels', () => {
    const { prompts } = run(tracker(), ['go', init, ask('req1'), { type: 'control_cancel', requestId: 'req1' }]);
    expect(prompts.map((p) => p.status)).toEqual(['dropped']);
  });

  it('allows an interrupt only while a turn claude has started is running', () => {
    const t = tracker();
    run(t, ['go']);
    const beforeInit = t.canInterrupt();
    run(t, [init]);
    expect([beforeInit, t.canInterrupt()]).toEqual([false, true]);
  });

  it('reports permission mode changes and notes entering and leaving plan mode', () => {
    const t = tracker();
    const changes = ['go', init, mode('plan'), mode('plan'), mode('bypassPermissions')]
      .flatMap((step) => (typeof step === 'string' ? t.userMessage(step) : t.event(step)));
    expect(modes(changes)).toEqual(['bypassPermissions', 'plan', 'bypassPermissions']);
    expect(fold(changes).messages.filter((m) => m.role === 'notice').map((m) => m.text)).toEqual([
      'The agent entered plan mode: it explores and plans, and changes no files until you approve a plan.',
      'The agent left plan mode.',
    ]);
  });

  it('closes open turns, tool calls, tasks and prompts and clears the mode when the process exits', () => {
    const t = tracker();
    run(t, ['go', init, toolUse('agent', 'Agent'), taskStarted('task1', 'agent'), toolUse('sub', 'Write', 'agent'), ask('req1')]);
    const changes = t.processExited();
    const { turns, tools, tasks, prompts } = fold(changes);
    expect([turns.map((x) => x.resultSubtype), tools.map((x) => x.status), tasks.map((x) => x.status), prompts.map((x) => x.status)])
      .toEqual([['crashed'], ['unfinished', 'unfinished'], ['unfinished'], ['dropped']]);
    expect([t.hasOpenTurn(), modes(changes)]).toEqual([false, [null]]);
  });

  it('skips empty text blocks', () => {
    const { messages } = run(tracker(), ['go', init, text('  ')]);
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('continues sequence numbers after restored history', () => {
    expect(fold(tracker({ nextSeq: 41 }).userMessage('next')).messages[0]?.seq).toBe(41);
  });

  describe('monotonic tool stamps', () => {
    const stamped = () => {
      let mono = 100;
      return { t: tracker({ mono: () => (mono += 10) }), tick: (value: number) => { mono = value; } };
    };

    it('reports a finished call with the monotonic stamps of its tool_use and its result, and keeps the stored dates', () => {
      const { t, tick } = stamped();
      run(t, ['go', init]);
      tick(500);
      const { tools } = run(t, [toolUse('a', 'Write', 'p1')]);
      tick(900);
      const done = run(t, [toolResult('a')]);
      expect(t.endInfo('a')).toEqual({ toolUseId: 'a', tool: 'Write', parentToolUseId: 'p1', status: 'ok', toolUseAt: 510, endedAt: 910 });
      expect(tools.map((tool) => [tool.toolUseAt, tool.endedAt])).toEqual([[1000, null]]);
      expect(done.tools.map((tool) => [tool.toolUseAt, tool.endedAt])).toEqual([[1000, 1000]]);
    });

    it('hands a finished call over once', () => {
      const { t } = stamped();
      run(t, ['go', init, toolUse('a'), toolResult('a')]);
      expect(t.endInfo('a')).not.toBeNull();
      expect(t.endInfo('a')).toBeNull();
    });

    it.each([
      ['an error', toolResult('a', 'boom', true), 'error'],
      ['a rejection', toolResult('a', "The user doesn't want to proceed with this tool use. The tool use was rejected"), 'rejected'],
    ] as const)('reports %s with its status', (_name, event, status) => {
      const { t } = stamped();
      run(t, ['go', init, toolUse('a'), event]);
      expect(t.endInfo('a')?.status).toBe(status);
    });

    it('reports a call closed with its turn as unfinished, and one closed by a crash', () => {
      const { t } = stamped();
      run(t, ['go', init, toolUse('a'), toolUse('b'), result()]);
      expect([t.endInfo('a')?.status, t.endInfo('b')?.status]).toEqual(['unfinished', 'unfinished']);
      run(t, ['again', init, toolUse('c')]);
      t.processExited();
      expect(t.endInfo('c')?.status).toBe('unfinished');
    });

    it('reports a subagent call closed by its task ending', () => {
      const { t } = stamped();
      run(t, ['go', init, toolUse('agent', 'Agent'), taskStarted('task1', 'agent'), toolResult('agent'), result(), toolUse('inner', 'Bash', 'agent'),
        { type: 'task_updated', taskId: 'task1', status: 'killed' }]);
      expect(t.endInfo('inner')).toMatchObject({ status: 'unfinished', parentToolUseId: 'agent' });
    });

    it('knows nothing of a call that never ended, and stamps a restored call by its end alone', () => {
      const { t } = stamped();
      run(t, ['go', init, toolUse('a')]);
      expect(t.endInfo('a')).toBeNull();
      const restored = tracker({
        mono: () => 777,
        open: { turns: [], tasks: [], prompts: [], tools: [{ toolUseId: 'r', seq: 1, turnId: null, parentToolUseId: null, tool: 'Bash', input: {}, status: 'running', toolUseAt: 1, endedAt: null }] },
      });
      restored.processExited();
      expect(restored.endInfo('r')).toMatchObject({ toolUseAt: 777, endedAt: 777 });
    });
  });
});
