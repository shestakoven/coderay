import { describe, expect, it } from 'vitest';
import type { ChatItem, EventResolution, HistoryView, MessageItem, ToolItem, ToolStatus, WatchdogEventView } from '@ide/protocol';
import type { ReviewItem, ReviewSection } from '../src/history/review-model';
import { contextOf, hasContext, type ReviewContext } from '../src/history/review-context';

const file = (o: Partial<ReviewItem> = {}): ReviewItem => ({
  path: 'src/a.ts', ids: ['c1'], before: 'b', after: 'a', added: 0, removed: 0,
  toolUseIds: [], eventIds: [], reverted: false, revertId: null, renamedFrom: null, ...o,
});
const section = (o: Partial<ReviewSection> = {}): ReviewSection => ({
  key: 'p1/a', title: 'Add API', outOfPlan: false, summary: null, added: 0, removed: 0, files: [],
  planId: 'p1', stepKey: 'a', rationale: null, stepNo: null, stepTotal: 0, ...o,
});
const outside = (o: Partial<ReviewSection> = {}): ReviewSection => section({ key: 'outside', title: 'Outside the plan', outOfPlan: true, planId: null, stepKey: null, ...o });
const external = (o: Partial<ReviewSection> = {}): ReviewSection => section({ key: 'external', title: 'External changes', planId: null, stepKey: null, ...o });
const event = (o: Partial<WatchdogEventView> = {}): WatchdogEventView => ({
  id: 'e1', kind: 'watchdog', mode: 'B', phase: 'resolved', resolution: 'kept', changes: [], toolCalls: [],
  interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: false, snapshotSha: null,
  canExpand: false, defaultAction: null, reason: null, ts: 10, resolvedAt: null, ...o,
});
const history = (...events: WatchdogEventView[]): HistoryView => ({ changes: [], events, reverts: [], checkpoints: [], gateEvents: [], summaries: [] });
const tool = (id: string, o: Partial<ToolItem> = {}): ToolItem => ({
  id, seq: 1, turnId: null, parentToolUseId: null, kind: 'tool', tool: 'Edit', summary: 'Edit src/a.ts', status: 'ok',
  startedAt: 1, endedAt: 2, decision: null, targets: [], ...o,
});
const message = (id: string): MessageItem => ({ id, seq: 1, turnId: null, parentToolUseId: null, kind: 'message', role: 'assistant', text: 'hi', ts: 1 });
const chat = (...items: ChatItem[]): Record<string, ChatItem | undefined> => Object.fromEntries(items.map((item) => [item.id, item]));
const call = (toolUseId: string, o: { tool?: string; summary?: string } = {}) => ({ toolUseId, tool: o.tool ?? 'Write', summary: o.summary ?? `Write ${toolUseId}`, stepKey: null });
const ctx = (s: ReviewSection, f: ReviewItem, h: HistoryView = history(), items: Record<string, ChatItem | undefined> = {}): ReviewContext => contextOf(s, f, h, items);

describe('contextOf title', () => {
  it('is "Outside the plan" for an out-of-plan section', () => {
    expect(ctx(outside({ title: 'Anything else' }), file()).title).toBe('Outside the plan');
  });

  it('is "Changed outside the agent" for the external section', () => {
    expect(ctx(external(), file()).title).toBe('Changed outside the agent');
  });

  it('names the step number, the plan length and the step title', () => {
    expect(ctx(section({ stepNo: 2, stepTotal: 5, title: 'Add API' }), file()).title).toBe('Step 2 of 5 · Add API');
  });

  it('names the first of a one-step plan', () => {
    expect(ctx(section({ stepNo: 1, stepTotal: 1, title: 'Only' }), file()).title).toBe('Step 1 of 1 · Only');
  });

  it('is the plain section title when the step has no number', () => {
    expect(ctx(section({ stepNo: null, title: 'Some group' }), file()).title).toBe('Some group');
  });
});

