import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_SCRIPT, HOOK_SCRIPT } from '../../src/hook/gate-files';
import { waitFor } from '../helpers';
import { build, pendingEvent, WAIT_TURN, type BuildOptions } from './harness';

interface Settings {
  hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
}

const RESTORED = 'Restored to their earlier content: src/b.ts.';
const REVERT = { kind: 'all', answer: 'revert' } as const;
const STOP = { last_assistant_message: 'Done.', background_tasks: [] };
const GENERATOR = { tool_name: 'Bash', tool_input: { command: './gen.sh' }, tool_use_id: 'toolu_gen' };
const writeC = (root: string, id: string) => ({ tool_name: 'Write', tool_input: { file_path: `${root}/src/c.ts`, content: 'c' }, tool_use_id: id });

// An agent in a terminal whose generator script writes src/b.ts, which the approved plan does not cover; every hook runs as claude runs it.
async function terminal(options: Pick<BuildOptions, 'mode' | 'runtime'> = {}) {
  const b = await build({ scenario: WAIT_TURN, claudeEnv: { FAKE_CLAUDE_HOOKS: 'on' }, ...options });
  const launch = await b.session.terminalLaunch();
  if (launch === null) throw new Error('the terminal did not open');
  const settingsPath = launch.args[launch.args.indexOf('--settings') + 1] as string;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
  const claudeId = b.session.state().session?.claudeSessionId as string;
  const run = (script: string, name: string, fields: object = {}) => {
    const command = settings.hooks[name]?.flatMap((entry) => entry.hooks).find((hook) => hook.args[0] === script);
    if (!command) throw new Error(`no ${name} hook runs ${script}`);
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout })));
    const payload = { hook_event_name: name, session_id: claudeId, transcript_path: '/nonexistent/claude.jsonl', cwd: b.root, permission_mode: 'default', ...fields };
    child.stdin.end(JSON.stringify(payload));
    return done;
  };
  await b.rt.gate.plans.propose({ goal: 'generate', steps: [{ key: 's1', title: 'a and c', rationale: 'r', targets: [{ path: 'src/a.ts', op: 'create' }, { path: 'src/c.ts', op: 'create' }] }] });
  b.rt.gate.plans.step({ key: 's1', phase: 'start' });
  const t = {
    b,
    event: (name: string, fields?: object) => run(AGENT_EVENT_SCRIPT, name, fields),
    gate: async (fields: object) => {
      const { code, stdout } = await run(HOOK_SCRIPT, 'PreToolUse', fields);
      return { code, ...(stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; additionalContext?: string } }).hookSpecificOutput) };
    },
    waiting: (count: number) => waitFor(() => b.rt.hold.waiting() === count, `${count} hook(s) waiting for the user`),
    // The agent's generator writes a file the plan does not cover, so the watchdog asks the user.
    outOfPlan: async () => {
      await t.event('UserPromptSubmit', { prompt: 'run the generator' });
      await t.gate(GENERATOR);
      b.write('src/b.ts', 'export const b = 2;\n');
      const event = await pendingEvent(b);
      await t.event('PostToolUse', { ...GENERATOR, tool_response: {} });
      return event;
    },
  };
  return t;
}

