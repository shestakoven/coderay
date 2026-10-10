import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { sdkOptions, startSdkTransport } from '../../src/agent/sdk-transport';
import type { Launch } from '../../src/agent/transport';
import { fakeClaude, readRecords } from '../fake-claude/fake';
import { tempDir, waitFor } from '../helpers';

// Before the imports load the SDK, which writes this variable as it loads; a core started from Claude Code inherits it.
vi.hoisted(() => {
  delete process.env.NoDefaultCurrentDirectoryInExePath;
});

const SESSION = '0b6f5a52-7c43-4c43-9a43-5d1d0c0e5a11';
const HI = { type: 'user' as const, message: { role: 'user' as const, content: 'hi' }, parent_tool_use_id: null };

function launch(scenario: string, record: string): Launch {
  const mcpConfigPath = join(tempDir('ide-mcp-'), 'mcp.json');
  writeFileSync(mcpConfigPath, '{"mcpServers":{}}');
  return {
    claude: fakeClaude(scenario, record), cwd: tempDir('ide-cwd-'), claudeSessionId: SESSION, resume: false,
    model: null, effort: null, mcpConfigPath, disallowedTools: ['WebSearch'], gate: null, killGraceMs: 500,
  };
}

function start(scenario: string) {
  const record = join(tempDir('ide-fake-'), 'record.jsonl');
  const messages: Record<string, unknown>[] = [];
  const transport = startSdkTransport(launch(scenario, record), { message: (value) => messages.push(value as Record<string, unknown>) });
  // The session's sink refers to the transport the start returns, so nothing may reach it before.
  expect(messages).toEqual([]);
  onTestFinished(async () => {
    await transport.kill();
  });
  const kinds = () => messages.map((m) => (m.type === 'system' ? `system/${String(m.subtype)}` : String(m.type)));
  return { transport, messages, kinds, records: () => readRecords(record) };
}

const promptRequested = (messages: Record<string, unknown>[]) => waitFor(() => messages.some((m) => m.type === 'control_request'), 'prompt requested');

describe('sdkOptions', () => {
  it("starts the user's claude in bypass with Claude Code's prompt plus CodeRay's, the gate's settings and the MCP config file, never inline", () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const base = { ...launch('multi-turn', '/dev/null'), claude: { command: '/opt/claude', args: [], env: { CLAUDE_CONFIG_DIR: '/accounts/a' } } };
    const { env, ...fresh } = sdkOptions({ ...base, model: 'opus', effort: 'high', gate: { settingsPath: '/run/x.settings.json', appendSystemPrompt: 'CodeRay rules' } });
    expect(fresh).toEqual({
      pathToClaudeCodeExecutable: '/opt/claude', cwd: base.cwd, sessionId: SESSION, model: 'opus', effort: 'high',
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, includePartialMessages: true, disallowedTools: ['WebSearch'],
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: 'CodeRay rules' },
      settings: '/run/x.settings.json', extraArgs: { 'mcp-config': base.mcpConfigPath },
    });
    expect([env?.CLAUDE_CONFIG_DIR, env?.CLAUDECODE, env?.CLAUDE_CODE_ENTRYPOINT]).toEqual(['/accounts/a', undefined, undefined]);
    const { env: _env, ...resumed } = sdkOptions({ ...base, resume: true });
    expect([resumed.resume, resumed.systemPrompt, ['sessionId', 'model', 'effort', 'settings'].filter((key) => key in resumed)])
      .toEqual([SESSION, { type: 'preset', preset: 'claude_code', snapshot: false }, []]);
  });
});

describe('startSdkTransport', () => {
  it("runs claude with the SDK's markers and the core's NODE_OPTIONS, and leaves the core's environment as it was", async () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const before = process.env.CLAUDE_AGENT_SDK_VERSION;
    const t = start('multi-turn');
    const first = await waitFor(() => t.records().find((r) => r.argv), 'claude started');
    expect([first.entrypoint, typeof first.sdkVersion, first.nodeOptions, process.env.CLAUDE_AGENT_SDK_VERSION]).toEqual(['sdk-ts', 'string', true, before]);
    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  it('asks for a prompt only after the tool call it is for, with the same request id, and gives claude the answer', async () => {
    const t = start('ask-user-question');
    expect(t.transport.pid).toBeGreaterThan(1);
    t.transport.send(HI);
    await promptRequested(t.messages);
    expect(t.kinds().indexOf('control_request')).toBeGreaterThan(t.kinds().indexOf('assistant'));
    expect(t.messages.find((m) => m.type === 'control_request')).toMatchObject({ request_id: 'req_fx_ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } });
    t.transport.respond({ subtype: 'success', request_id: 'req_fx_ask', response: { behavior: 'deny', message: 'no' } });
    const answer = await waitFor(() => t.records().find((r) => r.stdin?.type === 'control_response')?.stdin, 'answer written');
    expect(answer).toMatchObject({ response: { subtype: 'success', request_id: 'req_fx_ask', response: { behavior: 'deny', message: 'no' } } });
  });

  it('reports a request claude cancels, as when the turn is interrupted, as control_cancel_request', async () => {
    const t = start('ask-user-question');
    t.transport.send(HI);
    await promptRequested(t.messages);
    t.transport.interrupt();
    await waitFor(() => t.messages.some((m) => m.type === 'control_cancel_request'), 'cancel reported');
    expect(t.messages.find((m) => m.type === 'control_cancel_request')).toEqual({ type: 'control_cancel_request', request_id: 'req_fx_ask' });
  });

  it('stops claude with a prompt still waiting: kill resolves with SIGTERM and a late answer is ignored', async () => {
    const t = start('ask-user-question');
    t.transport.send(HI);
    await promptRequested(t.messages);
    expect((await t.transport.kill()).signal).toBe('SIGTERM');
    expect(() => t.transport.respond({ subtype: 'success', request_id: 'req_fx_ask', response: { behavior: 'deny', message: 'late' } })).not.toThrow();
  });

  it('reports the exit only after the messages claude printed, even those arriving after its process ended', async () => {
    const t = start('result-after-exit');
    t.transport.send(HI);
    const exit = await t.transport.exited;
    expect([exit.code, t.kinds().at(-1)]).toEqual([1, 'result']);
  });

  it('reports a claude that cannot be started as an exit with the spawn error', async () => {
    const messages: unknown[] = [];
    const transport = startSdkTransport({ ...launch('multi-turn', '/dev/null'), claude: { command: '/nonexistent/claude', args: [] } }, { message: (value) => messages.push(value) });
    const exit = await transport.exited;
    expect([exit.error, messages]).toEqual([expect.stringContaining('ENOENT'), []]);
  });
});
