import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryClientMessage, HistoryPatch, HistoryServerMessage } from '@ide/protocol';
import { tempDir, waitFor } from '../helpers';
import { build, OUT_OF_PLAN, pendingEvent, WAIT_TURN } from '../execution/harness';

type Reply = HistoryServerMessage | { type: 'error'; message: string };
const collect = (): { replies: Reply[]; reply: (m: Reply) => void } => {
  const replies: Reply[] = [];
  return { replies, reply: (m) => void replies.push(m) };
};
const results = (replies: Reply[]) => replies.filter((m): m is Extract<Reply, { type: 'history.result' }> => m.type === 'history.result');

describe('HistoryService', { timeout: 30_000 }, () => {
  it('snapshots the changes, events, reverts, checkpoints, gate events and summaries', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    const snapshot = b.rt.history.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['changes', 'checkpoints', 'events', 'gateEvents', 'reverts', 'summaries']);
    expect(snapshot.events.map((e) => e.id)).toEqual([event.id]);
    expect(snapshot.changes.map((c) => c.path)).toContain('src/x.ts');
  });

  it('keeps only the latest 2,000 changes in the snapshot', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const many = Array.from({ length: 2_050 }, (_, i) => ({ ...b.rt.changes.changes()[0]!, id: `c${i}` }));
    vi.spyOn(b.rt.changes, 'changes').mockReturnValue(many);
    const { changes } = b.rt.history.snapshot();
    expect([changes.length, changes[0]!.id, changes.at(-1)!.id]).toEqual([2_000, 'c50', 'c2049']);
  });

  it('turns a file change into a patch with the Change', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const patches: HistoryPatch[] = [];
    b.rt.history.onPatch((p) => patches.push(p));
    await b.send();
    b.write('notes.txt', 'edited\n');
    await waitFor(() => patches.flatMap((p) => p.changes ?? []).find((c) => c.path === 'notes.txt'), 'the change patch');
    expect(patches.flatMap((p) => p.changes ?? []).find((c) => c.path === 'notes.txt')).toMatchObject({ origin: 'human' });
  });

  it('coalesces upserts of one change into one patch entry, the last version', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    b.write('notes.txt', 'edited\n');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change');
    await waitFor(() => b.rt.history.snapshot().changes.length > 0, 'recorded');
    const patches: HistoryPatch[] = [];
    b.rt.history.onPatch((p) => patches.push(p));
    for (const added of [1, 2, 3]) b.rt.history.upsertChanges([{ ...change, added }]);
    await waitFor(() => patches.find((p) => p.changes?.some((c) => c.id === change.id)), 'the patch');
    const entries = patches.flatMap((p) => p.changes ?? []).filter((c) => c.id === change.id);
    expect(entries.map((c) => c.added)).toEqual([3]);
  });

  it('sends a patch with the pending event, then with its resolution after watchdog.answer', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    const patches: HistoryPatch[] = [];
    b.rt.history.onPatch((p) => patches.push(p));
    await b.send();
    const event = await pendingEvent(b);
    await waitFor(() => patches.flatMap((p) => p.events ?? []).find((e) => e.id === event.id && e.phase === 'pending'), 'the pending event patch');
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'watchdog.answer', eventId: event.id, answer: { kind: 'all', answer: 'keep' } }, reply);
    await waitFor(() => patches.flatMap((p) => p.events ?? []).find((e) => e.id === event.id && e.resolution === 'kept'), 'the resolved event patch');
    await waitFor(() => patches.flatMap((p) => p.changes ?? []).find((c) => c.path === 'src/x.ts' && c.resolution === 'kept'), 'the kept change patch');
    expect(replies).toEqual([]);
  });

  it('sends the revert record and its changes after a watchdog revert, and the checkpoint views', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    const patches: HistoryPatch[] = [];
    b.rt.history.onPatch((p) => patches.push(p));
    await b.send();
    const event = await pendingEvent(b);
    await b.rt.history.handle({ type: 'watchdog.answer', eventId: event.id, answer: { kind: 'all', answer: 'revert' } }, () => undefined);
    const record = await waitFor(() => patches.flatMap((p) => p.reverts ?? []).at(-1), 'the revert patch');
    expect(record).toMatchObject({ kind: 'watchdog', eventId: event.id });
    await waitFor(() => patches.flatMap((p) => p.changes ?? []).find((c) => c.path === 'src/x.ts' && c.resolution === 'reverted'), 'the reverted change');
  });

  it('answers history.diff for an unknown hash with exactly one error result', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'history.diff', requestId: 'r1', path: 'notes.txt', before: 'f'.repeat(40), after: null }, reply);
    expect(replies).toEqual([{ type: 'history.result', requestId: 'r1', error: expect.stringMatching(/no recorded version/) }]);
  });

  it('answers history.diff for a known pair with a diff and a null error', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    b.write('notes.txt', 'edited\n');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change');
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'history.diff', requestId: 'r1', path: 'notes.txt', before: change.beforeHash, after: change.afterHash }, reply);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'history.result', requestId: 'r1', error: null, diff: { binary: false, added: 1, removed: 1 } });
  });

  it('answers every message that has a requestId with exactly one history.result', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const { replies, reply } = collect();
    const messages: HistoryClientMessage[] = [
      { type: 'history.diff', requestId: 'd', path: 'notes.txt', before: 'a'.repeat(40), after: null },
      { type: 'history.diff', requestId: 'd-bad-path', path: '../x', before: null, after: null },
      { type: 'revert.undo', requestId: 'u', revertId: 'nope' },
      { type: 'step.rollback-preview', requestId: 'p', planId: 'nope', stepKey: 'nope' },
      { type: 'step.rollback', requestId: 'r', planId: 'nope', stepKey: 'nope', confirm: [] },
    ];
    await Promise.all(messages.map((m) => b.rt.history.handle(m, reply)));
    const found = results(replies);
    expect(found.map((r) => r.requestId).sort()).toEqual(['d', 'd-bad-path', 'p', 'r', 'u']);
    expect(found.every((r) => typeof r.error === 'string' && r.error !== '')).toBe(true);
    expect(replies).toHaveLength(5);
  });

  it('answers a step.rollback-preview for a real step with the preview', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const { replies, reply } = collect();
    vi.spyOn(b.rt.reverts, 'previewStepRollback').mockResolvedValue({ planId: 'p', stepKey: 's', allowed: true, reason: null, autoFiles: ['a.ts'], confirmFiles: [], notRolledBack: [], conflicts: [] });
    await b.rt.history.handle({ type: 'step.rollback-preview', requestId: 'p', planId: 'p', stepKey: 's' }, reply);
    expect(replies).toEqual([{ type: 'history.result', requestId: 'p', error: null, preview: expect.objectContaining({ autoFiles: ['a.ts'] }) }]);
  });

  it('passes the confirm list to rollbackStep and answers with a null error', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const { replies, reply } = collect();
    const rollback = vi.spyOn(b.rt.reverts, 'rollbackStep').mockResolvedValue({ id: 'rv', kind: 'step', eventId: null, planId: 'p', stepKey: 's', changeIds: [], files: [], ts: 1, undoneAt: null });
    await b.rt.history.handle({ type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 's', confirm: ['a.ts'] }, reply);
    expect([rollback.mock.calls, replies]).toEqual([[['p', 's', ['a.ts']]], [{ type: 'history.result', requestId: 'r', error: null }]]);
  });

  it('routes watchdog.answer and watchdog.stop-agent failures out as error messages, not results', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'watchdog.answer', eventId: 'nope', answer: { kind: 'all', answer: 'keep' } }, reply);
    await b.rt.history.handle({ type: 'watchdog.stop-agent', eventId: 'nope' }, reply);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error']);
    expect(replies.every((m) => m.type === 'error' && m.message !== '')).toBe(true);
  });

  it('stops the agent for a pending event', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    const stop = vi.spyOn(b.rt.watchdog, 'stopAgent');
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'watchdog.stop-agent', eventId: event.id }, reply);
    expect([stop.mock.calls, replies]).toEqual([[[event.id]], []]);
  });

  it('answers a message that arrives before start() completes once it has completed', async () => {
    const b = await build({ scenario: WAIT_TURN, start: false });
    const { replies, reply } = collect();
    const handled = b.rt.history.handle({ type: 'history.diff', requestId: 'early', path: 'notes.txt', before: 'a'.repeat(40), after: null }, reply);
    await Promise.resolve();
    expect(replies).toEqual([]);
    await b.rt.start();
    await handled;
    expect(results(replies).map((r) => [r.requestId, typeof r.error])).toEqual([['early', 'string']]);
  });

  it('answers with an error result when the runtime could not start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const home = tempDir('hs-blocker-');
    writeFileSync(join(home, 'file'), 'not a directory');
    const b = await build({ scenario: WAIT_TURN, runtime: { shadowDir: join(home, 'file', 'shadow.git') } });
    const { replies, reply } = collect();
    await b.rt.history.handle({ type: 'history.diff', requestId: 'x', path: 'notes.txt', before: null, after: null }, reply);
    await b.rt.history.handle({ type: 'watchdog.answer', eventId: 'e', answer: { kind: 'all', answer: 'keep' } }, reply);
    expect(replies).toEqual([
      { type: 'history.result', requestId: 'x', error: expect.stringMatching(/unavailable/) },
      { type: 'error', message: expect.stringMatching(/unavailable/) },
    ]);
  });

  it('tells a listener to resend the snapshot when the session changes', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    const patches: HistoryPatch[] = [];
    b.rt.history.onPatch((p) => patches.push(p));
    b.write('notes.txt', 'edited\n');
    await waitFor(() => patches.length > 0, 'a first flush');
    let resets = 0;
    b.rt.history.onReset(() => { resets += 1; });
    await b.session.newSession();
    await waitFor(() => resets > 0, 'the reset');
    expect(b.rt.history.snapshot().changes).toEqual([]);
  });
});
