import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { startSdkTransport } from '../../src/agent/sdk-transport';
import type { Launch } from '../../src/agent/transport';
import { FAKE_CLAUDE, fakeClaude, readRecords } from '../fake-claude/fake';
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
    claude: fakeClaude(scenario, record), cwd: tempDir('ide-cwd-'), engineSessionId: SESSION, resume: false,
    model: null, effort: null, mcpConfigPath, disallowedTools: ['WebSearch'], gate: null, killGraceMs: 500,
  };
}

function start(scenario: string, asScript = false, env: Record<string, string> = {}) {
  const record = join(tempDir('ide-fake-'), 'record.jsonl');
  const messages: Record<string, unknown>[] = [];
  const base = launch(scenario, record);
  const withEnv = { ...base, claude: { ...base.claude, env: { ...base.claude.env, ...env } } };
  // As `--claude <path>.mjs` runs it: the script itself is the command.
  const run = asScript ? { ...withEnv, claude: { ...withEnv.claude, command: FAKE_CLAUDE, args: [] } } : withEnv;
  const transport = startSdkTransport(run, { message: (value) => messages.push(value as Record<string, unknown>) });
  // The session's sink refers to the transport the start returns, so nothing may reach it before.
  expect(messages).toEqual([]);
  onTestFinished(async () => {
    await transport.kill();
  });
  const kinds = () => messages.map((m) => (m.type === 'system' ? `system/${String(m.subtype)}` : String(m.type)));
  return { transport, messages, kinds, records: () => readRecords(record) };
}

const promptRequested = (messages: Record<string, unknown>[]) => waitFor(() => messages.some((m) => m.type === 'control_request'), 'prompt requested');

describe('startSdkTransport', () => {
  it('is the only module of the core that loads the agent SDK, which sdk-env must precede', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const loaders = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.ts') && /^(?:import|export)(?!\s+type\b)[^;]*from '@anthropic-ai\/claude-agent-sdk'/m.test(readFileSync(join(src, file), 'utf8')));
    expect(loaders).toEqual([join('agent', 'sdk-transport.ts')]);
  });

  it("runs a claude given as a script with only claude's flags, the SDK's markers and the core's NODE_OPTIONS, and leaves the core's environment as it was", async () => {
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const before = process.env.CLAUDE_AGENT_SDK_VERSION;
    const t = start('multi-turn', true);
    const first = await waitFor(() => t.records().find((r) => r.argv), 'claude started');
    expect([first.argv?.includes(FAKE_CLAUDE), first.entrypoint, typeof first.sdkVersion, first.nodeOptions, process.env.CLAUDE_AGENT_SDK_VERSION])
      .toEqual([false, 'sdk-ts', 'string', true, before]);
    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  it("lists the skills claude names before any message: its own commands left out, each name once, in claude's order", async () => {
    const commands = [{ name: 'repo-probe' }, { name: 'review', builtin: true }, { name: 'omc-plan' }, { name: 'repo-probe' }, { name: 'review' }];
    const t = start('multi-turn', false, { FAKE_CLAUDE_COMMANDS: JSON.stringify(commands) });
    expect(await t.transport.skills()).toEqual(['repo-probe', 'omc-plan', 'review']);
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
});
