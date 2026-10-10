import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ChatItem, ToolItem } from '@ide/protocol';
import { AgentSession } from '../../src/agent/agent-session';
import { createGateRuntime } from '../../src/gate/runtime';
import { projectDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer, type RunningServer } from '../../src/server/server';
import { openStore } from '../../src/store/store';
import { FAKE_CLAUDE, fakeClaude, readRecords } from './fake';
import { tempDir, waitFor } from '../helpers';

const INIT = { type: 'system', subtype: 'init', cwd: '$CWD', session_id: '$SESSION', mcp_servers: [], model: 'claude-haiku-4-5-20251001', permissionMode: 'bypassPermissions', claude_code_version: '2.1.296' };
const text = (value: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] }, parent_tool_use_id: null, session_id: '$SESSION' });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: '$SESSION' };
const AWAIT = { fake: 'await-user' };
const writer = (overrides: object = {}) => ({
  fake: 'mcp-write', id: 'toolu_w', server: 'files', tool: 'write', files: [{ path: 'a.txt', content: 'A' }], ...overrides,
});

function scenarioFile(lines: object[]): string {
  const file = join(tempDir('ide-scenario-'), 'scenario.jsonl');
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

async function run(lines: object[]) {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const store = openStore(projectDir(home, root));
  let server: RunningServer | undefined;
  const runtime = createGateRuntime({
    root, home, store, policy: () => ({ ...DEFAULT_POLICY, mode: 'B' }), components: () => [],
    port: () => server?.port ?? 0, userHome: tempDir('ide-user-home-'), tempRoots: [],
  });
  const recordFile = join(home, 'record.jsonl');
  const session = new AgentSession({
    root, home, store, claude: fakeClaude(scenarioFile(lines), recordFile),
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
  const tool = (id: string) => session.state().items.find((item): item is ToolItem => item.kind === 'tool' && item.id === id);
  return {
    session, root, tool,
    records: () => readRecords(recordFile),
    read: (rel: string) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel: string) => existsSync(join(root, rel)),
    files: () => readdirSync(root).filter((name) => name.endsWith('.txt')).sort(),
    closedTurns: () => session.state().turns.filter((turn) => turn.closedAt !== null),
    turnClosed: (count = 1) => waitFor(() => session.state().turns.filter((turn) => turn.closedAt !== null).length >= count, 'turn closed', 10_000),
  };
}

const items = (h: Awaited<ReturnType<typeof run>>): ChatItem[] => h.session.state().items;

describe('the fake claude', { timeout: 20_000 }, () => {
  it('writes files through mcp-write and runs the hook for it', async () => {
    const h = await run([AWAIT, INIT, writer({ files: [{ path: 'a.txt', content: 'A' }, { path: 'deep/b.txt', content: 'B' }] }), RESULT, AWAIT]);
    h.session.send('go');
    await h.turnClosed();
    expect(h.read('a.txt')).toBe('A');
    expect(h.read('deep/b.txt')).toBe('B');
    expect(h.tool('toolu_w')).toMatchObject({ tool: 'mcp__files__write', status: 'ok' });
    expect(h.records().some((r) => r.hook?.tool === 'mcp__files__write' && r.hook.allowed)).toBe(true);
  });

  it('skips the hook for skipHook calls on mcp-write and on tool', async () => {
    const tool = { fake: 'tool', id: 'toolu_t', name: 'Write', input: { file_path: '$CWD/t.txt', content: 'T' }, apply: true, skipHook: true };
    const h = await run([AWAIT, INIT, writer({ skipHook: true }), tool, RESULT, AWAIT]);
    h.session.send('go');
    await h.turnClosed();
    expect(h.read('a.txt')).toBe('A');
    expect(h.read('t.txt')).toBe('T');
    expect(h.tool('toolu_w')?.status).toBe('ok');
    expect(h.tool('toolu_t')?.status).toBe('ok');
    expect(h.records().filter((r) => r.hook)).toEqual([]);
  });

  const five = Array.from({ length: 5 }, (_, at) => ({ path: `f${at}.txt`, content: `${at}` }));

  it('stops writing at once on an interrupt when the server honors cancel', async () => {
    const h = await run([AWAIT, INIT, writer({ files: five, perFileMs: 300 }), RESULT, AWAIT]);
    h.session.send('go');
    await waitFor(() => h.exists('f0.txt'), 'first file written');
    expect(h.session.stop()).toBe(true);
    await h.turnClosed();
    expect(h.closedTurns()[0]?.resultSubtype).toBe('error_during_execution');
    expect(h.tool('toolu_w')?.status).toBe('rejected');
    await waitFor(() => h.records().some((r) => r.mcpWrite), 'writer finished');
    expect(h.files()).toEqual(['f0.txt']);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(h.files()).toEqual(['f0.txt']);
  });

  it('keeps writing after the interrupt when the server ignores cancel', async () => {
    const h = await run([AWAIT, INIT, writer({ files: five, perFileMs: 150, honorCancel: false }), RESULT, AWAIT]);
    h.session.send('go');
    await waitFor(() => h.exists('f0.txt'), 'first file written');
    expect(h.session.stop()).toBe(true);
    await h.turnClosed();
    expect(h.closedTurns()[0]?.resultSubtype).toBe('error_during_execution');
    expect(h.tool('toolu_w')?.status).toBe('rejected');
    expect(h.files().length).toBeLessThan(5);
    await waitFor(() => h.files().length === 5, 'every file written', 10_000);
    expect(h.tool('toolu_w')?.status).toBe('rejected');
  });

  it('marks a subagent call with parent_tool_use_id', async () => {
    const h = await run([
      AWAIT, INIT,
      { fake: 'tool', id: 'toolu_child', name: 'Bash', input: { command: 'true' }, parent: 'toolu_agent' },
      writer({ parent: 'toolu_agent', skipHook: true }),
      { fake: 'tool', id: 'toolu_main', name: 'Bash', input: { command: 'true' } },
      RESULT, AWAIT,
    ]);
    h.session.send('go');
    await h.turnClosed();
    expect(h.tool('toolu_child')).toMatchObject({ parentToolUseId: 'toolu_agent', status: 'ok' });
    expect(h.tool('toolu_w')).toMatchObject({ parentToolUseId: 'toolu_agent', status: 'ok' });
    expect(h.tool('toolu_main')?.parentToolUseId).toBeNull();
    expect(h.records().find((r) => r.hook?.id === 'toolu_child')).toBeDefined();
  });

  it('keeps a background command running across an interrupt and reports its end', async () => {
    const scratch = tempDir('ide-bg-');
    const stopFlag = join(scratch, 'stop.flag');
    onTestFinished(() => {
      writeFileSync(stopFlag, '');
    });
    const command = `while [ ! -e ${stopFlag} ]; do sleep 0.05; done`;
    const h = await run([
      AWAIT, INIT,
      { fake: 'tool', id: 'toolu_bg', name: 'Bash', input: { command, description: 'background' }, background: true, result: 'Command running in background' },
      { fake: 'task-end', toolUseId: 'toolu_bg', status: 'completed', after: 'toolu_bg' },
      { fake: 'sleep', ms: 30_000 },
      AWAIT, INIT, text('ALIVE'), RESULT, AWAIT,
    ]);
    h.session.send('go');
    await waitFor(() => h.tool('toolu_bg')?.status === 'ok', 'background call returned');
    expect(h.session.state().tasks).toMatchObject([{ kind: 'shell', status: 'running', toolUseId: 'toolu_bg' }]);
    const pid = await waitFor(() => h.records().find((r) => r.background)?.background?.pid, 'pid recorded');
    onTestFinished(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    });
    expect(h.session.stop()).toBe(true);
    await h.turnClosed();
    expect(isAlive(pid)).toBe(true);
    expect(h.session.state().tasks).toMatchObject([{ kind: 'shell', status: 'running' }]);
    writeFileSync(stopFlag, '');
    await waitFor(() => h.session.state().tasks[0]?.status === 'completed', 'task end reported');
    expect(isAlive(pid)).toBe(false);
  });

  describe.each([
    ['stdin closes', (child: ChildProcess) => child.stdin?.end(), []],
    ['it gets SIGTERM', (child: ChildProcess) => child.kill('SIGTERM'), []],
    ['it runs an exit step', () => {}, [{ fake: 'exit', code: 0 }]],
  ] as const)('when %s', (_name, end, tail) => {
    it('takes its background shell down with it', async () => {
      const scratch = tempDir('ide-bg-');
      const stopFlag = join(scratch, 'stop.flag');
      const recordFile = join(scratch, 'record.jsonl');
      const command = `while [ ! -e ${stopFlag} ]; do sleep 0.05; done`;
      const file = scenarioFile([
        AWAIT, INIT, { fake: 'tool', id: 'toolu_bg', name: 'Bash', input: { command }, background: true }, RESULT, AWAIT, ...tail,
      ]);
      const child = spawn(process.execPath, [FAKE_CLAUDE], {
        cwd: scratch, env: { ...process.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_RECORD: recordFile }, stdio: ['pipe', 'ignore', 'ignore'],
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      onTestFinished(() => {
        writeFileSync(stopFlag, '');
        child.kill('SIGKILL');
      });
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
      const pid = await waitFor(() => readRecords(recordFile).find((r) => r.background)?.background?.pid, 'pid recorded');
      onTestFinished(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      });
      expect(isAlive(pid)).toBe(true);
      if (tail.length > 0) child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' } })}\n`);
      end(child);
      await exited;
      await waitFor(() => !isAlive(pid), 'background shell gone');
    });
  });

  it('kills a background subagent on an interrupt with no turn open, without a turn', async () => {
    const spawnAgent = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Sub' } }] }, parent_tool_use_id: null, session_id: '$SESSION' };
    const agent = { type: 'system', subtype: 'task_started', task_id: 'task_a', tool_use_id: 'toolu_agent', description: 'Sub', is_backgrounded: true, task_type: 'local_agent', session_id: '$SESSION' };
    const file = scenarioFile([AWAIT, INIT, spawnAgent, agent, text('started'), RESULT, { fake: 'sleep', ms: 30_000 }, AWAIT, INIT, text('SECOND'), RESULT, AWAIT]);
    const child = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: tempDir('ide-cwd-'), env: { ...process.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_HOOKS: 'off' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    onTestFinished(() => {
      child.kill('SIGKILL');
    });
    const seen: { type: string; subtype?: string; status?: string; patch?: { status: string } }[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => seen.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
    await waitFor(() => seen.some((event) => event.type === 'result'), 'first turn closed');
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } })}\n`);
    await waitFor(() => seen.some((event) => event.type === 'control_response'), 'interrupt answered');
    expect(seen.slice(seen.findIndex((event) => event.type === 'result') + 1).map((event) => [event.type, event.subtype ?? null, event.status ?? event.patch?.status ?? null])).toEqual([
      ['system', 'task_updated', 'killed'],
      ['system', 'task_notification', 'stopped'],
      ['control_response', null, null],
    ]);
  });

  it('answers a denied prompt with a denial, not the approval', async () => {
    const ask = {
      type: 'control_request', request_id: 'req_a',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', tool_use_id: 'toolu_ask', input: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: 'a' }], multiSelect: false }] } },
    };
    const branch = (when: string, value: string) => ({ ...text(value), when });
    const lines = [AWAIT, INIT, ask, { fake: 'await-control-response', request: 'req_a' }, branch('allow', 'APPROVED'), branch('deny', 'DENIED'), RESULT, AWAIT];
    const denied = await run(lines);
    denied.session.send('go');
    await waitFor(() => items(denied).some((item) => item.kind === 'prompt' && item.status === 'pending'), 'prompt shown');
    denied.session.answerPrompt('req_a', { kind: 'deny', feedback: 'no' });
    await denied.turnClosed();
    const said = (h: typeof denied) => items(h).flatMap((item) => (item.kind === 'message' && item.role === 'assistant' ? [item.text] : []));
    expect(said(denied)).toEqual(['DENIED']);

    const allowed = await run(lines);
    allowed.session.send('go');
    await waitFor(() => items(allowed).some((item) => item.kind === 'prompt' && item.status === 'pending'), 'prompt shown');
    allowed.session.answerPrompt('req_a', { kind: 'answers', answers: { 'Which?': 'A' } });
    await allowed.turnClosed();
    expect(said(allowed)).toEqual(['APPROVED']);
  });

  it('does not treat $& in an Edit new_string as a replacement pattern', async () => {
    const h = await run([
      AWAIT, INIT,
      { fake: 'tool', id: 'toolu_w0', name: 'Write', input: { file_path: '$CWD/e.txt', content: 'one two' }, apply: true, skipHook: true },
      { fake: 'tool', id: 'toolu_e', name: 'Edit', input: { file_path: '$CWD/e.txt', old_string: 'two', new_string: '[$&]' }, apply: true, skipHook: true },
      RESULT, AWAIT,
    ]);
    h.session.send('go');
    await h.turnClosed();
    expect(h.read('e.txt')).toBe('one [$&]');
  });
});
