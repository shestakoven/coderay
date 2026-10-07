import { describe, expect, it } from 'vitest';
import {
  EMPTY_USAGE, type ChatItem, type GatePromptView, type PlanView, type PromptStatus, type SessionState, type SessionStatus, type SessionView, type ToolStatus,
  type TurnView,
} from '@ide/protocol';
import { chatReducer, initialChatState } from '../src/chat/chat-state';
import { planTitle } from '../src/plan/plan-state';
import { deriveStatus, noticeFor, type ProjectStatus, type StatusInput, type StatusKind } from '../src/project/project-status';

const session = (status: SessionStatus = 'running'): SessionView => ({
  id: 's1', claudeSessionId: 'c1', status, model: 'haiku', modelChoice: null, effort: null, cliVersion: '2.1.0', permissionMode: 'default', startedAt: 1,
});
const turn = (id: string, open: boolean): TurnView =>
  ({ id, kind: 'user', openedAt: 1, startedAt: 2, closedAt: open ? null : 3, resultSubtype: open ? null : 'success' });
const tool = (id: string, seq: number, startedAt: number, summary: string, status: ToolStatus = 'running', parentToolUseId: string | null = null): ChatItem =>
  ({ kind: 'tool', id, seq, turnId: 't1', parentToolUseId, tool: 'Bash', summary, status, startedAt, endedAt: status === 'running' ? null : startedAt + 1, decision: null, targets: [] });
const ask = (id: string, status: PromptStatus, questions = ['Which database?', 'Which region?']): ChatItem => ({
  kind: 'prompt', id, seq: 50, turnId: 't1', parentToolUseId: null, status, answer: null, ts: 50,
  body: { tool: 'AskUserQuestion', questions: questions.map((question) => ({ question, header: 'Q', options: [{ label: 'A', description: '' }], multiSelect: false })) },
});
const exitPlan = (id: string, status: PromptStatus): ChatItem =>
  ({ kind: 'prompt', id, seq: 51, turnId: 't1', parentToolUseId: null, body: { tool: 'ExitPlanMode', plan: '1. do it' }, status, answer: null, ts: 51 });
const chat = (partial: Partial<SessionState> = {}) =>
  chatReducer(initialChatState, { type: 'snapshot', state: { session: session(), turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: EMPTY_USAGE, ...partial } });
const busy = (items: ChatItem[] = []) => chat({ turns: [turn('t0', false), turn('t1', true)], items });
const plan = (status: PlanView['status']): PlanView => ({
  id: 'plan-1', version: 3, goal: 'Ship tabs', status, approvedBy: null, steps: [], scope: { paths: [], globs: [] }, owners: {},
  review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 1, decidedAt: null,
});
const gate = (id: string, status: GatePromptView['status'], summary: string): GatePromptView => ({
  id, toolUseId: id, parentToolUseId: null, tool: 'Write', summary, preview: { kind: 'command', command: 'rm -rf dist', truncated: false },
  reason: null, targets: [], canExpand: false, planId: null, mode: 'A', status, answer: null, ts: 1,
});
const status = (over: Partial<StatusInput> = {}): ProjectStatus =>
  deriveStatus({ connection: 'open', chat: chat(), plan: null, prompts: [], watchdog: false, ...over });

const IDLE = { kind: 'idle', line: 'Idle' };
const UNREACHABLE = { kind: 'error', line: 'The CodeRay core is not reachable' };
const CRASHED = { kind: 'error', line: 'The agent stopped unexpectedly' };
const WATCHDOG = { kind: 'attention', line: 'The watchdog needs a decision' };

describe('deriveStatus idle', () => {
  it('is idle when nothing is running or waiting', () => {
    expect(status()).toEqual(IDLE);
  });

  it('is idle after finished turns', () => {
    expect(status({ chat: chat({ turns: [turn('t1', false)], items: [tool('a', 1, 1, 'npm test', 'ok')] }) })).toEqual(IDLE);
  });

  it('is idle while the socket is still connecting', () => {
    expect(status({ connection: 'connecting' })).toEqual(IDLE);
  });

  it('is idle with no session yet', () => {
    expect(status({ chat: chat({ session: null }) })).toEqual(IDLE);
  });

  it.each(['stopped', 'ended'] as const)('is idle for a %s session', (s) => {
    expect(status({ chat: chat({ session: session(s) }) })).toEqual(IDLE);
  });
});

