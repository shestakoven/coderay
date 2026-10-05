import { describe, expect, it } from 'vitest';
import type { WatchdogEventView } from '@ide/protocol';
import type { SessionRecord } from '../../src/store/store';
import { waitFor } from '../helpers';
import { build, OUT_OF_PLAN, pendingEvent, WAIT_TURN, type Built } from './harness';

const LEAVE_PLAN = 'Answer the waiting plan before switching chats.';
const LEAVE_PROMPT = 'Answer the waiting tool question before switching chats.';
const LEAVE_WATCHDOG = 'Resolve the watchdog question before switching chats.';

const chat = (id: string, startedAt: number): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'stopped', model: null, modelChoice: null, effort: null, cliVersion: null,
  pid: null, launchId: null, conversationStarted: true, startedAt, accountId: null,
});

const resolvedEvent = (id: string, ts: number): WatchdogEventView => ({
  id, kind: 'watchdog', mode: 'B', phase: 'resolved', resolution: 'kept', changes: [], toolCalls: [], interrupted: false, paused: false,
  runningSubagents: 0, backgroundShell: false, unknownOrigin: false, snapshotSha: null, canExpand: false, defaultAction: 'revert', reason: '', ts, resolvedAt: ts + 1,
});

const eventIds = (b: Built) => b.events().map((event) => event.id);

function seedChat(b: Built, id: string, startedAt: number, events: string[]): void {
  b.store.saveSession(chat(id, startedAt));
  events.forEach((eventId, index) => b.store.saveWatchdogEvent(id, resolvedEvent(eventId, startedAt + index)));
}

describe('ExecutionRuntime.canLeave', { timeout: 30_000 }, () => {
  it('is null when nothing waits for the user', async () => {
    const b = await build({ scenario: WAIT_TURN });
    expect(b.rt.canLeave()).toBeNull();
  });

  it('names the waiting plan while a plan is proposed, and is null once it is answered', async () => {
    const b = await build({ scenario: 'gate-big-plan' });
    await b.send();
    const plan = await waitFor(() => b.rt.gate.plans.plans().find((p) => p.status === 'proposed'), 'the plan waiting for review');
    expect([b.rt.gate.gate.pending().length, b.rt.canLeave()]).toEqual([0, LEAVE_PLAN]);
    b.rt.gate.plans.answer(plan.id, plan.version, { kind: 'reject', feedback: '' });
    expect(b.rt.canLeave()).toBeNull();
  });

  it('names the waiting tool question while a gate prompt is pending, and is null once it is answered', async () => {
    const b = await build({ scenario: 'exec-shell-ask' });
    await b.send();
    const prompt = await waitFor(() => b.rt.gate.gate.prompts().find((p) => p.status === 'pending'), 'the prompt');
    expect(b.rt.canLeave()).toBe(LEAVE_PROMPT);
    b.rt.gate.gate.answer(prompt.id, 'allow-once');
    await waitFor(() => b.session.state().turns.some((turn) => turn.closedAt !== null), 'the turn closed');
    expect(b.rt.canLeave()).toBeNull();
  });

  it('names the watchdog question while an event is pending, and is null once it is answered', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    expect(b.rt.canLeave()).toBe(LEAVE_WATCHDOG);
    await b.rt.watchdog.answer(event.id, { kind: 'all', answer: 'keep' });
    expect(b.rt.canLeave()).toBeNull();
  });
});

describe('the watchdog when the open chat changes', { timeout: 30_000 }, () => {
  it('shows the events stored for the chat that is opened', async () => {
    const b = await build({ scenario: WAIT_TURN });
    seedChat(b, 'chat-a', 10, ['a-1', 'a-2']);
    expect(b.events()).toEqual([]);
    await b.session.switchSession('chat-a');
    expect(eventIds(b)).toEqual(['a-1', 'a-2']);
  });

  it('replaces the events of the chat it leaves with the events of the chat it opens, and back again', async () => {
    const b = await build({ scenario: WAIT_TURN });
    seedChat(b, 'chat-a', 10, ['a-1']);
    seedChat(b, 'chat-b', 20, ['b-1', 'b-2']);
    await b.session.switchSession('chat-a');
    await b.session.switchSession('chat-b');
    expect(eventIds(b)).toEqual(['b-1', 'b-2']);
    await b.session.switchSession('chat-a');
    expect(eventIds(b)).toEqual(['a-1']);
  });

  it('shows no events for an opened chat that has none', async () => {
    const b = await build({ scenario: WAIT_TURN });
    seedChat(b, 'chat-a', 10, ['a-1']);
    seedChat(b, 'chat-empty', 20, []);
    await b.session.switchSession('chat-a');
    await b.session.switchSession('chat-empty');
    expect(b.events()).toEqual([]);
  });

  it('drops the pending event of the chat it leaves, releases the hold and shows the events of the opened chat', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const pending = await pendingEvent(b);
    const leftId = b.session.sessionId() ?? '';
    await b.session.close();
    expect([b.rt.hold.isHeld(), b.rt.canLeave()]).toEqual([true, LEAVE_WATCHDOG]);
    seedChat(b, 'chat-b', 50, ['b-1']);
    await b.session.switchSession('chat-b');
    expect(eventIds(b)).toEqual(['b-1']);
    expect([b.rt.hold.isHeld(), b.rt.canLeave()]).toEqual([false, null]);
    expect(b.store.watchdogEvents(leftId).map((event) => [event.id, event.phase, event.resolution])).toEqual([[pending.id, 'resolved', 'dropped']]);
    await b.session.switchSession(leftId);
    expect(b.events().map((event) => [event.id, event.phase, event.resolution])).toEqual([[pending.id, 'resolved', 'dropped']]);
  });

  it('brings back a pending event stored for the chat that is opened, so the chat cannot be left unanswered', async () => {
    const b = await build({ scenario: WAIT_TURN });
    b.store.saveSession(chat('chat-a', 10));
    b.store.saveWatchdogEvent('chat-a', { ...resolvedEvent('a-pending', 11), phase: 'pending', resolution: 'pending', resolvedAt: null });
    await b.session.switchSession('chat-a');
    expect([b.events().map((event) => [event.id, event.phase]), b.rt.canLeave()]).toEqual([[['a-pending', 'pending']], LEAVE_WATCHDOG]);
  });
});
