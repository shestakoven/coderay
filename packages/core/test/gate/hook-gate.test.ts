import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ControlMode, PlanTarget } from '@ide/protocol';
import { GateError, HookGate, type GateContext } from '../../src/gate/hook-gate';
import { hookRoute } from '../../src/gate/hook-route';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer } from '../../src/server/server';
import { openStore, type ToolDecisionRecord } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

interface Options {
  mode?: ControlMode;
  holdMs?: number;
  context?: GateContext;
}

async function setup(options: Options = {}) {
  const root = tempDir('ide-hook-gate-');
  await writeTree(root, { 'src/app.ts': 'a', 'src/other.ts': 'b', 'src/lib/util.ts': 'c', '.gitignore': 'dist/\n.env\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = tempDir('ide-fake-home-');
  const store = openStore(tempDir('ide-store-'));
  onTestFinished(() => store.close());
  store.saveSession(sessionRecord('s1', root));
  const policy = { ...DEFAULT_POLICY, mode: options.mode ?? 'B' };
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy, components, home, tempRoots: [] }),
  });
  const gate = new HookGate({
    root, store, sessionId: () => 's1', policy: () => policy, plans, components: () => components,
    context: () => options.context ?? { parentToolUseId: null, lastMessage: 'Fixing the greeting.' },
    home, tempRoots: [], holdMs: options.holdMs,
  });
  const decisions: ToolDecisionRecord[] = [];
  gate.onDecision((decision) => decisions.push(decision));
  const call = (tool: string, input: object, signal = new AbortController().signal, id = 'toolu_1') =>
    gate.evaluate({ tool_name: tool, tool_input: input, tool_use_id: id, cwd: root }, signal);
  const approve = async (targets: PlanTarget[] = [{ path: 'src/app.ts', op: 'modify' }]) => {
    await plans.propose({ goal: 'Fix', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets }] });
    plans.step({ key: 'edit', phase: 'start' });
  };
  const pending = () => waitFor(() => gate.prompts().find((prompt) => prompt.status === 'pending'), 'prompt shown');
  return { root, home, store, plans, gate, decisions, call, approve, pending };
}