describe('deriveStatus error', () => {
  it('says the core is not reachable when the connection is closed', () => {
    expect(status({ connection: 'closed' })).toEqual(UNREACHABLE);
  });

  it('puts an unreachable core above every other cause', () => {
    const everything = chat({ session: session('crashed'), turns: [turn('t1', true)], items: [ask('q', 'pending'), tool('a', 1, 1, 'npm test')] });
    expect(status({ connection: 'closed', chat: everything, plan: plan('proposed'), prompts: [gate('g', 'pending', 'Write x')], watchdog: true })).toEqual(UNREACHABLE);
  });

  it('reports a crashed agent', () => {
    expect(status({ chat: chat({ session: session('crashed') }) })).toEqual(CRASHED);
  });

  it('reports an agent that refused to start', () => {
    expect(status({ chat: chat({ session: session('refused') }) })).toEqual({ kind: 'error', line: 'The agent refused to start' });
  });

  it('puts a crash above attention and work', () => {
    const crashed = chat({ session: session('crashed'), turns: [turn('t1', true)], items: [ask('q', 'pending'), tool('a', 1, 1, 'npm test')] });
    expect(status({ chat: crashed, plan: plan('proposed'), prompts: [gate('g', 'pending', 'Write x')], watchdog: true })).toEqual(CRASHED);
  });
});

describe('deriveStatus attention', () => {
  it('shows the first question of a pending AskUserQuestion', () => {
    expect(status({ chat: chat({ items: [ask('q', 'pending')] }) })).toEqual({ kind: 'attention', line: 'Which database?' });
  });

  it('asks to approve a plan the agent proposed with ExitPlanMode', () => {
    expect(status({ chat: chat({ items: [exitPlan('p', 'pending')] }) })).toEqual({ kind: 'attention', line: 'The plan is waiting for approval' });
  });

  it.each(['answered', 'dropped'] as const)('ignores a chat prompt that was %s', (s) => {
    expect(status({ chat: chat({ items: [ask('q', s), exitPlan('p', s)] }) })).toEqual(IDLE);
  });

  it('asks for a watchdog decision', () => {
    expect(status({ watchdog: true })).toEqual(WATCHDOG);
  });

  it('shows the summary of a pending gate prompt', () => {
    expect(status({ prompts: [gate('g1', 'answered', 'Old write'), gate('g2', 'pending', 'Write src/app.ts')] })).toEqual({ kind: 'attention', line: 'Write src/app.ts' });
  });

  it.each(['answered', 'dropped'] as const)('ignores a gate prompt that was %s', (s) => {
    expect(status({ prompts: [gate('g', s, 'Write x')] })).toEqual(IDLE);
  });

  it('asks to approve a proposed plan, named by its title', () => {
    const proposed = plan('proposed');
    expect(status({ plan: proposed })).toEqual({ kind: 'attention', line: `Plan waiting for approval: ${planTitle(proposed)}` });
    expect(planTitle(proposed)).toContain('v3');
  });

  it.each(['approved', 'changes-requested', 'rejected', 'withdrawn', 'superseded', 'done'] as const)('does not wait on a %s plan', (s) => {
    expect(status({ plan: plan(s) })).toEqual(IDLE);
  });

  it('puts a chat prompt first among the attention causes', () => {
    expect(status({ chat: chat({ items: [ask('q', 'pending')] }), watchdog: true, prompts: [gate('g', 'pending', 'Write x')], plan: plan('proposed') }).line).toBe('Which database?');
  });

  it('puts the watchdog before a gate prompt and a plan', () => {
    expect(status({ watchdog: true, prompts: [gate('g', 'pending', 'Write x')], plan: plan('proposed') })).toEqual(WATCHDOG);
  });

  it('puts a gate prompt before a plan', () => {
    expect(status({ prompts: [gate('g', 'pending', 'Write x')], plan: plan('proposed') }).line).toBe('Write x');
  });

  it('puts attention above a busy agent', () => {
    expect(status({ chat: busy([tool('a', 1, 1, 'npm test'), ask('q', 'pending')]) })).toEqual({ kind: 'attention', line: 'Which database?' });
    expect(status({ chat: busy([tool('a', 1, 1, 'npm test')]), plan: plan('proposed') }).kind).toBe('attention');
    expect(status({ chat: busy(), watchdog: true })).toEqual(WATCHDOG);
  });
});