describe('contextOf rationale and summary', () => {
  it('passes the step rationale through', () => {
    expect(ctx(section({ rationale: 'Because of X' }), file()).rationale).toBe('Because of X');
  });

  it('has no rationale when the section has none', () => {
    expect(ctx(section({ rationale: null }), file()).rationale).toBeNull();
  });

  it('has no summary when the section has none', () => {
    expect(ctx(section({ summary: null }), file()).summary).toBeNull();
  });

  it('mirrors a finished summary', () => {
    const summary = { key: 'k', scope: 'step' as const, ref: 'p1/a', text: 'Added the API', pending: false };
    expect(ctx(section({ summary }), file()).summary).toEqual({ text: 'Added the API', pending: false });
  });

  it('mirrors a summary that is still being written', () => {
    const summary = { key: 'k', scope: 'step' as const, ref: 'p1/a', text: null, pending: true };
    expect(ctx(section({ summary }), file()).summary).toEqual({ text: null, pending: true });
  });
});

describe('contextOf reason', () => {
  it('is null for an ordinary step section', () => {
    expect(ctx(section(), file()).reason).toBeNull();
  });

  it('is null for an ordinary step section even when an event matches', () => {
    expect(ctx(section(), file({ eventIds: ['e1'] }), history(event({ kind: 'fail-open', unknownOrigin: true }))).reason).toBeNull();
  });

  it('explains in plain words that an external change did not come from the agent', () => {
    const reason = ctx(external(), file()).reason;
    expect(reason).toMatch(/agent/i);
    expect(reason!.length).toBeGreaterThan(20);
  });

  it('gives an external change one explanation whatever events exist', () => {
    const plain = ctx(external(), file()).reason;
    const withEvent = ctx(external(), file({ eventIds: ['e1'] }), history(event({ kind: 'fail-open', unknownOrigin: true }))).reason;
    expect(withEvent).toBe(plain);
  });

  it('says that no plan step lists the file for an out-of-plan change', () => {
    const reason = ctx(outside(), file()).reason!;
    expect(reason).toMatch(/no step/i);
    expect(reason).toMatch(/plan/i);
  });

  it('does not mention the guard or an unknown origin without such an event', () => {
    const reason = ctx(outside(), file({ eventIds: ['e1'] }), history(event({ kind: 'watchdog', unknownOrigin: false }))).reason!;
    expect(reason).not.toMatch(/guard/i);
    expect(reason).not.toMatch(/unknown/i);
  });

  it('adds that the write guard was not running for a fail-open event', () => {
    const base = ctx(outside(), file()).reason!;
    const reason = ctx(outside(), file({ eventIds: ['e1'] }), history(event({ kind: 'fail-open' }))).reason!;
    expect(reason).toMatch(/guard/i);
    expect(reason).not.toMatch(/unknown/i);
    expect(reason.startsWith(base)).toBe(true);
    expect(reason.length).toBeGreaterThan(base.length);
  });

  it('adds that the author is unknown when the origin of the change is unknown', () => {
    const reason = ctx(outside(), file({ eventIds: ['e1'] }), history(event({ unknownOrigin: true }))).reason!;
    expect(reason).toMatch(/unknown/i);
    expect(reason).not.toMatch(/guard/i);
  });

  it('adds both sentences for a fail-open event with an unknown origin', () => {
    const reason = ctx(outside(), file({ eventIds: ['e1'] }), history(event({ kind: 'fail-open', unknownOrigin: true }))).reason!;
    expect(reason).toMatch(/guard/i);
    expect(reason).toMatch(/unknown/i);
  });

  it('ignores an event that does not belong to the file', () => {
    const reason = ctx(outside(), file({ eventIds: ['mine'] }), history(event({ id: 'other', kind: 'fail-open', unknownOrigin: true }))).reason!;
    expect(reason).not.toMatch(/guard/i);
    expect(reason).not.toMatch(/unknown/i);
  });

  it('uses the latest of the matching events, whatever the order in the history', () => {
    const older = event({ id: 'old', kind: 'fail-open', ts: 5 });
    const newer = event({ id: 'new', kind: 'watchdog', ts: 50 });
    for (const events of [[older, newer], [newer, older]]) {
      const reason = ctx(outside(), file({ eventIds: ['old', 'new'] }), history(...events)).reason!;
      expect(reason).not.toMatch(/guard/i);
    }
  });

  it('follows a newer fail-open event over an older plain one', () => {
    const older = event({ id: 'old', kind: 'watchdog', ts: 5 });
    const newer = event({ id: 'new', kind: 'fail-open', ts: 50 });
    for (const events of [[older, newer], [newer, older]]) {
      expect(ctx(outside(), file({ eventIds: ['old', 'new'] }), history(...events)).reason).toMatch(/guard/i);
    }
  });
});