describe('the agent in a terminal while the watchdog asks the user about its change', { timeout: 30_000 }, () => {
  it('holds its next call at the gate instead of pressing Esc, and the answer goes on with that call, once', async () => {
    const t = await terminal();
    const event = await t.outOfPlan();
    expect([t.b.typed, event.interrupted, t.b.session.hasOpenTurn()]).toEqual([[], false, true]);
    const call = t.gate(writeC(t.b.root, 'toolu_c1'));
    await t.waiting(1);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    expect(await call).toMatchObject({ code: 0, permissionDecision: 'allow', additionalContext: expect.stringContaining(RESTORED) });
    expect(existsSync(join(t.b.root, 'src/b.ts'))).toBe(false);
    expect(await t.gate(writeC(t.b.root, 'toolu_c2'))).not.toHaveProperty('additionalContext');
    expect([t.b.typed, t.b.session.hasOpenTurn()]).toEqual([[], true]);
  });

  it('holds the end of its turn at the Stop hook, and the answer makes claude go on with the same turn', async () => {
    const t = await terminal();
    const event = await t.outOfPlan();
    const stop = t.event('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [] });
    await t.waiting(1);
    expect(t.b.session.hasOpenTurn()).toBe(true);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    const { code, stdout } = await stop;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ decision: 'block', reason: expect.stringContaining(RESTORED) });
    expect(t.b.session.hasOpenTurn()).toBe(true);
  });

  it('ends the turn when the user does not answer within the hold, and the late answer goes with the next prompt', async () => {
    const t = await terminal({ runtime: { holdMs: 300 } });
    const event = await t.outOfPlan();
    const stepQuestion = await t.event('Stop', { ...STOP, stop_hook_active: false });
    expect(JSON.parse(stepQuestion.stdout)).toEqual({ decision: 'block', reason: expect.not.stringContaining(RESTORED) });
    const stop = await t.event('Stop', { ...STOP, stop_hook_active: true });
    expect([stop, t.b.session.hasOpenTurn()]).toEqual([{ code: 0, stdout: '' }, false]);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    const prompt = await t.event('UserPromptSubmit', { prompt: 'continue' });
    expect(JSON.parse(prompt.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining(RESTORED) } });
  });

  it('stops waiting for a Stop hook claude gave up on, so the answer reaches the agent with its next call instead of being lost', async () => {
    const t = await terminal({ runtime: { hookDeadlineMs: 400 } });
    const event = await t.outOfPlan();
    let stop: { code: number | null; stdout: string } | undefined;
    void t.event('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [] }).then((result) => (stop = result));
    await waitFor(() => stop, 'the Stop hook to give up at its deadline', 3_000);
    expect(stop).toEqual({ code: 0, stdout: '' });
    await t.waiting(0);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    expect(await t.gate(writeC(t.b.root, 'toolu_c1'))).toMatchObject({ permissionDecision: 'allow', additionalContext: expect.stringContaining(RESTORED) });
  });

  it('hands the answer to the main agent, not to the background subagent that made the change', async () => {
    const t = await terminal();
    await t.event('UserPromptSubmit', { prompt: 'run the generator in the background' });
    const spawned = { tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', run_in_background: true }, tool_use_id: 'toolu_agent' };
    await t.gate(spawned);
    await t.event('PostToolUse', { ...spawned, tool_response: { isAsync: true, agentId: 'agent-1' } });
    const sub = { agent_id: 'agent-1', agent_type: 'general-purpose' };
    await t.gate({ ...GENERATOR, ...sub, tool_use_id: 'toolu_sub1' });
    t.b.write('src/b.ts', 'export const b = 2;\n');
    const event = await pendingEvent(t.b);
    expect([event.paused, event.interrupted, t.b.typed]).toEqual([true, false, []]);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    expect(await t.gate({ ...writeC(t.b.root, 'toolu_sub2'), ...sub })).not.toHaveProperty('additionalContext');
    expect(await t.gate(writeC(t.b.root, 'toolu_main'))).toMatchObject({ additionalContext: expect.stringContaining(RESTORED) });
  });

  it('carries the answer in the reason of a call the gate denies, which has no context to carry it', async () => {
    const t = await terminal({ mode: 'A' });
    const event = await t.outOfPlan();
    const call = t.gate({ tool_name: 'Write', tool_input: { file_path: `${t.b.root}/src/other.ts`, content: 'x' }, tool_use_id: 'toolu_out' });
    await t.waiting(1);
    await t.b.rt.watchdog.answer(event.id, REVERT);
    const answer = await call;
    expect(answer).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(RESTORED) });
    expect(answer).not.toHaveProperty('additionalContext');
  });
});

describe('the end of a turn with a plan step still active', { timeout: 30_000 }, () => {
  it('asks the agent once to close the step, then lets the turn end', async () => {
    const t = await terminal();
    await t.event('UserPromptSubmit', { prompt: 'make a and c' });
    const first = await t.event('Stop', { ...STOP, stop_hook_active: false });
    expect(JSON.parse(first.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining('step "s1" (a and c) is still active') });
    expect(await t.event('Stop', { ...STOP, stop_hook_active: true })).toEqual({ code: 0, stdout: '' });
  });
});