describe('HookGate', () => {
  it('denies a Write before any plan and tells the agent to call propose_plan', async () => {
    const { root, call, decisions } = await setup();
    const answer = await call('Write', { file_path: join(root, 'src/app.ts'), content: 'x' });
    expect(answer?.permissionDecision).toBe('deny');
    expect(answer?.permissionDecisionReason).toMatch(/^IDE: no approved plan covers src\/app\.ts\. Call mcp__idecore__propose_plan/);
    expect(decisions.map((decision) => [decision.decision, decision.targets])).toEqual([['deny', ['src/app.ts']]]);
  });

  it("lets reads, subagents, configured MCP tools and the IDE's own tools through without a plan", async () => {
    const { call } = await setup();
    const answers = await Promise.all(['Read', 'Agent', 'mcp__docs__search', 'mcp__idecore__propose_plan'].map((tool) => call(tool, {})));
    expect(answers.map((answer) => answer?.permissionDecision)).toEqual(['allow', 'allow', 'allow', 'allow']);
  });

  it('runs a shell command that writes no project file without a plan, and blocks one that does', async () => {
    const { call } = await setup();
    expect((await call('Bash', { command: 'npm test && ls -la' }))?.permissionDecision).toBe('allow');
    expect((await call('Bash', { command: 'echo x > src/new.ts' }))?.permissionDecision).toBe('deny');
  });

  it("lets writes to gitignored files and to Claude Code's plan files through without a plan", async () => {
    const { root, home, call } = await setup();
    expect((await call('Write', { file_path: join(root, 'dist/app.js') }))?.permissionDecision).toBe('allow');
    expect((await call('Write', { file_path: join(home, '.claude/plans/plan.md') }))?.permissionDecision).toBe('allow');
  });

  it('blocks a guarded file even when it is gitignored', async () => {
    const { root, call } = await setup();
    expect((await call('Write', { file_path: join(root, '.env') }))?.permissionDecision).toBe('deny');
  });

  it('allows an in-scope write and records the plan and the step on the decision', async () => {
    const { root, call, approve, decisions } = await setup();
    await approve();
    expect((await call('Edit', { file_path: join(root, 'src/app.ts'), old_string: 'a', new_string: 'b' }))?.permissionDecision).toBe('allow');
    expect(decisions.at(-1)).toMatchObject({ decision: 'allow', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'] });
  });

  it("asks the user about an out-of-scope write in mode B, with the agent's reason, and lets it through once", async () => {
    const { root, call, approve, pending, gate, decisions, store } = await setup();
    await approve();
    const answer = call('Edit', { file_path: join(root, 'src/other.ts'), old_string: 'b', new_string: 'c' });
    const prompt = await pending();
    expect(prompt).toMatchObject({
      tool: 'Edit', reason: 'Fixing the greeting.', canExpand: true, mode: 'B',
      preview: { kind: 'edit', oldString: 'b', newString: 'c', truncated: false },
      targets: [{ path: 'src/other.ts', kind: 'enforced', inScope: false, componentId: 'app' }],
    });
    gate.answer(prompt.id, 'allow-once');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect([decisions.at(-1)?.decision, store.gateEvents('s1').map((event) => event.resolution)]).toEqual(['ask-approved', ['allowed-once']]);
  });

  it('denies the out-of-scope write when the user says no', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    gate.answer((await pending()).id, 'deny');
    expect((await answer)?.permissionDecisionReason).toBe("IDE: the user denied this call (src/other.ts). Stop and wait for the user's next message.");
  });

  it('expands the plan from the prompt and then allows the call under the new version', async () => {
    const { root, call, approve, pending, gate, plans } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts'), content: 'x' });
    gate.answer((await pending()).id, 'expand-plan');
    expect((await answer)?.permissionDecision).toBe('allow');
    expect(plans.gate()).toMatchObject({ version: 2, scope: { paths: ['src/app.ts', 'src/other.ts'] } });
  });

  it('denies an out-of-scope write in mode A without asking, and records the denial', async () => {
    const { root, call, approve, gate, store } = await setup({ mode: 'A' });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecision).toBe('deny');
    expect([gate.prompts(), store.gateEvents('s1').map((event) => event.resolution)]).toEqual([[], ['denied']]);
  });

  it('allows and flags an out-of-scope write in mode C', async () => {
    const { root, call, approve, store, decisions } = await setup({ mode: 'C' });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecision).toBe('allow');
    expect([decisions.at(-1)?.decision, store.gateEvents('s1').map((event) => event.resolution)]).toEqual(['flag', ['flagged']]);
  });

  it('drops the prompt when the hook connection closes, and refuses a late answer', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const closed = new AbortController();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') }, closed.signal);
    const prompt = await pending();
    closed.abort();
    expect(await answer).toBeNull();
    expect(gate.prompts().map((view) => view.status)).toEqual(['dropped']);
    expect(() => gate.answer(prompt.id, 'allow-once')).toThrow(GateError);
  });

  it('drops the prompt and denies when its tool call ends in the stream', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    await pending();
    gate.dropForTool('toolu_1');
    expect((await answer)?.permissionDecisionReason).toBe('IDE: the call ended before the user answered.');
  });

  it('denies with "did not respond" at the hold limit', async () => {
    const { root, call, approve } = await setup({ holdMs: 50 });
    await approve();
    expect((await call('Write', { file_path: join(root, 'src/other.ts') }))?.permissionDecisionReason)
      .toBe("IDE: the user did not respond in time. Stop and wait for the user's next message.");
  });

  it('refuses a second answer to the same prompt', async () => {
    const { root, call, approve, pending, gate } = await setup();
    await approve();
    const answer = call('Write', { file_path: join(root, 'src/other.ts') });
    const prompt = await pending();
    gate.answer(prompt.id, 'allow-once');
    await answer;
    expect(() => gate.answer(prompt.id, 'deny')).toThrow(GateError);
  });

  it('does not offer to expand the plan for a target outside the project', async () => {
    const { call, approve, pending, gate } = await setup();
    await approve();
    void call('Write', { file_path: join(tempDir('ide-elsewhere-'), 'x.txt') });
    const prompt = await pending();
    expect([prompt.canExpand, prompt.targets.map((target) => target.kind)]).toEqual([false, ['outside']]);
    expect(() => gate.answer(prompt.id, 'expand-plan')).toThrow(GateError);
  });

  it('asks about a tool the IDE does not know, with no targets', async () => {
    const { call, pending } = await setup();
    void call('BrandNewTool', { anything: 1 });
    expect(await pending()).toMatchObject({ tool: 'BrandNewTool', targets: [], canExpand: false, preview: { kind: 'input' } });
  });

  it('judges a 5 MB Write and caps its preview', async () => {
    const { root, call, approve, pending } = await setup();
    await approve();
    void call('Write', { file_path: join(root, 'src/other.ts'), content: 'x'.repeat(5_000_000) });
    const prompt = await pending();
    expect(prompt.preview).toMatchObject({ kind: 'write', truncated: true });
    expect(prompt.preview.kind === 'write' ? prompt.preview.content.length : 0).toBe(20_000);
  });

  it('judges each file that mv moves into a directory', async () => {
    const { call, approve, pending } = await setup();
    await approve();
    void call('Bash', { command: 'mv src/app.ts src/lib' });
    expect((await pending()).targets.map((target) => [target.path, target.inScope])).toEqual([['src/app.ts', true], ['src/lib/app.ts', false]]);
  });
});

describe('hookRoute', () => {
  async function served() {
    const { gate, root } = await setup();
    const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [hookRoute({ secret: 's3cret', gate })] });
    onTestFinished(() => server.close());
    const post = (secret: string, body: object) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/hook', method: 'POST', headers: { authorization: `Bearer ${secret}` } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    return { post, root };
  }

  it('refuses a hook call without the agent secret', async () => {
    const { post } = await served();
    expect((await post('wrong', {})).status).toBe(401);
  });

  it('answers a hook call with the decision as JSON', async () => {
    const { post, root } = await served();
    const response = await post('s3cret', { tool_name: 'Write', tool_use_id: 't', tool_input: { file_path: join(root, 'src/app.ts') }, cwd: root });
    expect([response.status, JSON.parse(response.body).permissionDecision]).toEqual([200, 'deny']);
  });

  it('carries a 5 MB Write hook input through real HTTP and gets a decision back', async () => {
    const { post, root } = await served();
    const response = await post('s3cret', {
      tool_name: 'Write', tool_use_id: 't2', cwd: root,
      tool_input: { file_path: join(root, 'src/app.ts'), content: 'x'.repeat(5_000_000) },
    });
    expect(response.status).toBe(200);
    expect(typeof JSON.parse(response.body).permissionDecision).toBe('string');
  });
});