describe('contextOf decision', () => {
  const decisionFor = (resolution: EventResolution): string | null =>
    ctx(outside(), file({ eventIds: ['e1'] }), history(event({ resolution }))).decision;
  const resolutions: EventResolution[] = ['pending', 'kept', 'reverted', 'plan-expanded', 'relabeled-human', 'flagged', 'mixed'];

  it.each(resolutions)('has a text for the resolution %s', (resolution) => {
    const text = decisionFor(resolution);
    expect(text).not.toBeNull();
    expect(text!.length).toBeGreaterThan(5);
  });

  it('uses a different text for every resolution', () => {
    const texts = resolutions.map(decisionFor);
    expect(new Set(texts).size).toBe(resolutions.length);
  });

  it('says what happened for the resolutions that have one obvious word', () => {
    expect(decisionFor('pending')).toMatch(/waiting|pending/i);
    expect(decisionFor('kept')).toMatch(/keep|kept/i);
    expect(decisionFor('reverted')).toMatch(/revert/i);
    expect(decisionFor('plan-expanded')).toMatch(/plan/i);
    expect(decisionFor('flagged')).toMatch(/flag/i);
    expect(decisionFor('mixed')).toMatch(/file by file|each file|individual/i);
  });

  it('has no text for a dropped event', () => {
    expect(decisionFor('dropped')).toBeNull();
  });

  it('is null for an out-of-plan change without a matching event', () => {
    expect(ctx(outside(), file({ eventIds: [] }), history(event({ resolution: 'kept' }))).decision).toBeNull();
    expect(ctx(outside(), file({ eventIds: ['e1'] }), history()).decision).toBeNull();
  });

  it('is null for a step section even with a matching event', () => {
    expect(ctx(section(), file({ eventIds: ['e1'] }), history(event({ resolution: 'kept' }))).decision).toBeNull();
  });

  it('is null for an external section even with a matching event', () => {
    expect(ctx(external(), file({ eventIds: ['e1'] }), history(event({ resolution: 'kept' }))).decision).toBeNull();
  });

  it('follows the latest matching event', () => {
    const older = event({ id: 'old', resolution: 'pending', ts: 1 });
    const newer = event({ id: 'new', resolution: 'reverted', ts: 2 });
    for (const events of [[older, newer], [newer, older]]) {
      expect(ctx(outside(), file({ eventIds: ['old', 'new'] }), history(...events)).decision).toBe(decisionFor('reverted'));
    }
  });
});

