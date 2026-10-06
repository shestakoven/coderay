import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SessionError } from '../../src/agent/agent-session';
import type { ToolDecisionRecord } from '../../src/store/store';
import { transcriptPath } from '../../src/watchdog/recovery';
import { waitFor } from '../helpers';
import { interrupted, openTerminal, said, snapshot, turnThatStaysOpen, type Terminal } from './terminal-events-harness';
import { flag, terminalHarness } from './terminal-harness';

const ESC = '\x1b';
const CTRL_C = '\x03';
const quiet = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

const taskNotification = (taskId: string, toolUseId: string, status = 'completed') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "sleep 5" completed</summary>\n</task-notification>`;
const decision = (toolUseId: string, kind: ToolDecisionRecord['decision']): ToolDecisionRecord => ({
  toolUseId, decision: kind, planId: 'plan-1', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'], reason: 'IDE', decidedAt: 1,
});

// Moves the clock the session reads forward, while time still passes by itself.
function skewedClock() {
  let skew = 0;
  const real = Date.now.bind(Date);
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
  onTestFinished(() => spy.mockRestore());
  return (ms: number) => {
    skew += ms;
  };
}

// Appends the marker of Esc and then a line after it, and waits until that line was read: the marker was read before it.
async function appendMarker(t: Terminal, reached: string, marker = interrupted) {
  t.appendTranscript(marker, said(reached));
  await waitFor(() => t.messages().some((m) => m.text === reached), `the line "${reached}" after the marker`);
}

const turnClosed = (t: Terminal, index = 0) => waitFor(() => (t.turns()[index]?.closedAt ?? null) !== null, `turn ${index} closed`);

const toolResultSaying = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] } });

describe('an agent in the terminal, followed through its hooks', () => {
  describe('a prompt and the end of the turn', () => {
    it('opens a started user turn when the user submits a prompt', async () => {
      const t = await openTerminal();
      expect(t.h.session.isIdle()).toBe(true);
      expect(t.prompt('fix the login')).toBeNull();
      expect(t.turns()).toMatchObject([{ kind: 'user', closedAt: null, startedAt: expect.any(Number) }]);
      expect([t.h.session.hasOpenTurn(), t.h.session.isIdle()]).toEqual([true, false]);
    });

    it('shows the prompt as a message of the user in that turn', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      expect(t.messages()).toMatchObject([{ role: 'user', text: 'fix the login', turnId: t.turns()[0]?.id }]);
    });

    it('tells those who wait for the user that the user wrote', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      expect(t.heard.userMessages).toBe(1);
    });

    it('keeps a second prompt in the open turn instead of opening another', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.prompt('and the logout too');
      expect([t.turns().length, t.messages().map((m) => m.text)]).toEqual([1, ['fix the login', 'and the logout too']]);
      expect(t.messages().every((m) => m.turnId === t.turns()[0]?.id)).toBe(true);
    });

    it('closes the turn as a success on Stop, with the last message of the agent', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      expect(t.stop({ last_assistant_message: 'Fixed it.' })).toBeNull();
      expect(t.turns()).toMatchObject([{ kind: 'user', closedAt: expect.any(Number), resultSubtype: 'success' }]);
      expect(t.messages().map((m) => [m.role, m.text])).toEqual([['user', 'fix the login'], ['assistant', 'Fixed it.']]);
    });

    it('makes the chat idle and tells that the turn closed', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.stop();
      expect([t.h.session.hasOpenTurn(), t.h.session.isIdle(), t.heard.turnsClosed]).toEqual([false, true, 1]);
    });

    it('closes the turn as an error on StopFailure', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.send('StopFailure', { last_assistant_message: 'API Error: 529 overloaded', background_tasks: [] });
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'error' }]);
      expect([t.h.session.isIdle(), t.heard.turnsClosed]).toEqual([true, 1]);
    });

    it('does not repeat the last message when the transcript has already given it', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.appendTranscript(said('Fixed it.'));
      await waitFor(() => t.messages().some((m) => m.role === 'assistant'), 'the text from the transcript');
      t.stop({ last_assistant_message: 'Fixed it.' });
      expect(t.messages().filter((m) => m.text === 'Fixed it.')).toHaveLength(1);
    });

    it('adds the last message when it is not what the transcript gave', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.appendTranscript(said('Let me look at it.'));
      await waitFor(() => t.messages().some((m) => m.role === 'assistant'), 'the text from the transcript');
      t.stop({ last_assistant_message: 'Fixed it.' });
      expect(t.messages().map((m) => m.text)).toEqual(['fix the login', 'Let me look at it.', 'Fixed it.']);
    });

    it('shows the text the agent wrote between tool calls and gives it to the gate as the context of the next call', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.appendTranscript(said('I will edit the handler.'));
      await waitFor(() => t.messages().some((m) => m.role === 'assistant'), 'the text from the transcript');
      t.call('toolu_edit', 'Edit', { file_path: 'src/app.ts' });
      expect(t.h.session.lastMessage()).toBe('I will edit the handler.');
      expect(t.h.session.context('toolu_edit')).toEqual({ parentToolUseId: null, lastMessage: 'I will edit the handler.' });
    });

    it('keeps the turn, its messages and its tool call in the store like those of a chat', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Bash', { command: 'ls' });
      t.result('toolu_1');
      t.stop({ last_assistant_message: 'Fixed it.' });
      const history = () => t.h.store.history(t.ideId);
      await waitFor(() => history().turns.some((turn) => turn.closedAt !== null) && history().toolEvents.some((e) => e.status === 'ok'), 'the history stored');
      expect(history().turns).toMatchObject([{ kind: 'user', resultSubtype: 'success' }]);
      expect(history().messages.map((m) => [m.role, m.text])).toEqual([['user', 'fix the login'], ['assistant', 'Fixed it.']]);
      expect(history().toolEvents).toMatchObject([{ toolUseId: 'toolu_1', tool: 'Bash', status: 'ok' }]);
    });

    it('sends what changed to the UI as session patches', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      const patches = t.heard.broadcasts.filter((message) => message.type === 'session.patch');
      expect(patches.length).toBeGreaterThan(0);
      expect(patches.some((patch) => JSON.stringify(patch).includes('fix the login'))).toBe(true);
    });
  });

  describe('tool calls', () => {
    it('shows a call as running when it starts, with its tool, in the open turn', async () => {
      const t = await openTerminal();
      t.prompt('list the files');
      t.call('toolu_1', 'Bash', { command: 'ls' });
      expect(t.tool('toolu_1')).toMatchObject({ kind: 'tool', tool: 'Bash', status: 'running', endedAt: null, turnId: t.turns()[0]?.id, parentToolUseId: null });
    });

    it('ends a call as ok on PostToolUse and tells with the status', async () => {
      const t = await openTerminal();
      t.prompt('list the files');
      t.call('toolu_1', 'Bash', { command: 'ls' });
      expect(t.result('toolu_1', 'Bash', { stdout: 'a' })).toBeNull();
      expect(t.tool('toolu_1')).toMatchObject({ status: 'ok', endedAt: expect.any(Number) });
      expect(t.heard.toolResults).toMatchObject([{ toolUseId: 'toolu_1', tool: 'Bash', status: 'ok', parentToolUseId: null }]);
    });

    it('ends a call as an error on PostToolUseFailure and tells with the status', async () => {
      const t = await openTerminal();
      t.prompt('list the files');
      t.call('toolu_1', 'Bash', { command: 'false' });
      t.result('toolu_1', 'Bash', {}, { error: 'Exit code 1' }, 'PostToolUseFailure');
      expect(t.tool('toolu_1')).toMatchObject({ status: 'error' });
      expect(t.heard.toolResults).toMatchObject([{ toolUseId: 'toolu_1', status: 'error' }]);
    });

    it('keeps a call the gate allowed running until its result', async () => {
      const t = await openTerminal();
      t.prompt('list the files');
      t.call('toolu_1', 'Bash');
      t.h.session.recordDecision(decision('toolu_1', 'allow'));
      expect(t.tool('toolu_1')).toMatchObject({ status: 'running', decision: expect.anything() });
      expect(t.heard.toolResults).toEqual([]);
    });

    it.each(['deny', 'ask-denied'] as const)('ends a call the gate decided %s as rejected, though claude reports no result for it', async (kind) => {
      const t = await openTerminal();
      t.prompt('write the file');
      t.call('toolu_w', 'Write', { file_path: 'src/x.ts', content: 'x' });
      t.h.session.recordDecision(decision('toolu_w', kind));
      expect(t.tool('toolu_w')).toMatchObject({ status: 'rejected', endedAt: expect.any(Number) });
      expect(t.heard.toolResults).toMatchObject([{ toolUseId: 'toolu_w', tool: 'Write', status: 'rejected' }]);
    });

    it('does not end the turn by itself when its last call was rejected', async () => {
      const t = await openTerminal();
      t.prompt('write the file');
      t.call('toolu_w', 'Write');
      t.h.session.recordDecision(decision('toolu_w', 'deny'));
      expect(t.h.session.hasOpenTurn()).toBe(true);
      t.stop();
      expect(t.h.session.hasOpenTurn()).toBe(false);
    });
  });

  describe('subagents', () => {
    it('places the calls of a background subagent under its Agent call', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.startAgent('toolu_agent', 'ag1');
      t.call('toolu_read', 'Read', { file_path: 'a.ts' }, { agent_id: 'ag1', agent_type: 'general-purpose' });
      expect(t.tool('toolu_read')).toMatchObject({ parentToolUseId: 'toolu_agent' });
      t.result('toolu_read', 'Read', {}, { agent_id: 'ag1', agent_type: 'general-purpose' });
      expect(t.heard.toolResults).toMatchObject([{ toolUseId: 'toolu_agent' }, { toolUseId: 'toolu_read', parentToolUseId: 'toolu_agent' }]);
    });

    it('leaves the calls of the agent itself without a parent while a subagent works', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.startAgent('toolu_agent', 'ag1');
      t.call('toolu_own', 'Bash');
      expect(t.tool('toolu_own')).toMatchObject({ parentToolUseId: null });
    });

    it('places the calls of a foreground subagent under the Agent call it started from', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.call('toolu_fg', 'Agent', { description: 'd', prompt: 'p' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.call('toolu_grep', 'Grep', { pattern: 'x' }, { agent_id: 'ag2', agent_type: 'Explore' });
      expect(t.tool('toolu_grep')).toMatchObject({ parentToolUseId: 'toolu_fg' });
    });

    it('gives each of two foreground subagents its own Agent call, the oldest first', async () => {
      const t = await openTerminal();
      t.prompt('research it twice');
      t.call('toolu_a', 'Agent', { description: 'a', prompt: 'p' });
      t.call('toolu_b', 'Agent', { description: 'b', prompt: 'p' });
      t.send('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.call('toolu_x', 'Read', {}, { agent_id: 'ag1', agent_type: 'Explore' });
      t.call('toolu_y', 'Read', {}, { agent_id: 'ag2', agent_type: 'Explore' });
      expect([t.tool('toolu_x')?.parentToolUseId, t.tool('toolu_y')?.parentToolUseId]).toEqual(['toolu_a', 'toolu_b']);
    });

    it('gives a subagent the Agent call that asked for its type, though an older call of another type waits', async () => {
      const t = await openTerminal();
      t.prompt('research it twice');
      t.call('toolu_a', 'Agent', { description: 'a', prompt: 'p', subagent_type: 'Explore' });
      t.call('toolu_b', 'Agent', { description: 'b', prompt: 'p', subagent_type: 'general-purpose' });
      t.send('SubagentStart', { agent_id: 'ag1', agent_type: 'general-purpose' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.call('toolu_x', 'Read', {}, { agent_id: 'ag1', agent_type: 'general-purpose' });
      t.call('toolu_y', 'Read', {}, { agent_id: 'ag2', agent_type: 'Explore' });
      expect([t.tool('toolu_x')?.parentToolUseId, t.tool('toolu_y')?.parentToolUseId]).toEqual(['toolu_b', 'toolu_a']);
    });

    it('shows the last message of each of two parallel subagents under its own Agent call', async () => {
      const t = await openTerminal();
      t.prompt('research it twice');
      t.call('toolu_a', 'Agent', { description: 'a', prompt: 'p', subagent_type: 'Explore' });
      t.call('toolu_b', 'Agent', { description: 'b', prompt: 'p', subagent_type: 'Plan' });
      t.send('SubagentStart', { agent_id: 'ag1', agent_type: 'Plan' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.send('SubagentStop', { agent_id: 'ag1', agent_type: 'Plan', last_assistant_message: 'The plan.' });
      t.send('SubagentStop', { agent_id: 'ag2', agent_type: 'Explore', last_assistant_message: 'It is in src/app.ts.' });
      expect(t.messages().filter((m) => m.role === 'assistant').map((m) => [m.text, m.parentToolUseId])).toEqual([['The plan.', 'toolu_b'], ['It is in src/app.ts.', 'toolu_a']]);
    });

    it('shows the last message of a subagent as a message under its Agent call', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.call('toolu_fg', 'Agent', { description: 'd', prompt: 'p' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.send('SubagentStop', { agent_id: 'ag2', agent_type: 'Explore', last_assistant_message: 'It is in src/app.ts.' });
      expect(t.messages().filter((m) => m.role === 'assistant')).toMatchObject([{ text: 'It is in src/app.ts.', parentToolUseId: 'toolu_fg' }]);
    });

    it.each(['SubagentStart', 'SubagentStop'])('ignores the internal agent that reports %s without a type', async (name) => {
      const t = await openTerminal();
      t.prompt('research it');
      t.call('toolu_fg', 'Agent', { description: 'd', prompt: 'p' });
      const before = snapshot(t);
      t.send(name, { agent_id: 'internal-title', agent_type: '', last_assistant_message: 'Fix the login' });
      expect(snapshot(t)).toBe(before);
    });

    it('does not let an internal agent take the Agent call of a real subagent', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.call('toolu_fg', 'Agent', { description: 'd', prompt: 'p' });
      t.send('SubagentStart', { agent_id: 'internal-title', agent_type: '' });
      t.send('SubagentStart', { agent_id: 'ag2', agent_type: 'Explore' });
      t.call('toolu_grep', 'Grep', {}, { agent_id: 'ag2', agent_type: 'Explore' });
      expect(t.tool('toolu_grep')).toMatchObject({ parentToolUseId: 'toolu_fg' });
    });
  });

  describe('background tasks', () => {
    it('starts a shell task when a Bash call goes to the background', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      expect(t.tasks()).toMatchObject([{ id: 'bg1', toolUseId: 'toolu_sh', kind: 'shell', endedAt: null }]);
      expect([t.h.session.runningShell(), t.h.session.runningSubagents()]).toEqual([true, 0]);
    });

    it('starts a subagent task when an Agent call goes to the background', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.startAgent('toolu_ag', 'ag1');
      expect(t.tasks()).toMatchObject([{ id: 'ag1', toolUseId: 'toolu_ag', kind: 'subagent', endedAt: null }]);
      expect([t.h.session.runningShell(), t.h.session.runningSubagents()]).toEqual([false, 1]);
    });

    it('starts no task for a call that stays in the foreground', async () => {
      const t = await openTerminal();
      t.prompt('list the files');
      t.call('toolu_1', 'Bash', { command: 'ls' });
      t.result('toolu_1', 'Bash', { stdout: 'a' });
      expect([t.tasks(), t.h.session.runningShell()]).toEqual([[], false]);
    });

    it('does not count the chat idle after the turn closed while a task still runs', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running' }] });
      expect([t.h.session.hasOpenTurn(), t.h.session.isIdle(), t.tasks()[0]?.endedAt]).toEqual([false, false, null]);
    });

    it('ends a task on the notification claude gives the agent, and opens an agent-initiated turn for it', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running' }] });
      t.prompt(taskNotification('bg1', 'toolu_sh'));
      expect(t.tasks()).toMatchObject([{ id: 'bg1', endedAt: expect.any(Number) }]);
      expect(t.heard.taskEnds).toEqual(['toolu_sh']);
      expect(t.turns()).toMatchObject([{ kind: 'user', closedAt: expect.any(Number) }, { kind: 'agent-initiated', closedAt: null, startedAt: expect.any(Number) }]);
      expect(t.h.session.hasOpenTurn()).toBe(true);
    });

    it('says in the chat that the background task completed', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running' }] });
      t.prompt(taskNotification('bg1', 'toolu_sh'));
      expect(t.notices().filter((text) => /Background/.test(text) && /completed/.test(text))).toHaveLength(1);
    });

    it('does not take the notification for something the user wrote', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running' }] });
      const before = t.heard.userMessages;
      t.prompt(taskNotification('bg1', 'toolu_sh'));
      expect(t.heard.userMessages).toBe(before);
      expect(t.messages().some((m) => m.text.includes('<task-notification>'))).toBe(false);
    });

    it('ends a background subagent when it stops', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.startAgent('toolu_ag', 'ag1');
      t.send('SubagentStart', { agent_id: 'ag1', agent_type: 'general-purpose' });
      t.send('SubagentStop', { agent_id: 'ag1', agent_type: 'general-purpose', last_assistant_message: 'done' });
      expect(t.tasks()).toMatchObject([{ id: 'ag1', endedAt: expect.any(Number) }]);
      expect([t.heard.taskEnds, t.h.session.runningSubagents()]).toEqual([['toolu_ag'], 0]);
    });

    it('ends the tasks a Stop no longer lists and keeps those it still lists', async () => {
      const t = await openTerminal();
      t.prompt('start two servers');
      t.startShell('toolu_a', 'bg1');
      t.startShell('toolu_b', 'bg2');
      t.stop({ background_tasks: [{ id: 'bg2', type: 'local_bash', status: 'running' }] });
      expect(t.tasks().map((task) => [task.id, task.endedAt === null])).toEqual([['bg1', false], ['bg2', true]]);
      expect(t.heard.taskEnds).toEqual(['toolu_a']);
      expect([t.h.session.runningShell(), t.h.session.isIdle()]).toEqual([true, false]);
    });

    it('ends a background subagent that a Stop no longer lists', async () => {
      const t = await openTerminal();
      t.prompt('research it');
      t.startAgent('toolu_ag', 'ag1');
      t.stop({ background_tasks: [] });
      expect([t.heard.taskEnds, t.h.session.runningSubagents(), t.h.session.isIdle()]).toEqual([['toolu_ag'], 0, true]);
    });

    it('tells that a task ended once, however many Stops follow', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [] });
      t.prompt('anything else?');
      t.stop({ background_tasks: [] });
      expect(t.heard.taskEnds).toEqual(['toolu_sh']);
    });

    it('does not end a task when a Stop does not list the background tasks at all', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.send('Stop', { last_assistant_message: 'Done.', stop_hook_active: false });
      expect([t.tasks()[0]?.endedAt, t.heard.taskEnds]).toEqual([null, []]);
    });
  });

  describe('Esc', () => {
    const typed = (t: Terminal, key = ESC) => t.h.session.terminalTyped(key);

    it.each([['Esc', ESC], ['Ctrl+C', CTRL_C]])('closes the open turn as interrupted when the transcript says the user stopped it after %s was typed in the terminal', async (_name, key) => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t, key);
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'error_during_execution' }]);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([false, 1]);
    });

    it('closes an agent-initiated turn the same way', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.stop({ background_tasks: [{ id: 'bg1', type: 'local_bash', status: 'running' }] });
      t.prompt(taskNotification('bg1', 'toolu_sh'));
      typed(t);
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns().every((turn) => turn.closedAt !== null), 'every turn closed');
      expect(t.turns().map((turn) => [turn.kind, turn.resultSubtype])).toEqual([['user', 'success'], ['agent-initiated', 'error_during_execution']]);
      expect(t.heard.interrupts).toBe(1);
    });

    it('closes the call of the turn that was still running as the turn closes', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      t.call('toolu_run', 'Bash', { command: 'make' });
      typed(t);
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.tool('toolu_run')).toMatchObject({ status: 'unfinished' });
    });

    it('changes nothing for a marker that no Esc or Ctrl+C typed in the terminal came before', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      await appendMarker(t, 'read up to here');
      expect(t.turns()).toMatchObject([{ closedAt: null }]);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('keeps the turn open for a marker that comes more than 5 s after the key', async () => {
      const pass = skewedClock();
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      pass(6000);
      await appendMarker(t, 'read up to here');
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('closes the turn for a marker that comes within 5 s of the key', async () => {
      const pass = skewedClock();
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      pass(4000);
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.heard.interrupts).toBe(1);
    });

    it('lets a later key renew the 5 s the marker may take', async () => {
      const pass = skewedClock();
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      pass(4000);
      typed(t, CTRL_C);
      pass(4000);
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.heard.interrupts).toBe(1);
    });

    it('lets one key confirm one interrupt: a second marker after the same key changes nothing', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      t.appendTranscript(interrupted);
      await turnClosed(t);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([false, 1]);
      t.prompt('and now the other thing');
      await appendMarker(t, 'second marker read');
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 1]);
    });

    it('confirms an interrupt again after another key', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      t.appendTranscript(interrupted);
      await turnClosed(t);
      t.prompt('and now the other thing');
      typed(t, CTRL_C);
      t.appendTranscript(interrupted);
      await turnClosed(t, 1);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([false, 2]);
    });

    it.each([['an arrow key', '\x1b[A'], ['text', 'hello'], ['Alt+Enter', '\x1b\r'], ['text that ends in Esc', 'a\x1b'], ['two Ctrl+C at once', '\x03\x03'], ['nothing', '']])(
      'does not take %s typed in the terminal for the key',
      async (_name, data) => {
        const t = await openTerminal();
        t.prompt('refactor everything');
        typed(t, data);
        await appendMarker(t, 'read up to here');
        expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
      },
    );

    it('tells nobody about an interrupt when no turn is open, whatever was typed', async () => {
      const t = await openTerminal();
      t.send('SessionStart', { source: 'startup' });
      typed(t);
      t.appendTranscript(interrupted);
      await quiet(600);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts, t.turns()]).toEqual([false, 0, []]);
    });

    it('does not take the output of a tool that starts with the marker for Esc, even right after the key', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      await appendMarker(t, 'read up to here', toolResultSaying('[Request interrupted by user] is what the log says.'));
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('leaves the key for the real marker when the output of a tool only looked like one', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      await appendMarker(t, 'read up to here', toolResultSaying('[Request interrupted by user] is what the log says.'));
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.heard.interrupts).toBe(1);
    });

    it('does not take a plain message of the agent for Esc, even right after the key', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      t.appendTranscript(said('[Request interrupted by user] is what the log says.'));
      await waitFor(() => t.messages().some((m) => m.role === 'assistant'), 'the text from the transcript');
      await quiet(300);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('does not count a marker in the lines of a subagent', async () => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      typed(t);
      await appendMarker(t, 'read up to here', JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('forgets a key typed before the terminal closed, so the terminal opened anew does not confirm with it', async () => {
      const t = await openTerminal();
      typed(t);
      t.h.session.terminalClosed();
      expect(await t.h.session.terminalLaunch()).not.toBeNull();
      const claudeId = t.state().session?.claudeSessionId as string;
      t.h.session.hookEvent(t.ideId, { ...t.raw('UserPromptSubmit', { prompt: 'again' }), session_id: claudeId });
      await appendMarker(t, 'read up to here');
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });
  });

  describe('which events count', () => {
    it('ignores the hook events of another conversation, such as the headless check of the hooks', async () => {
      const t = await openTerminal();
      const before = snapshot(t);
      const other = { session_id: 'some-other-conversation' };
      expect(t.send('UserPromptSubmit', { prompt: 'hello', ...other })).toBeNull();
      t.send('Stop', { last_assistant_message: 'x', background_tasks: [], ...other });
      t.send('SubagentStart', { agent_id: 'ag9', agent_type: 'Explore', ...other });
      t.call('toolu_o', 'Bash', {}, other);
      expect([snapshot(t), t.heard.userMessages]).toEqual([before, 0]);
    });

    it('does not let an event of another conversation close the turn of this one', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.send('Stop', { last_assistant_message: 'x', background_tasks: [], session_id: 'some-other-conversation' });
      expect(t.h.session.hasOpenTurn()).toBe(true);
    });

    describe("a SessionStart, which only the terminal's own claude sends", () => {
      const SOURCES = ['startup', 'resume', 'clear', 'compact'];

      it.each(SOURCES)('moves the chat to the conversation a SessionStart after %s names', async (source) => {
        const t = await openTerminal();
        t.send('SessionStart', { source, session_id: 'other-conversation' });
        expect(t.state().session?.claudeSessionId).toBe('other-conversation');
        expect(t.h.store.session(t.ideId)?.claudeSessionId).toBe('other-conversation');
      });

      it.each(SOURCES)('counts the new conversation as not started after %s, though the old one had a transcript', async (source) => {
        const t = await openTerminal();
        const file = transcriptPath(t.h.transcriptsDir, t.h.root, t.claudeId);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${said('hello')}\n`);
        t.h.session.terminalClosed();
        expect(t.h.store.session(t.ideId)?.conversationStarted).toBe(true);
        expect(await t.h.session.terminalLaunch()).not.toBeNull();
        t.h.session.hookEvent(t.ideId, { ...t.raw('SessionStart', { source }), session_id: 'moved-conversation' });
        expect(t.state().session?.claudeSessionId).toBe('moved-conversation');
        expect(t.h.store.session(t.ideId)).toMatchObject({ claudeSessionId: 'moved-conversation', conversationStarted: false });
      });

      it.each([['clear', 'The conversation was cleared in the terminal'], ['resume', 'The terminal switched to another conversation']])(
        'tells in the chat that the conversation changed when the SessionStart comes after %s',
        async (source, text) => {
          const t = await openTerminal();
          t.send('SessionStart', { source, session_id: 'other-conversation' });
          expect(t.notices().filter((notice) => notice.startsWith(text))).toHaveLength(1);
        },
      );

      it.each(['startup', 'compact'])('says nothing in the chat when the conversation changes after %s', async (source) => {
        const t = await openTerminal();
        const before = t.notices();
        t.send('SessionStart', { source, session_id: 'other-conversation' });
        expect(t.notices()).toEqual(before);
      });

      it.each(SOURCES)('changes nothing for a SessionStart after %s of the conversation the chat is already in', async (source) => {
        const t = await openTerminal();
        const before = snapshot(t);
        expect(t.send('SessionStart', { source })).toBeNull();
        expect([snapshot(t), t.notices(), t.state().session?.claudeSessionId]).toEqual([before, [], t.claudeId]);
      });

      it.each(SOURCES)('counts the events of the new conversation after %s and not those of the old one', async (source) => {
        const t = await openTerminal();
        t.send('SessionStart', { source, session_id: 'new-conversation' });
        t.prompt('from the old conversation');
        t.call('toolu_old', 'Bash');
        expect([t.turns(), t.tool('toolu_old')]).toEqual([[], undefined]);
        t.send('UserPromptSubmit', { prompt: 'from the new one', session_id: 'new-conversation' });
        t.stop({ last_assistant_message: 'x' });
        expect([t.messages().map((m) => m.text), t.h.session.hasOpenTurn()]).toEqual([['from the new one'], true]);
        t.send('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [], session_id: 'new-conversation' });
        expect(t.h.session.hasOpenTurn()).toBe(false);
      });

      it('stops counting the new conversation once another one starts', async () => {
        const t = await openTerminal();
        t.send('SessionStart', { source: 'clear', session_id: 'first-new' });
        t.send('SessionStart', { source: 'resume', session_id: 'second-new' });
        t.send('UserPromptSubmit', { prompt: 'from the first new one', session_id: 'first-new' });
        t.send('UserPromptSubmit', { prompt: 'from the second new one', session_id: 'second-new' });
        expect(t.messages().map((m) => m.text)).toEqual(['from the second new one']);
      });

      it('goes on with the new conversation when the terminal is opened again', async () => {
        const t = await openTerminal();
        t.send('SessionStart', { source: 'resume', session_id: 'other-conversation' });
        t.h.session.terminalClosed();
        const launch = await t.h.session.terminalLaunch();
        expect([flag(launch?.args, '--session-id'), launch?.args.includes('--resume')]).toEqual(['other-conversation', false]);
      });

      it('ignores a SessionStart while no terminal is open', async () => {
        const t = await openTerminal();
        t.h.session.terminalClosed();
        t.send('SessionStart', { source: 'clear', session_id: 'other-conversation' });
        expect([t.state().session?.claudeSessionId, t.notices()]).toEqual([t.claudeId, []]);
      });

      it('ignores a SessionStart that names another IDE session', async () => {
        const t = await openTerminal();
        t.h.session.hookEvent('another-ide-session', t.raw('SessionStart', { source: 'clear', session_id: 'other-conversation' }));
        expect([t.state().session?.claudeSessionId, t.notices()]).toEqual([t.claudeId, []]);
      });

      it('follows the transcript the new conversation names, and no longer the old one', async () => {
        const t = await openTerminal();
        const next = join(t.h.transcriptsDir, 'next.jsonl');
        writeFileSync(next, '');
        t.prompt('refactor everything');
        t.send('SessionStart', { source: 'clear', session_id: 'new-conversation', transcript_path: next });
        t.send('UserPromptSubmit', { prompt: 'the new one', session_id: 'new-conversation', transcript_path: next });
        t.h.session.terminalTyped(ESC);
        appendFileSync(t.transcript, `${said('from the old transcript')}\n`);
        appendFileSync(next, `${interrupted}\n`);
        await turnClosed(t, 0);
        await quiet(300);
        expect(t.messages().map((m) => m.text)).not.toContain('from the old transcript');
        expect(t.turns().at(-1)).toMatchObject({ resultSubtype: 'error_during_execution' });
      });

      it('counts an Esc written to the old transcript just before /clear, though the poll did not see it yet', async () => {
        const t = await openTerminal();
        const next = join(t.h.transcriptsDir, 'next.jsonl');
        writeFileSync(next, '');
        t.prompt('refactor everything');
        t.h.session.terminalTyped(ESC);
        appendFileSync(t.transcript, `${interrupted}\n`);
        t.send('SessionStart', { source: 'clear', session_id: 'new-conversation', transcript_path: next });
        expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'error_during_execution' }]);
        expect(t.heard.interrupts).toBe(1);
      });
    });

    it('answers null and changes nothing for an event that names another IDE session', async () => {
      const t = await openTerminal();
      const before = snapshot(t);
      expect(t.h.session.hookEvent('another-ide-session', t.raw('UserPromptSubmit', { prompt: 'hello' }))).toBeNull();
      expect([snapshot(t), t.heard.userMessages]).toEqual([before, 0]);
    });

    it('answers null to such an event even when a note waits for the agent', async () => {
      const t = await openTerminal();
      t.h.session.queueNote('remember this');
      expect(t.h.session.hookEvent('another-ide-session', t.raw('UserPromptSubmit', { prompt: 'hello' }))).toBeNull();
    });

    it('answers null and changes nothing while no terminal is open', async () => {
      const t = await openTerminal();
      t.h.session.terminalClosed();
      const before = snapshot(t);
      expect(t.prompt('hello')).toBeNull();
      t.call('toolu_late', 'Bash');
      expect([snapshot(t), t.heard.userMessages]).toEqual([before, 0]);
    });

    it('answers null and changes nothing before any terminal was opened', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const ideId = h.session.sessionId() ?? 'none';
      const before = JSON.stringify(h.session.state());
      expect(h.session.hookEvent(ideId, { hook_event_name: 'UserPromptSubmit', session_id: 'any', prompt: 'hello' })).toBeNull();
      h.session.toolCalled({ hook_event_name: 'PreToolUse', session_id: 'any', tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_x' });
      expect(JSON.stringify(h.session.state())).toBe(before);
    });

    it.each([['Notification', { message: 'x' }], ['PreCompact', {}], ['SomethingNew', {}]])('answers null and changes nothing for a %s, which the IDE does not follow', async (name, fields) => {
      const t = await openTerminal();
      t.prompt('fix the login');
      const before = snapshot(t);
      expect(t.send(name, fields)).toBeNull();
      expect(snapshot(t)).toBe(before);
    });
  });

  describe('the notes of the watchdog', () => {
    it('returns an absorbed note to the agent with its next PostToolUse', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Read');
      t.h.session.sendAbsorbed('stay inside src/auth');
      expect(t.result('toolu_1', 'Read')).toEqual({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('stay inside src/auth') },
      });
    });

    it('returns an absorbed note with the next PostToolUseFailure when the call failed', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Bash');
      t.h.session.sendAbsorbed('stay inside src/auth');
      expect(t.result('toolu_1', 'Bash', {}, { error: 'Exit code 1' }, 'PostToolUseFailure')).toEqual({
        hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: expect.stringContaining('stay inside src/auth') },
      });
    });

    it('gives an absorbed note once', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Read');
      t.call('toolu_2', 'Read');
      t.h.session.sendAbsorbed('stay inside src/auth');
      expect(t.result('toolu_1', 'Read')).not.toBeNull();
      expect(t.result('toolu_2', 'Read')).toBeNull();
    });

    describe('while a subagent works', () => {
      const SUB = { agent_id: 'ag1', agent_type: 'Explore' };
      const withSubagent = async () => {
        const t = await openTerminal();
        t.prompt('research it');
        t.call('toolu_main', 'Read');
        t.call('toolu_fg', 'Agent', { description: 'd', prompt: 'p' });
        t.send('SubagentStart', SUB);
        t.call('toolu_sub', 'Grep', {}, SUB);
        t.h.session.sendAbsorbed('stay inside src/auth');
        return t;
      };

      it("leaves an absorbed note queued when a subagent's tool step ends", async () => {
        const t = await withSubagent();
        expect(t.result('toolu_sub', 'Grep', {}, SUB)).toBeNull();
      });

      it("leaves an absorbed note queued when a subagent's tool step fails", async () => {
        const t = await withSubagent();
        expect(t.result('toolu_sub', 'Grep', {}, { ...SUB, error: 'no such file' }, 'PostToolUseFailure')).toBeNull();
      });

      it('returns the note with the next tool step of the agent itself, after steps of the subagent passed', async () => {
        const t = await withSubagent();
        t.result('toolu_sub', 'Grep', {}, SUB);
        expect(t.result('toolu_main', 'Read')).toEqual({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('stay inside src/auth') },
        });
      });

      it('returns the note with a failed tool step of the agent itself', async () => {
        const t = await withSubagent();
        t.result('toolu_sub', 'Grep', {}, SUB);
        expect(t.result('toolu_main', 'Read', {}, { error: 'no such file' }, 'PostToolUseFailure')).toEqual({
          hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: expect.stringContaining('stay inside src/auth') },
        });
      });

      it("still blocks the Stop for a note that a subagent's tool step did not carry", async () => {
        const t = await withSubagent();
        t.result('toolu_sub', 'Grep', {}, SUB);
        expect(t.stop()).toEqual({ decision: 'block', reason: expect.stringContaining('stay inside src/auth') });
      });

      it('gives the note once: the tool step of the agent that carried it leaves none for the next', async () => {
        const t = await withSubagent();
        t.result('toolu_sub', 'Grep', {}, SUB);
        expect(t.result('toolu_main', 'Read')).not.toBeNull();
        t.call('toolu_main2', 'Read');
        expect(t.result('toolu_main2', 'Read')).toBeNull();
      });
    });

    it('adds nothing to a PostToolUse while no note waits', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Read');
      expect(t.result('toolu_1', 'Read')).toBeNull();
    });

    it('refuses an absorbed note when no turn is open', async () => {
      const t = await openTerminal();
      expect(() => t.h.session.sendAbsorbed('stay inside src/auth')).toThrow(new SessionError('no-turn'));
      t.prompt('fix the login');
      t.stop();
      expect(() => t.h.session.sendAbsorbed('stay inside src/auth')).toThrow(new SessionError('no-turn'));
    });

    it('blocks the Stop that comes before a tool step could carry an absorbed note, and keeps the turn open', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.h.session.sendAbsorbed('stay inside src/auth');
      expect(t.stop()).toEqual({ decision: 'block', reason: expect.stringContaining('stay inside src/auth') });
      expect(t.h.session.hasOpenTurn()).toBe(true);
      expect(t.turns()).toMatchObject([{ closedAt: null }]);
      expect(t.heard.turnsClosed).toBe(0);
    });

    it('blocks only once: the next Stop closes the turn', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.h.session.sendAbsorbed('stay inside src/auth');
      t.stop();
      expect(t.stop({ stop_hook_active: true, last_assistant_message: 'Stayed inside.' })).toBeNull();
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'success' }]);
      expect([t.h.session.isIdle(), t.heard.turnsClosed]).toEqual([true, 1]);
    });

    it('lets a StopFailure end the turn as an error even when a note waits, since claude takes no answer from it', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.h.session.sendAbsorbed('stay inside src/auth');
      expect(t.send('StopFailure', { last_assistant_message: 'API Error: 529', background_tasks: [] })).toBeNull();
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'error' }]);
    });

    it('lets a Stop through when no note waits', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      expect(t.stop()).toBeNull();
      expect(t.h.session.hasOpenTurn()).toBe(false);
    });

    it('does not block a Stop for a note a tool step already carried', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Read');
      t.h.session.sendAbsorbed('stay inside src/auth');
      t.result('toolu_1', 'Read');
      expect(t.stop()).toBeNull();
      expect(t.h.session.hasOpenTurn()).toBe(false);
    });

    it('returns a queued note with the next prompt of the user and shows it in the chat', async () => {
      const t = await openTerminal();
      t.h.session.queueNote('the build is red');
      expect(t.prompt('continue')).toEqual({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('the build is red') },
      });
      expect(t.notices().some((text) => text.includes('the build is red'))).toBe(true);
    });

    it('gives a queued note once', async () => {
      const t = await openTerminal();
      t.h.session.queueNote('the build is red');
      t.prompt('continue');
      t.stop();
      expect(t.prompt('and now?')).toBeNull();
    });

    it('adds nothing to a prompt while no note is queued', async () => {
      const t = await openTerminal();
      expect(t.prompt('continue')).toBeNull();
    });

    it('does not use a queued note for a Stop or a tool result', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.call('toolu_1', 'Read');
      t.h.session.queueNote('the build is red');
      expect(t.result('toolu_1', 'Read')).toBeNull();
      expect(t.stop()).toBeNull();
    });
  });

  describe('the way to the agent in the terminal', () => {
    it('never types a message of the IDE into the terminal, which belongs to the user', async () => {
      const t = await openTerminal();
      t.h.session.send('please check the tests', { fromUser: false });
      await quiet(300);
      expect(t.h.input).toEqual([]);
    });

    it('gives a message of the IDE to the agent with the next prompt of the user, and shows it in the chat', async () => {
      const t = await openTerminal();
      t.h.session.send('please check the tests', { fromUser: false });
      expect(t.prompt('continue')).toEqual({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('please check the tests') },
      });
      expect(t.notices().some((text) => text.includes('please check the tests'))).toBe(true);
    });

    it('gives a message of the IDE once', async () => {
      const t = await openTerminal();
      t.h.session.send('please check the tests', { fromUser: false });
      t.prompt('continue');
      t.stop();
      expect(t.prompt('and now?')).toBeNull();
    });

    it('still tells that the user wrote when a message of the IDE goes with the prompt', async () => {
      const t = await openTerminal();
      t.h.session.send('please check the tests', { fromUser: false });
      t.prompt('continue');
      expect(t.heard.userMessages).toBe(1);
    });

    it('does not let the IDE put images into the terminal either', async () => {
      const t = await openTerminal();
      expect(() => t.h.session.send('look', { fromUser: false, images: [{ mediaType: 'image/gif', data: 'R0lG' }] })).toThrow(new SessionError('in-terminal'));
      expect(t.h.input).toEqual([]);
    });

    it('does not let the user send a message to the chat while the terminal is open', async () => {
      const t = await openTerminal();
      expect(() => t.h.session.send('hello')).toThrow(new SessionError('in-terminal'));
      expect(() => t.h.session.send('hello', { fromUser: true })).toThrow(new SessionError('in-terminal'));
      expect(t.h.input).toEqual([]);
    });

    it.each(['stop', 'interrupt'] as const)('types Esc into the terminal on %s while a turn runs', async (method) => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      expect(t.h.session[method]()).toBe(true);
      expect(t.h.input.join('')).toBe(ESC);
    });

    it.each(['stop', 'interrupt'] as const)('does not tell those who watch for interruptions when %s types Esc, since claude has not confirmed it', async (method) => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      t.h.session[method]();
      expect([t.heard.interrupts, t.h.session.hasOpenTurn()]).toEqual([0, true]);
    });

    it.each(['stop', 'interrupt'] as const)('counts the Esc %s typed as the key, so the marker claude writes closes the turn and is heard once', async (method) => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      t.h.session[method]();
      t.appendTranscript(interrupted);
      await waitFor(() => t.turns()[0]?.closedAt !== null, 'the turn closed');
      expect(t.turns()).toMatchObject([{ resultSubtype: 'error_during_execution' }]);
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([false, 1]);
    });

    it.each(['stop', 'interrupt'] as const)('lets the Esc of %s confirm one marker only', async (method) => {
      const t = await openTerminal();
      t.prompt('refactor everything');
      t.h.session[method]();
      t.appendTranscript(interrupted);
      await turnClosed(t);
      t.prompt('and now the other thing');
      await appendMarker(t, 'second marker read');
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 1]);
    });

    it.each(['stop', 'interrupt'] as const)('types nothing on %s when no turn runs', async (method) => {
      const t = await openTerminal();
      expect(t.h.session[method]()).toBe(false);
      t.prompt('refactor everything');
      t.stop();
      expect(t.h.session[method]()).toBe(false);
      expect([t.h.input, t.heard.interrupts]).toEqual([[], 0]);
    });

    it.each(['stop', 'interrupt'] as const)('does not count %s, which typed nothing because no turn ran, as a key for a marker', async (method) => {
      const t = await openTerminal();
      t.h.session[method]();
      t.prompt('refactor everything');
      await appendMarker(t, 'read up to here');
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([true, 0]);
    });

    it('counts the agent as alive while the terminal is open and not after it closed', async () => {
      const t = await openTerminal();
      expect(t.h.session.processAlive()).toBe(true);
      t.h.session.terminalClosed();
      expect(t.h.session.processAlive()).toBe(false);
    });
  });

  describe('when the terminal closes', () => {
    it('ends the open turn, call and task as when the claude of a chat exits', async () => {
      const t = await openTerminal();
      t.prompt('start the server');
      t.startShell('toolu_sh', 'bg1');
      t.call('toolu_run', 'Bash', { command: 'make' });
      t.h.session.terminalClosed();
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number) }]);
      expect(t.tool('toolu_run')).toMatchObject({ status: 'unfinished' });
      expect(t.tasks()).toMatchObject([{ id: 'bg1', endedAt: expect.any(Number) }]);
      expect([t.h.session.hasOpenTurn(), t.h.session.isIdle(), t.h.session.runningShell()]).toEqual([false, true, false]);
    });

    it('stops following the transcript, which the chat resumed on the same conversation goes on to write', async () => {
      const t = await openTerminal(turnThatStaysOpen());
      t.prompt('refactor everything');
      t.h.session.terminalClosed();
      t.h.session.send('and now from the chat');
      await waitFor(() => t.turns().some((turn) => turn.closedAt === null && turn.startedAt !== null), 'the turn of the chat running');
      const before = snapshot(t);
      t.appendTranscript(said('A line of the chat, not of the terminal.'), interrupted);
      await quiet(800);
      expect(t.turns().filter((turn) => turn.closedAt === null)).toHaveLength(1);
      expect([snapshot(t), t.heard.interrupts]).toEqual([before, 0]);
    });

    it('forgets a note that waited for the agent, so a terminal opened anew does not carry it', async () => {
      const t = await openTerminal();
      t.prompt('fix the login');
      t.h.session.sendAbsorbed('stay inside src/auth');
      t.h.session.terminalClosed();
      expect(await t.h.session.terminalLaunch()).not.toBeNull();
      expect(t.h.session.hookEvent(t.ideId, t.raw('UserPromptSubmit', { prompt: 'again' }))).toBeNull();
      expect(t.h.session.hookEvent(t.ideId, t.raw('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [] }))).toBeNull();
    });

    it('follows the agent again when a terminal is opened anew', async () => {
      const t = await openTerminal();
      t.h.session.terminalClosed();
      expect(await t.h.session.terminalLaunch()).not.toBeNull();
      const claudeId = t.state().session?.claudeSessionId as string;
      t.h.session.hookEvent(t.ideId, { ...t.raw('UserPromptSubmit', { prompt: 'again' }), session_id: claudeId });
      expect(t.messages().map((m) => m.text)).toEqual(['again']);
    });
  });
});
