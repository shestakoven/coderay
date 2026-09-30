import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChangeView, ControlMode, WatchdogEventView } from '@ide/protocol';
import type { WatchdogSession } from '../../src/watchdog/watchdog';
import { AgentSession } from '../../src/agent/agent-session';
import { createExecutionRuntime, type ExecutionRuntime, type ExecutionRuntimeOptions } from '../../src/execution/runtime';
import { projectDir } from '../../src/home';
import { writeMapFile } from '../../src/map/map-file';
import { isAlive } from '../../src/os-process';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer, type RunningServer } from '../../src/server/server';
import { openStore, type Store } from '../../src/store/store';
import { fakeClaude, readRecords, type FakeRecord } from '../fake-claude/fake';
import { tempDir, waitFor, writeTree } from '../helpers';

const FILES = { 'src/app.ts': "export const greeting = 'helo';\n", 'src/other.ts': "export const other = 'helo';\n", 'notes.txt': 'notes\n' };
const COMPONENTS = [{ id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] }];
const INIT = '{"type":"system","subtype":"init","cwd":"$CWD","session_id":"$SESSION","mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode":"bypassPermissions","claude_code_version":"2.1.282"}';
const AWAIT = '{"fake":"await-user"}';
const HOLD_OPEN = '{"fake":"sleep","ms":60000}';
const mcpWrite = (id: string, files: { path: string; content: string }[], extra: object = {}): string =>
  JSON.stringify({ fake: 'mcp-write', id, server: 'other', tool: 'write', files, ...extra });

interface Built {
  rt: ExecutionRuntime;
  session: AgentSession;
  store: Store;
  root: string;
  home: string;
  generate: ReturnType<typeof vi.fn>;
  records(): FakeRecord[];
  send(): Promise<void>;
  write(rel: string, content: string): void;
  changes(): ChangeView[];
  events(): WatchdogEventView[];
  close(): Promise<void>;
}

interface BuildOptions {
  scenario: string | string[];
  mode?: ControlMode;
  runtime?: Partial<ExecutionRuntimeOptions>;
  start?: boolean;
}

async function build(options: BuildOptions): Promise<Built> {
  const home = tempDir('rt-home-');
  const root = tempDir('rt-root-');
  await writeTree(root, FILES);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const scenarioPath = Array.isArray(options.scenario) ? join(home, 'scenario.jsonl') : options.scenario;
  if (Array.isArray(options.scenario)) writeFileSync(scenarioPath, `${options.scenario.join('\n')}\n`);
  const store = openStore(projectDir(home, root));
  const policy = { ...DEFAULT_POLICY, mode: options.mode ?? 'B' };
  const generate = vi.fn(async () => ({ summary: 'Changed the greeting.' }));
  let server: RunningServer | undefined;
  const rt = createExecutionRuntime({
    root, home, store, policy: () => policy, components: () => COMPONENTS,
    port: () => server?.port ?? 0, userHome: tempDir('rt-user-home-'), tempRoots: [],
    shadowDir: join(home, 'shadow.git'), watcherSettleMs: 20, watchdogSettleMs: 100, summaryDebounceMs: 20,
    provider: { fast: { generate } }, files: () => [],
    ...options.runtime,
  });
  const recordFile = join(home, 'record.jsonl');
  const session = new AgentSession({
    root, home, store, claude: fakeClaude(scenarioPath, recordFile), canaryMs: 5_000,
    mcpServers: () => ({ idecore: rt.gate.mcpEntry() }), gate: rt.sessionGate,
  });
  rt.attach(session);
  server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: rt.gate.routes });
  const running = server;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => (closed ??= (async () => {
    await session.close();
    await rt.close();
    await running.close();
    store.close();
  })());
  onTestFinished(close);
  await session.start();
  if (options.start !== false) await rt.start();
  return {
    rt, session, store, root, home, generate,
    records: () => readRecords(recordFile),
    send: async () => {
      session.send('go');
      await waitFor(() => session.hasOpenTurn(), 'turn open');
    },
    write: (rel, content) => writeFileSync(join(root, rel), content),
    changes: () => rt.changes.changes(),
    events: () => rt.watchdog.events(),
    close,
  };
}

const OUT_OF_PLAN = [AWAIT, INIT, mcpWrite('toolu_w', [{ path: 'src/x.ts', content: 'x\n' }]), HOLD_OPEN, AWAIT];
const WAIT_TURN = [AWAIT, INIT, HOLD_OPEN, AWAIT];
const pendingEvent = (b: Built) => waitFor(() => b.events().find((event) => event.phase === 'pending'), 'a pending watchdog event');

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

  it('releases the hold when the claude process exits and keeps the event pending', async () => {
    const b = await build({ scenario: OUT_OF_PLAN });
    await b.send();
    await pendingEvent(b);
    await b.session.close();
    await waitFor(() => !b.rt.hold.isHeld(), 'the hold released');
    expect(b.events().map((event) => event.phase)).toEqual(['pending']);
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

  it('opens a fail-open event for a call the hook never judged', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, mcpWrite('toolu_f', [{ path: 'src/y.ts', content: 'y\n' }, { path: 'src/z.ts', content: 'z\n' }], { skipHook: true, perFileMs: 400 }), HOLD_OPEN, AWAIT],
    });
    await b.send();
    const event = await waitFor(() => b.events().find((e) => e.kind === 'fail-open' && e.changes.length > 0), 'a fail-open event');
    expect(event.changes.map((c) => c.path)).toContain('src/y.ts');
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
    expect([pid !== undefined && isAlive(pid), timers() <= before, existsSync(join(b.home, 'shadow.git'))]).toEqual([false, true, true]);
  });
});
