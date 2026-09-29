import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ControlMode, ToolItem } from '@ide/protocol';
import { AgentSession } from '../../src/agent/agent-session';
import { createGateRuntime, type GateRuntime } from '../../src/gate/runtime';
import { projectDir } from '../../src/home';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer, type RunningServer } from '../../src/server/server';
import { openStore } from '../../src/store/store';
import { fakeClaude, readRecords } from '../fake-claude/fake';
import { tempDir, waitFor, writeTree } from '../helpers';

const ORIGINAL = { 'src/app.ts': "export const greeting = 'helo';\n", 'src/other.ts': "export const other = 'helo';\n" };

interface Flow {
  session: AgentSession;
  runtime: GateRuntime;
  server: RunningServer;
  file(rel: string): string;
  tool(id: string): ToolItem | undefined;
  records(): ReturnType<typeof readRecords>;
}

async function flow(scenario: string, options: { mode?: ControlMode } = {}): Promise<Flow> {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  await writeTree(root, ORIGINAL);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const store = openStore(projectDir(home, root));
  const policy = { ...DEFAULT_POLICY, mode: options.mode ?? 'B' };
  const components = [{ id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] }];
  let server: RunningServer | undefined;
  const runtime = createGateRuntime({
    root, home, store, policy: () => policy, components: () => components,
    port: () => server?.port ?? 0, userHome: tempDir('ide-user-home-'), tempRoots: [],
  });
  const recordFile = join(home, 'record.jsonl');
  const session = new AgentSession({
    root, home, store, claude: fakeClaude(scenario, recordFile),
    mcpServers: () => ({ idecore: runtime.mcpEntry() }), gate: runtime.sessionGate,
  });
  runtime.attach(session);
  server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: runtime.routes });
  const running = server;
  onTestFinished(async () => {
    await session.close();
    await runtime.close();
    await running.close();
    store.close();
  });
  await session.start();
  return {
    session, runtime, server: running,
    file: (rel) => readFileSync(join(root, rel), 'utf8'),
    tool: (id) => session.state().items.find((item): item is ToolItem => item.kind === 'tool' && item.id === id),
    records: () => readRecords(recordFile),
  };
}