describe('contextOf tools', () => {
  const f = (...toolUseIds: string[]): ReviewItem => file({ toolUseIds, eventIds: ['e1'] });

  it('is empty when the file has no tool uses', () => {
    expect(ctx(section(), file({ toolUseIds: [] }), history(event({ toolCalls: [call('t1')] })), chat(tool('t1'))).tools).toEqual([]);
  });

  it('describes a tool found in the chat with its live status and marks it as in the chat', () => {
    const out = ctx(section(), f('t1'), history(), chat(tool('t1', { tool: 'Edit', summary: 'Edit src/a.ts', status: 'ok' }))).tools;
    expect(out).toEqual([{ id: 't1', tool: 'Edit', summary: 'Edit src/a.ts', status: 'ok', inChat: true }]);
  });

  it.each<ToolStatus>(['running', 'ok', 'error', 'rejected', 'unfinished'])('passes the chat status %s through', (status) => {
    const out = ctx(section(), f('t1'), history(), chat(tool('t1', { status }))).tools;
    expect(out[0]!.status).toBe(status);
  });

  it('falls back to the tool calls of the matching event, with no status, when the chat does not have it', () => {
    const out = ctx(section(), f('t1'), history(event({ toolCalls: [call('t1', { tool: 'Bash', summary: 'rm old.ts' })] }))).tools;
    expect(out).toEqual([{ id: 't1', tool: 'Bash', summary: 'rm old.ts', status: null, inChat: false }]);
  });

  it('drops a tool use that is neither in the chat nor in the event', () => {
    expect(ctx(section(), f('t1'), history(event({ toolCalls: [call('other')] }))).tools).toEqual([]);
  });

  it('drops a tool use when there is no event at all', () => {
    expect(ctx(section(), f('t1'), history()).tools).toEqual([]);
  });

  it('prefers the chat over the event for the same tool use', () => {
    const out = ctx(section(), f('t1'), history(event({ toolCalls: [call('t1', { summary: 'from event' })] })), chat(tool('t1', { summary: 'from chat' }))).tools;
    expect(out).toEqual([expect.objectContaining({ summary: 'from chat', inChat: true })]);
  });

  it('follows the order of the file tool uses, not the order of the chat or the event', () => {
    const out = ctx(
      section(),
      f('t3', 't1', 't2'),
      history(event({ toolCalls: [call('t2'), call('t1')] })),
      chat(tool('t3'), tool('t1')),
    ).tools;
    expect(out.map((t) => [t.id, t.inChat])).toEqual([['t3', true], ['t1', true], ['t2', false]]);
  });

  it('keeps the ones it can describe and drops the ones it cannot', () => {
    const out = ctx(section(), f('gone', 't1', 'lost', 't2'), history(event({ toolCalls: [call('t2')] })), chat(tool('t1'))).tools;
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('does not take a chat item of another kind for a tool', () => {
    const out = ctx(section(), f('t1'), history(event({ toolCalls: [call('t1', { summary: 'from event' })] })), chat(message('t1'))).tools;
    expect(out).toEqual([expect.objectContaining({ summary: 'from event', inChat: false, status: null })]);
  });

  it('drops a tool use whose chat item is not a tool and that no event knows', () => {
    expect(ctx(section(), f('t1'), history(), chat(message('t1'))).tools).toEqual([]);
  });

  it('copes with an undefined chat entry', () => {
    expect(ctx(section(), f('t1'), history(event({ toolCalls: [call('t1')] })), { t1: undefined }).tools.map((t) => t.inChat)).toEqual([false]);
  });

  it('ignores the tool calls of events that do not belong to the file', () => {
    expect(ctx(section(), f('t1'), history(event({ id: 'other', toolCalls: [call('t1')] }))).tools).toEqual([]);
  });

  it('takes event tool calls from the latest matching event only', () => {
    const older = event({ id: 'old', ts: 1, toolCalls: [call('t1', { summary: 'older' }), call('t2')] });
    const newer = event({ id: 'new', ts: 2, toolCalls: [call('t1', { summary: 'newer' })] });
    const out = ctx(section(), file({ toolUseIds: ['t1', 't2'], eventIds: ['old', 'new'] }), history(older, newer)).tools;
    expect(out.map((t) => [t.id, t.summary])).toEqual([['t1', 'newer']]);
  });
});

describe('hasContext', () => {
  const empty = (): ReviewContext => ({ title: 'T', rationale: null, summary: null, reason: null, decision: null, tools: [] });

  it('is false when there is no rationale, summary, reason or tool', () => {
    expect(hasContext(empty())).toBe(false);
  });

  it('is true with only a rationale', () => {
    expect(hasContext({ ...empty(), rationale: 'why' })).toBe(true);
  });

  it('is true with only a summary', () => {
    expect(hasContext({ ...empty(), summary: { text: null, pending: true } })).toBe(true);
  });

  it('is true with only a reason', () => {
    expect(hasContext({ ...empty(), reason: 'because' })).toBe(true);
  });

  it('is true with only a tool', () => {
    expect(hasContext({ ...empty(), tools: [{ id: 't', tool: 'Edit', summary: 's', status: null, inChat: false }] })).toBe(true);
  });

  it('is false for an ordinary step without any details', () => {
    expect(hasContext(ctx(section(), file()))).toBe(false);
  });

  it('is true for an external change, which always has a reason', () => {
    expect(hasContext(ctx(external(), file()))).toBe(true);
  });
});
