import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChangeView } from '@ide/protocol';
import { AgentSession } from '../../src/agent/agent-session';
import { writeMapFile } from '../../src/map/map-file';
import { isAlive } from '../../src/os-process';
import type { WatchdogSession } from '../../src/watchdog/watchdog';
import { tempDir, waitFor } from '../helpers';
import { AWAIT, build, FILES, HOLD_OPEN, INIT, mcpWrite, OUT_OF_PLAN, pendingEvent, WAIT_TURN } from './harness';

const _sessionFitsTheWatchdog = (session: AgentSession): WatchdogSession => session;
void _sessionFitsTheWatchdog;

describe('the execution runtime', { timeout: 30_000 }, () => {
  it('turns a file change into a Change', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    b.write('notes.txt', 'edited\n');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change');
    expect(change).toMatchObject({ path: 'notes.txt', origin: 'human', afterHash: expect.any(String) });
  });

  it('opens a pending watchdog event for an agent-tool change outside the plan', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    expect(event).toMatchObject({ kind: 'watchdog', changes: [expect.objectContaining({ path: 'src/x.ts', origin: 'agent-tool', outOfPlan: true })] });
  });

  it('holds new calls and interrupts the agent when it opens that event', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    const interrupts = b.records().filter((r) => r.stdin?.type === 'control_request');
    expect([b.rt.hold.isHeld(), event.interrupted, interrupts.length]).toEqual([true, true, 1]);
  });

  it('keeps the hold and the event when the claude process exits while an event is pending', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    await pendingEvent(b);
    await b.session.close();
    expect([b.rt.hold.isHeld(), b.events().map((event) => event.phase)]).toEqual([true, ['pending']]);
  });

  it('releases the hold when the claude process exits and no event is pending', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    b.rt.hold.hold('test');
    await b.session.close();
    await waitFor(() => !b.rt.hold.isHeld(), 'the hold released');
  });

  it('holds the new claude process at its first call while an event is pending, until the answer', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    await b.session.close();
    b.rt.hold.release();
    b.session.send('again');
    await waitFor(() => b.rt.hold.waiting() > 0, 'the new process held');
    await b.rt.watchdog.answer(event.id, { kind: 'all', answer: 'keep' });
    await waitFor(() => b.rt.hold.waiting() === 0, 'the new process released');
    expect(b.rt.hold.isHeld()).toBe(false);
  });

  it('hashes every unchanged file again when its shadow repository was deleted, so their before-images come back', async () => {
    const b = await build({ scenario: WAIT_TURN, start: false });
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    await b.rt.start();
    const app = (): { hash: string; sig?: string } => b.store.baselines().find((row) => row.path === 'src/app.ts')!;
    const signed = app().sig !== undefined;
    await b.session.close();
    await b.rt.close();
    rmSync(b.shadowDir, { recursive: true });
    const again = await build({ scenario: WAIT_TURN, from: b });
    const blob = execFileSync('git', ['--git-dir', again.shadowDir, 'cat-file', '-p', app().hash], { encoding: 'utf8' });
    expect([signed, blob]).toEqual([true, FILES['src/app.ts']]);
  });

  it('holds after a core restart that restores a pending event', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    await pendingEvent(b);
    await b.session.close();
    await b.rt.close();
    const again = await build({ scenario: WAIT_TURN, from: b });
    expect([again.rt.hold.isHeld(), again.events().map((event) => event.phase)]).toEqual([true, ['pending']]);
  });

  it('keeps the hold when one of two pending events is answered', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const first = await pendingEvent(b);
    b.rt.watchdog.raiseUnknown([b.changes()[0]!]);
    await b.rt.watchdog.answer(first.id, { kind: 'all', answer: 'keep' });
    expect(b.rt.hold.isHeld()).toBe(true);
    const second = b.events().find((event) => event.phase === 'pending')!;
    await b.rt.watchdog.answer(second.id, { kind: 'all', answer: 'keep' });
    expect(b.rt.hold.isHeld()).toBe(false);
  });

  it('holds again, without a second interrupt, when a later change joins an open event', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    await pendingEvent(b);
    b.rt.hold.release();
    b.rt.watchdog.consider({ ...b.changes()[0]!, id: 'late', path: 'src/q.ts' });
    const interrupts = b.records().filter((r) => r.stdin?.type === 'control_request');
    expect([b.rt.hold.isHeld(), interrupts.length]).toEqual([true, 1]);
  });

  it('ends the ledger window at the tool result', async () => {
    const b = await build({ scenario: [AWAIT, INIT, mcpWrite('toolu_q', []), HOLD_OPEN, AWAIT] });
    await b.send();
    await waitFor(() => b.rt.ledger.windowOf('toolu_q')?.to, 'the window closed');
    expect(b.rt.ledger.windowOf('toolu_q')?.to).toBeGreaterThan(b.rt.ledger.windowOf('toolu_q')!.from);
  });

  it('tells the ledger when Stop interrupts the agent', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    await waitFor(() => b.session.state().session?.model, 'the agent started');
    const interrupted = vi.spyOn(b.rt.ledger, 'interrupted');
    expect(b.session.stop()).toBe(true);
    expect(interrupted).toHaveBeenCalledTimes(1);
  });

  it('clears the ledger when the process exits', async () => {
    const b = await build({ scenario: [AWAIT, INIT, mcpWrite('toolu_q', []), HOLD_OPEN, AWAIT] });
    await b.send();
    await waitFor(() => b.rt.ledger.windowOf('toolu_q'), 'the call allowed');
    await b.session.close();
    await waitFor(() => b.rt.ledger.windowOf('toolu_q') === undefined, 'the ledger cleared');
  });

  it('begins a checkpoint at step start and seals it at step done', async () => {
    const b = await build({ scenario: 'gate-small-plan' });
    await b.send();
    const sealed = await waitFor(() => b.rt.checkpoints.views().find((view) => view.sealedAt !== null), 'a sealed checkpoint');
    expect(sealed).toMatchObject({ stepKey: 'edit', cycle: 0, after: 1 });
  });

  it('asks the Summarizer for a step summary when a step is done', async () => {
    const b = await build({ scenario: 'gate-small-plan' });
    await b.send();
    const view = await waitFor(() => b.rt.summarizer.views().find((v) => v.scope === 'step' && v.text), 'a step summary');
    expect(view.text).toBe('Changed the greeting.');
  });

  it('asks the Summarizer for a component summary once a change settles', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    b.write('src/app.ts', "export const greeting = 'hello';\n");
    const view = await waitFor(() => b.rt.summarizer.views().find((v) => v.scope === 'component' && v.ref === 'app' && v.text), 'a component summary');
    expect(view.text).toBe('Changed the greeting.');
  });

  it('labels a map save as an ide change', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    await writeMapFile(b.root, { ai: [], groupedAt: new Date().toISOString(), raw: {} }, null, (rel, hash) => b.rt.ideWrites.expect(rel, hash));
    const change = await waitFor(() => b.changes().find((c) => c.path === '.ide/map.json'), 'the map change');
    expect(change.origin).toBe('ide');
  });

  it('records a map save without a registration as human, so the registration is what labels it', async () => {
    const b = await build({ scenario: WAIT_TURN });
    await b.send();
    await writeMapFile(b.root, { ai: [], groupedAt: new Date().toISOString(), raw: {} }, null);
    const change = await waitFor(() => b.changes().find((c) => c.path === '.ide/map.json'), 'the map change');
    expect(change.origin).toBe('human');
  });

  it('catches a change the file watcher dropped with the periodic scan', async () => {
    const b = await build({
      scenario: WAIT_TURN,
      runtime: { reconcileMs: 50, watcherOptions: { testHooks: { dropRawFileEvents: () => true } } },
    });
    await b.send();
    b.write('notes.txt', 'edited\n');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change found by the scan');
    expect(change.origin).toBe('human');
  });

  it('runs the scan at the end of a turn, even with the timer slow', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, '{"fake":"sleep","ms":300}', '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}', AWAIT],
      runtime: { reconcileMs: 3_600_000, watcherOptions: { testHooks: { dropRawFileEvents: () => true } } },
    });
    await b.send();
    b.write('notes.txt', 'edited\n');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change found at the turn end');
    expect(change.path).toBe('notes.txt');
  });

  it('does not reject without a handler when a change batch fails, and records the change on a retry', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    onTestFinished(() => { process.off('unhandledRejection', listener); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const b = await build({ scenario: WAIT_TURN, runtime: { reconcileMs: 50 } });
    await b.send();
    vi.spyOn(b.store, 'saveChanges').mockImplementationOnce(() => { throw new Error('disk full'); });
    b.write('notes.txt', 'edited\n');
    await waitFor(() => errors.mock.calls.some((call) => String(call[0]).includes('could not record')), 'the failure logged');
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the retried change');
    expect([change.path, unhandled]).toEqual(['notes.txt', []]);
  });

  it('opens a fail-open event for a call the hook never judged, with the file that lands after the result', async () => {
    const start = join(tempDir('start-'), 'go');
    const b = await build({
      scenario: [AWAIT, INIT, mcpWrite('toolu_f', [{ path: 'src/y.ts', content: 'y\n' }, { path: 'src/z.ts', content: 'z\n' }], { skipHook: true, perFileMs: 400, awaitStart: true }), HOLD_OPEN, AWAIT],
      claudeEnv: { FAKE_CLAUDE_START: start },
    });
    await b.send();
    await waitFor(() => b.session.state().items.find((i) => i.kind === 'tool' && i.id === 'toolu_f'), 'the tool call seen by the core');
    writeFileSync(start, '');
    const event = await waitFor(
      () => b.events().find((e) => e.kind === 'fail-open' && ['src/y.ts', 'src/z.ts'].every((path) => e.changes.some((c) => c.path === path))),
      'a fail-open event with both files',
    );
    expect(event.changes.map((c) => c.origin)).toEqual(['agent-tool', 'agent-tool']);
  });

  it('records the hook-missing decision on the call', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, mcpWrite('toolu_f', [], { skipHook: true }), HOLD_OPEN, AWAIT],
    });
    await b.send();
    const item = await waitFor(() => b.session.state().items.find((i) => i.kind === 'tool' && i.id === 'toolu_f' && i.decision !== null), 'the decision');
    expect(item).toMatchObject({ decision: 'hook-missing' });
  });

  it('refuses to start the agent when the file watcher cannot start', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const b = await build({ scenario: WAIT_TURN, runtime: { watcherOptions: { readyMs: 100, testHooks: { swallowReady: true } } } });
    expect(() => b.session.send('go')).toThrow(/hook settings/);
    expect(errors).toHaveBeenCalled();
    expect([b.rt.unavailable() !== null, b.records().length]).toEqual([true, 0]);
    expect(() => b.rt.sessionGate.write('s')).toThrow(/watchdog/i);
  });

  it('answers a watchdog answer through the same graph and releases the hold', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    const event = await pendingEvent(b);
    await b.rt.watchdog.answer(event.id, { kind: 'all', answer: 'keep' });
    expect([b.rt.hold.isHeld(), b.events()[0]?.resolution, b.changes().find((c) => c.path === 'src/x.ts')?.resolution]).toEqual([false, 'kept', 'kept']);
  });

  it('publishes the changes an answer updates through the upsert channel', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    const seen: ChangeView[] = [];
    b.rt.onChangesUpserted((changes) => seen.push(...changes));
    await b.send();
    const event = await pendingEvent(b);
    await b.rt.watchdog.answer(event.id, { kind: 'all', answer: 'keep' });
    await waitFor(() => seen.find((c) => c.path === 'src/x.ts' && c.resolution === 'kept'), 'the kept change published');
  });

  it('leaves no claude process and no pending timer after close', async () => {
    const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const before = timers();
    const b = await build({ scenario: OUT_OF_PLAN, runtime: { reconcileMs: 50 } });
    await b.send();
    await pendingEvent(b);
    const pid = b.records().find((r) => r.pid !== undefined)?.pid;
    await b.close();
    expect([pid !== undefined && isAlive(pid), timers() <= before, existsSync(b.shadowDir)]).toEqual([false, true, true]);
  });

  it('records a user edit made before the first session as human, even when a tool window opens later', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, '{"fake":"tool","id":"toolu_s","name":"Bash","input":{"command":"sleep 1"},"result":"","apply":true}', HOLD_OPEN, AWAIT],
      runtime: { reconcileMs: 50 },
    });
    b.write('notes.txt', 'edited\n');
    await b.send();
    const change = await waitFor(() => b.changes().find((c) => c.path === 'notes.txt'), 'the change');
    await waitFor(() => b.records().some((r) => r.hook?.id === 'toolu_s'), 'the call judged');
    expect([change.origin, b.events(), b.records().filter((r) => r.stdin?.type === 'control_request').length]).toEqual(['human', [], 0]);
  });

  it('attributes a write the watcher dropped to the agent when the scan runs after its window', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, mcpWrite('toolu_w', [{ path: 'src/x.ts', content: 'x\n' }]), '{"fake":"sleep","ms":400}',
        '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}', AWAIT],
      runtime: { reconcileMs: 3_600_000, ledgerGraceMs: 100, watcherOptions: { testHooks: { dropRawFileEvents: () => true } } },
    });
    await b.send();
    const event = await pendingEvent(b);
    expect(event.changes).toMatchObject([{ path: 'src/x.ts', origin: 'agent-tool' }]);
  });

  it('stamps a change found after step done with the step of the call that made it', async () => {
    const step = (key: string, phase: string): string => JSON.stringify({ fake: 'mcp', id: `toolu_${key}_${phase}`, tool: 'step', input: { key, phase } });
    const write = (id: string, file: string): string =>
      JSON.stringify({ fake: 'tool', id, name: 'Write', input: { file_path: `$CWD/src/${file}`, content: 'export const v = 1;\n' }, result: 'ok', apply: true });
    const plan = JSON.stringify({
      fake: 'mcp', id: 'toolu_plan', tool: 'propose_plan',
      input: { goal: 'Two edits', steps: ['one', 'two'].map((key, i) => ({ key, title: key, rationale: 'r', targets: [{ path: i === 0 ? 'src/app.ts' : 'src/other.ts', op: 'modify' }] })) },
    });
    const b = await build({
      scenario: [AWAIT, INIT, plan, step('one', 'start'), write('toolu_w1', 'app.ts'), step('one', 'done'), step('two', 'start'), write('toolu_w2', 'other.ts'), step('two', 'done'),
        '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}', AWAIT],
      runtime: { reconcileMs: 3_600_000, watcherOptions: { testHooks: { dropRawFileEvents: () => true } } },
    });
    await b.send();
    const change = await waitFor(() => b.changes().find((c) => c.path === 'src/app.ts'), 'the change');
    const planId = b.rt.gate.plans.plans()[0]!.id;
    await waitFor(() => b.rt.checkpoints.manifests(planId, 'one')?.sealedAt, 'step one sealed');
    expect([change.stepKey, Object.keys(b.rt.checkpoints.manifests(planId, 'one')!.after)]).toEqual(['one', ['src/app.ts']]);
  });

  it('does not leak a watcher when it is closed while it starts', async () => {
    const priv = tempDir('rt-tmp-');
    const before = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    onTestFinished(() => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; });
    const b = await build({ scenario: WAIT_TURN, start: false });
    const started = b.rt.start();
    await b.rt.close();
    await started;
    expect(readdirSync(priv).filter((name) => name.startsWith('watchdog-probe-'))).toEqual([]);
  });

  it('does not seal a step checkpoint that is reset', async () => {
    const plan = JSON.stringify({ fake: 'mcp', id: 'toolu_plan', tool: 'propose_plan', input: { goal: 'One', steps: [{ key: 'one', title: 'one', rationale: 'r', targets: [{ path: 'src/app.ts', op: 'modify' }] }] } });
    const start = JSON.stringify({ fake: 'mcp', id: 'toolu_start', tool: 'step', input: { key: 'one', phase: 'start' } });
    const b = await build({ scenario: [AWAIT, INIT, plan, start, HOLD_OPEN, AWAIT] });
    await b.send();
    const planId = (await waitFor(() => b.rt.gate.plans.plans().find((p) => p.status === 'approved'), 'the plan approved')).id;
    await waitFor(() => b.rt.checkpoints.views().length === 1, 'the checkpoint begun');
    const lookups = vi.spyOn(b.rt.checkpoints, 'manifests');
    b.rt.gate.plans.resetStep(planId, 'one');
    expect([lookups.mock.calls.length, b.rt.checkpoints.views().map((view) => view.sealedAt)]).toEqual([0, [null]]);
  });

  it('survives a throwing summary request', async () => {
    const b = await build({ scenario: WAIT_TURN });
    const request = vi.spyOn(b.rt.summarizer, 'request').mockImplementation(() => { throw new Error('boom'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await b.send();
    b.write('src/app.ts', 'export const greeting = 1;\n');
    await waitFor(() => request.mock.calls.length > 0, 'the summary requested');
    expect(request).toHaveBeenCalled();
  });

  it('refuses start() before the session has started, and exposes one session gate', async () => {
    const b = await build({ scenario: WAIT_TURN, start: false, sessionStart: false });
    await expect(b.rt.start()).rejects.toThrow(/AgentSession\.start/);
    expect(b.rt.gate.sessionGate).toBe(b.rt.sessionGate);
    expect(() => b.rt.gate.sessionGate.write('s')).toThrow(/not ready/);
  });

  it('drops the pending events of the old session and releases the hold when a new session begins', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    await pendingEvent(b);
    const old = b.session.sessionId()!;
    await b.session.newSession();
    expect([b.rt.hold.isHeld(), b.store.watchdogEvents(old).map((event) => [event.phase, event.resolution])]).toEqual([false, [['resolved', 'dropped']]]);
  });

  it('tells the user once, not on every scan, that the project cannot be scanned', async () => {
    const notice = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const b = await build({ scenario: 'multi-turn', runtime: { reconcileMs: 50, notice } });
    writeFileSync(join(b.root, '.git', 'index'), 'garbage');
    for (let turn = 0; turn < 2; turn += 1) {
      b.session.send('hi');
      await waitFor(() => b.session.state().turns.filter((t) => t.closedAt !== null).length === turn + 1, 'turn closed');
    }
    await waitFor(() => notice.mock.calls.length > 0, 'the notice');
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('refuses to start the agent when the shadow repository cannot be opened', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const home = tempDir('rt-blocker-');
    writeFileSync(join(home, 'file'), 'not a directory');
    const b = await build({ scenario: WAIT_TURN, runtime: { shadowDir: join(home, 'file', 'shadow.git') } });
    expect(b.rt.unavailable()).not.toBeNull();
    expect(() => b.rt.sessionGate.write('s')).toThrow(/watchdog/i);
  });

  it('ends the window of a subagent call that has no live task when its result arrives', async () => {
    const call = '{"fake":"tool","id":"toolu_a","name":"Agent","input":{"description":"d","prompt":"p","run_in_background":true},"result":"launched"}';
    const b = await build({ scenario: [AWAIT, INIT, call, HOLD_OPEN, AWAIT] });
    await b.send();
    await waitFor(() => b.rt.ledger.windowOf('toolu_a'), 'the call allowed');
    await waitFor(() => b.rt.ledger.windowOf('toolu_a')?.to, 'the window closed');
  });

  it('re-attributes a call the hook skipped and joins the pending event restored after a restart', async () => {
    const first = await build({ scenario: OUT_OF_PLAN });
    await first.send();
    const restored = await pendingEvent(first);
    await first.session.close();
    await first.rt.close();
    const files = [{ path: 'src/y.ts', content: 'y\n' }, { path: 'src/z.ts', content: 'z\n' }];
    const b = await build({ scenario: [AWAIT, INIT, mcpWrite('toolu_f', files, { skipHook: true, perFileMs: 400 }), HOLD_OPEN, AWAIT], from: first });
    await b.send();
    const joined = await waitFor(() => b.events().find((e) => e.id === restored.id && e.changes.some((c) => c.path === 'src/y.ts')), 'y in the restored event');
    expect([joined.kind, joined.changes.find((c) => c.path === 'src/y.ts')?.origin, b.events().length]).toEqual(['fail-open', 'agent-tool', 1]);
  });

  it('marks the event of a change that lands after a fail-open result as fail-open', async () => {
    const b = await build({ scenario: [AWAIT, INIT, mcpWrite('toolu_f', [{ path: 'src/y.ts', content: 'y\n' }], { skipHook: true }), HOLD_OPEN, AWAIT] });
    await b.send();
    const event = await waitFor(() => b.events().find((e) => e.phase !== 'resolved' && e.changes.some((c) => c.path === 'src/y.ts')), 'an event with y');
    expect(event.kind).toBe('fail-open');
  });

  it('does not seal a step or ask for its summary after close', async () => {
    const b = await build({ scenario: 'gate-small-plan' });
    // The seal waits for the changes to settle. Holding that until close() has finished makes close() win the race it would otherwise only usually win.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onTestFinished(release);
    const idle = b.rt.changes.idle.bind(b.rt.changes);
    vi.spyOn(b.rt.changes, 'idle').mockImplementationOnce(async () => {
      await held;
      return idle();
    });
    const step: { done: boolean; closed?: Promise<void> } = { done: false };
    b.rt.gate.plans.onStep((event) => {
      if (event.phase !== 'done') return;
      step.done = true;
      step.closed = b.rt.close();
    });
    await b.send();
    await waitFor(() => step.done, 'the step done');
    await step.closed;
    // A component summary may be asked for before close, when the watcher records the step's write; nothing may be asked after it.
    const asked = () => b.rt.summarizer.views().map((view) => `${view.scope}:${view.ref}`);
    const atClose = asked();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect([b.rt.checkpoints.views().map((view) => view.sealedAt), asked(), atClose.filter((ref) => ref.startsWith('step:'))]).toEqual([[null], atClose, []]);
  });
});