const turnClosed = (f: Flow) => waitFor(() => f.session.state().turns.some((turn) => turn.closedAt !== null), 'turn closed', 10_000);
const pendingPrompt = (f: Flow) => waitFor(() => f.runtime.gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt shown', 10_000);

describe('the gate end to end', { timeout: 15_000 }, () => {
  it('blocks a write without an approved plan through the real hook and leaves the file untouched', async () => {
    const f = await flow('gate-no-plan');
    f.session.send('fix it');
    await turnClosed(f);
    expect([f.tool('toolu_fx_write')?.status, f.tool('toolu_fx_write')?.decision, f.file('src/app.ts')]).toEqual(['error', 'deny', ORIGINAL['src/app.ts']]);
  });

  it("approves a small plan at once, and its step's write goes through", async () => {
    const f = await flow('gate-small-plan');
    f.session.send('fix it');
    await turnClosed(f);
    expect([f.file('src/app.ts'), f.tool('toolu_fx_write')?.decision]).toEqual(["export const greeting = 'hello';\n", 'allow']);
    expect(f.runtime.plans.plans().map((plan) => [plan.status, plan.approvedBy])).toEqual([['done', 'auto']]);
  });

  it('holds a bigger plan until the user approves it, then lets its writes through', async () => {
    const f = await flow('gate-big-plan');
    f.session.send('fix them');
    const plan = await waitFor(() => f.runtime.plans.plans().find((candidate) => candidate.status === 'proposed'), 'plan proposed', 10_000);
    expect(f.file('src/app.ts')).toBe(ORIGINAL['src/app.ts']);
    f.runtime.plans.answer(plan.id, plan.version, { kind: 'approve' });
    await turnClosed(f);
    expect([f.file('src/app.ts'), f.runtime.plans.plans().at(-1)?.status]).toEqual(["export const greeting = 'hello';\n", 'done']);
  });

  it('withdraws a waiting plan when the user presses Stop', async () => {
    const f = await flow('gate-big-plan');
    f.session.send('fix them');
    await waitFor(() => f.runtime.plans.plans().some((plan) => plan.status === 'proposed'), 'plan proposed', 10_000);
    f.session.stop();
    await waitFor(() => f.runtime.plans.plans().at(-1)?.status === 'withdrawn', 'plan withdrawn', 10_000);
    expect(f.runtime.plans.plans().map((plan) => [plan.status, plan.feedback])).toEqual([['withdrawn', "The agent's call was cancelled."]]);
  });

  it('asks the user in mode B, with the agent’s reason, and lets an out-of-plan write through once', async () => {
    const f = await flow('gate-out-of-plan');
    f.session.send('fix it');
    const prompt = await pendingPrompt(f);
    expect(prompt).toMatchObject({ reason: 'src/other.ts has the same typo.', targets: [{ path: 'src/other.ts', inScope: false, componentId: 'app' }] });
    f.runtime.gate.answer(prompt.id, 'allow-once');
    await turnClosed(f);
    expect([f.file('src/other.ts'), f.tool('toolu_fx_other')?.decision]).toEqual(["export const other = 'hello';\n", 'ask-approved']);
  });

  it('keeps the file unchanged when the user denies the out-of-plan write', async () => {
    const f = await flow('gate-out-of-plan');
    f.session.send('fix it');
    f.runtime.gate.answer((await pendingPrompt(f)).id, 'deny');
    await turnClosed(f);
    expect([f.file('src/other.ts'), f.tool('toolu_fx_other')?.status]).toEqual([ORIGINAL['src/other.ts'], 'error']);
  });

  it('denies an out-of-plan write in mode A without asking', async () => {
    const f = await flow('gate-out-of-plan', { mode: 'A' });
    f.session.send('fix it');
    await turnClosed(f);
    expect([f.file('src/other.ts'), f.runtime.gate.prompts(), f.runtime.plans.plans().map((plan) => plan.status)]).toEqual([ORIGINAL['src/other.ts'], [], ['approved']]);
  });

  it('lets an out-of-plan write through in mode C and flags it', async () => {
    const f = await flow('gate-out-of-plan', { mode: 'C' });
    f.session.send('fix it');
    await turnClosed(f);
    expect([f.file('src/other.ts'), f.tool('toolu_fx_other')?.decision]).toEqual(["export const other = 'hello';\n", 'flag']);
  });

  it('drops the prompt when Stop ends the waiting call', async () => {
    const f = await flow('gate-out-of-plan');
    f.session.send('fix it');
    await pendingPrompt(f);
    f.session.stop();
    await turnClosed(f);
    expect([f.runtime.gate.prompts().map((prompt) => prompt.status), f.file('src/other.ts')]).toEqual([['dropped'], ORIGINAL['src/other.ts']]);
  });

  it('drops a waiting prompt whose call never reached the stream when the claude process is killed', async () => {
    const f = await flow('gate-out-of-plan-unstreamed');
    f.session.send('fix it');
    await pendingPrompt(f);
    process.kill(f.records().find((record) => record.pid !== undefined)?.pid as number, 'SIGKILL');
    await waitFor(() => f.session.state().session?.status === 'crashed', 'claude exited', 10_000);
    expect([f.runtime.gate.prompts().map((prompt) => prompt.status), f.file('src/other.ts')]).toEqual([['dropped'], ORIGINAL['src/other.ts']]);
  });

  it('runs a shell command that only reads without a plan, and blocks one that writes', async () => {
    const f = await flow('gate-bash');
    f.session.send('look around');
    await turnClosed(f);
    expect([f.tool('toolu_fx_ls')?.decision, f.tool('toolu_fx_echo')?.status, f.tool('toolu_fx_echo')?.decision]).toEqual(['unchecked', 'error', 'deny']);
  });

  it('blocks every call when the core cannot be reached', async () => {
    const f = await flow('gate-no-plan');
    await f.server.close();
    f.session.send('fix it');
    await turnClosed(f);
    expect([f.file('src/app.ts'), f.records().find((record) => record.hook)?.hook]).toEqual([
      ORIGINAL['src/app.ts'],
      expect.objectContaining({ allowed: false, exit: 2, reason: expect.stringContaining('IDE core unreachable') }),
    ]);
  });
});