describe('deriveStatus working', () => {
  it('says the agent is working when a turn is open and no tool runs', () => {
    expect(status({ chat: busy() })).toEqual({ kind: 'working', line: 'Working…' });
  });

  it('counts a turn that is open but not started yet', () => {
    const waiting: TurnView = { ...turn('t1', true), startedAt: null };
    expect(status({ chat: chat({ turns: [waiting] }) }).kind).toBe('working');
  });

  it('shows the running top-level tool that started last', () => {
    const items = [tool('late', 1, 30, 'git status'), tool('early', 2, 10, 'npm test'), tool('mid', 3, 20, 'ls')];
    expect(status({ chat: busy(items) })).toEqual({ kind: 'working', line: 'git status' });
  });

  it('ignores sub-agent tools and finished tools, even when they started later', () => {
    const items = [
      tool('top', 1, 10, 'npm test'),
      tool('sub', 2, 50, 'grep inside agent', 'running', 'task-1'),
      tool('done', 3, 60, 'already finished', 'ok'),
      tool('failed', 4, 70, 'already failed', 'error'),
    ];
    expect(status({ chat: busy(items) })).toEqual({ kind: 'working', line: 'npm test' });
  });

  it('falls back to Working… when only finished or sub-agent tools are left', () => {
    const items = [tool('sub', 1, 50, 'grep', 'running', 'task-1'), tool('done', 2, 60, 'npm test', 'ok')];
    expect(status({ chat: busy(items) })).toEqual({ kind: 'working', line: 'Working…' });
  });
});

describe('noticeFor', () => {
  const at = (kind: StatusKind, line = `line for ${kind}`): ProjectStatus => ({ kind, line });

  it('stays quiet on the first report of a project', () => {
    expect([noticeFor(undefined, at('attention'), 'shop'), noticeFor(undefined, at('error'), 'shop')]).toEqual([null, null]);
  });

  it('asks for an answer when a project starts needing one', () => {
    expect(noticeFor(at('working'), at('attention', 'Which database?'), 'shop')).toEqual({ kind: 'attention', title: 'shop needs your answer', body: 'Which database?' });
  });

  it('says the project stopped when it turns to an error', () => {
    expect(noticeFor(at('working'), at('error', 'The agent stopped unexpectedly'), 'api')).toEqual({ kind: 'error', title: 'api stopped', body: 'The agent stopped unexpectedly' });
  });

  it('says the project finished when work turns idle', () => {
    expect(noticeFor(at('working'), at('idle'), 'web')).toEqual({ kind: 'done', title: 'web finished', body: 'The agent is done.' });
  });

  it('stays quiet when only the line changes', () => {
    expect(noticeFor(at('attention', 'first question'), at('attention', 'second question'), 'shop')).toBeNull();
  });

  // Rows: previous kind; columns: next kind; cell: notice kind or null.
  const table: Record<StatusKind, Record<StatusKind, string | null>> = {
    working: { working: null, attention: 'attention', idle: 'done', error: 'error' },
    attention: { working: null, attention: null, idle: null, error: 'error' },
    idle: { working: null, attention: 'attention', idle: null, error: 'error' },
    error: { working: null, attention: 'attention', idle: null, error: null },
  };
  const cases = Object.entries(table).flatMap(([from, row]) => Object.entries(row).map(([to, kind]) => [from, to, kind] as [StatusKind, StatusKind, string | null]));

  it.each(cases)('%s -> %s gives %s', (from, to, kind) => {
    expect(noticeFor(at(from), at(to), 'p')?.kind ?? null).toBe(kind);
  });
});
