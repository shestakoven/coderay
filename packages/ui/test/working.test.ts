import { describe, expect, it } from 'vitest';
import type { ChatItem, PromptStatus, SessionState, ToolStatus, TurnView } from '@ide/protocol';
import { chatReducer, initialChatState } from '../src/chat/chat-state';
import { elapsedLabel, workingState } from '../src/chat/working';

const turn = (id: string, openedAt: number, startedAt: number | null, closedAt: number | null = null): TurnView =>
  ({ id, kind: 'user', openedAt, startedAt, closedAt, resultSubtype: closedAt === null ? null : 'success' });
const tool = (id: string, seq: number, name: string, summary: string, status: ToolStatus = 'running'): ChatItem =>
  ({ kind: 'tool', id, seq, turnId: 't1', parentToolUseId: null, tool: name, summary, status, startedAt: seq, endedAt: status === 'running' ? null : seq, decision: null, targets: [] });
const prompt = (id: string, seq: number, status: PromptStatus): ChatItem =>
  ({ kind: 'prompt', id, seq, turnId: 't1', parentToolUseId: null, body: { tool: 'ExitPlanMode', plan: 'p' }, status, answer: null, ts: seq });
const chat = (partial: Partial<SessionState>) =>
  chatReducer(initialChatState, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], ...partial } });
const openTurn = [turn('t1', 100, 200)];
const labelOf = (items: ChatItem[]) => workingState(chat({ turns: openTurn, items }), null)?.label;

describe('workingState', () => {
  it('is null when no turn is open and nothing was sent', () => {
    expect(workingState(chat({}), null)).toBeNull();
  });

  it('shows the agent starting from the send time when a send has no open turn yet', () => {
    expect(workingState(chat({}), 500)).toEqual({ label: 'Starting the agent…', since: 500 });
  });

  it('is null when the only turn is closed and nothing was sent', () => {
    expect(workingState(chat({ turns: [turn('t1', 1, 2, 3)] }), null)).toBeNull();
  });

  it('counts from startedAt for an open turn', () => {
    expect(workingState(chat({ turns: openTurn }), null)).toEqual({ label: 'Thinking…', since: 200 });
  });

  it('falls back to openedAt for an open turn the agent has not started', () => {
    expect(workingState(chat({ turns: [turn('t1', 100, null)] }), null)?.since).toBe(100);
  });

  it('counts from the earliest of several open turns', () => {
    expect(workingState(chat({ turns: [turn('t1', 100, 300), turn('t2', 100, 150), turn('t3', 100, 400)] }), null)?.since).toBe(150);
  });

  it('mixes started and unstarted open turns by their effective start', () => {
    expect(workingState(chat({ turns: [turn('t1', 100, 300), turn('t2', 250, null)] }), null)?.since).toBe(250);
  });

  it('ignores closed turns when picking the start of the work', () => {
    expect(workingState(chat({ turns: [turn('t0', 1, 1, 50), turn('t1', 100, 200)] }), null)?.since).toBe(200);
  });

  it('prefers the open turn over a stale send time', () => {
    expect(workingState(chat({ turns: openTurn }), 999)?.label).toBe('Thinking…');
  });

  it('waits for the user while a prompt is pending', () => {
    expect(labelOf([prompt('p1', 1, 'pending')])).toBe('Waiting for your answer');
  });

  it.each<PromptStatus>(['answered', 'dropped'])('does not wait for the user on a %s prompt', (status) => {
    expect(labelOf([prompt('p1', 1, status)])).toBe('Thinking…');
  });

  it('names the running tool with its summary', () => {
    expect(labelOf([tool('b1', 1, 'Bash', 'npm test')])).toBe('Bash npm test');
  });

  it('shows the running tool with the highest sequence number', () => {
    expect(labelOf([tool('b2', 2, 'Read', 'two'), tool('b3', 3, 'Edit', 'three'), tool('b1', 1, 'Bash', 'one')])).toBe('Edit three');
  });

  it.each<ToolStatus>(['ok', 'error'])('ignores a tool that is not running (%s)', (status) => {
    expect(labelOf([tool('b1', 1, 'Bash', 'old'), tool('b2', 2, 'Read', 'done', status)])).toBe('Bash old');
  });

  it('shows thinking when every tool has finished', () => {
    expect(labelOf([tool('b1', 1, 'Bash', 'x', 'ok')])).toBe('Thinking…');
  });

  it('strips the mcp server prefix from a tool name', () => {
    expect(labelOf([tool('b1', 1, 'mcp__ide__read_file', 'a.ts')])).toBe('read_file a.ts');
  });

  it('strips an mcp prefix whose server name contains underscores', () => {
    expect(labelOf([tool('b1', 1, 'mcp__my_server_x__do_thing', 'now')])).toBe('do_thing now');
  });

  it('strips only the server segment when the tool name itself contains a double underscore', () => {
    expect(labelOf([tool('b1', 1, 'mcp__ide__read__file', 'a.ts')])).toBe('read__file a.ts');
  });

  it('leaves a plain tool name with underscores untouched', () => {
    expect(labelOf([tool('b1', 1, 'read_file', 'a.ts')])).toBe('read_file a.ts');
  });

  it.each(['propose_plan', 'mcp__ide__propose_plan'])('waits for plan approval on %s', (name) => {
    expect(labelOf([tool('b1', 1, name, 'the plan')])).toBe('Waiting for you to approve the plan');
  });

  it('leaves out the trailing space when the summary is empty', () => {
    expect(labelOf([tool('b1', 1, 'Bash', '')])).toBe('Bash');
  });

  it('clips a label longer than 70 characters to 70 ending in an ellipsis', () => {
    const label = labelOf([tool('b1', 1, 'Bash', 'x'.repeat(200))]);
    expect([label?.length, label?.endsWith('…'), label?.startsWith('Bash xxx')]).toEqual([70, true, true]);
  });

  it('clips a label of 71 characters', () => {
    const label = labelOf([tool('b1', 1, 'Bash', 'x'.repeat(66))]);
    expect([label?.length, label?.endsWith('…')]).toEqual([70, true]);
  });

  it('leaves a label of exactly 70 characters untouched', () => {
    const summary = 'x'.repeat(65);
    expect(labelOf([tool('b1', 1, 'Bash', summary)])).toBe(`Bash ${summary}`);
  });

  it('keeps the since of the open turn on every label', () => {
    expect(workingState(chat({ turns: openTurn, items: [tool('b1', 1, 'Bash', 'x')] }), null)?.since).toBe(200);
  });

  it('lets a pending prompt win over a running tool', () => {
    expect(labelOf([tool('b1', 1, 'Bash', 'x'), prompt('p1', 2, 'pending')])).toBe('Waiting for your answer');
  });

  it('lets a pending prompt win over a running propose_plan', () => {
    expect(labelOf([prompt('p1', 1, 'pending'), tool('b1', 2, 'propose_plan', '')])).toBe('Waiting for your answer');
  });
});

describe('elapsedLabel', () => {
  const at = (ms: number) => elapsedLabel(0, ms);

  it.each([
    [0, '0s'],
    [999, '0s'],
    [1000, '1s'],
    [59_000, '59s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [61_000, '1m 01s'],
    [69_000, '1m 09s'],
    [125_000, '2m 05s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '60m 00s'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(at(ms)).toBe(expected);
  });

  it('clamps a clock that runs backwards to 0s', () => {
    expect(elapsedLabel(5000, 1000)).toBe('0s');
  });

  it('measures from the given start, not from zero', () => {
    expect(elapsedLabel(10_000, 75_000)).toBe('1m 05s');
  });
});
