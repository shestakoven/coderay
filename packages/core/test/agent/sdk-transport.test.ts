import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { startSdkTransport } from '../../src/agent/sdk-transport';
import type { StreamEvent } from '../../src/agent/stream';
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
    engine: 'claude', claude: fakeClaude(scenario, record), cwd: tempDir('ide-cwd-'), engineSessionId: SESSION, resume: false,
    model: null, effort: null, mcpConfigPath, disallowedTools: ['WebSearch'], gate: null, killGraceMs: 500,
  };
}

function start(scenario: string, asScript = false, env: Record<string, string> = {}) {
  const record = join(tempDir('ide-fake-'), 'record.jsonl');
  const events: StreamEvent[] = [];
  const raw: unknown[] = [];
  const base = launch(scenario, record);
  const withEnv = { ...base, claude: { ...base.claude, env: { ...base.claude.env, ...env } } };
  // As `--claude <path>.mjs` runs it: the script itself is the command.
  const run = asScript ? { ...withEnv, claude: { ...withEnv.claude, command: FAKE_CLAUDE, args: [] } } : withEnv;
  const transport = startSdkTransport(run, { event: (event) => events.push(event) }, (message) => raw.push(message));
  // The session's sink refers to the transport the start returns, so nothing may reach it before.
  expect(events).toEqual([]);
  onTestFinished(async () => {
    await transport.kill();
  });
  return { transport, events, raw, records: () => readRecords(record) };
}

const promptRequested = (events: StreamEvent[]) => waitFor(() => events.some((e) => e.type === 'control_request'), 'prompt requested');

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

  it('reports a request claude cancels, as when the turn is interrupted, as control_cancel', async () => {
    const t = start('ask-user-question');
    t.transport.send(HI);
    await promptRequested(t.events);
    t.transport.interrupt();
    await waitFor(() => t.events.some((e) => e.type === 'control_cancel'), 'cancel reported');
    expect(t.events.find((e) => e.type === 'control_cancel')).toEqual({ type: 'control_cancel', requestId: 'req_fx_ask' });
  });

  it('stops claude with a prompt still waiting: kill resolves with SIGTERM and a late answer is ignored', async () => {
    const t = start('ask-user-question');
    t.transport.send(HI);
    await promptRequested(t.events);
    expect((await t.transport.kill()).signal).toBe('SIGTERM');
    expect(() => t.transport.respond({ subtype: 'success', request_id: 'req_fx_ask', response: { behavior: 'deny', message: 'late' } })).not.toThrow();
  });

  it('reports the exit only after the messages claude printed, even those arriving after its process ended', async () => {
    const t = start('result-after-exit');
    t.transport.send(HI);
    const exit = await t.transport.exited;
    expect([exit.code, t.events.at(-1)?.type]).toEqual([1, 'result']);
  });

  it("hands the session claude's messages as events, a reply's usage ahead of the reply, and every message to the tap", async () => {
    const t = start('usage');
    t.transport.send(HI);
    await waitFor(() => t.events.some((e) => e.type === 'result'), 'the turn ended');
    const usages = t.events.flatMap((e) => (e.type === 'usage' ? [e.update] : []));
    const order = t.events.map((e) => e.type).filter((type) => type === 'usage' || type === 'assistant' || type === 'result');
    expect([usages, order, t.raw.some((m) => (m as { type?: unknown }).type === 'rate_limit_event')]).toEqual([
      [{ contextTokens: 96_010 }, { limits: [{ label: '5h', name: 'five-hour', minutes: 300, utilization: 0.42, resetsAt: 1790898600 }, { label: '7d', name: 'seven-day', minutes: 10_080, utilization: 0.07, resetsAt: 1791482400 }] }, { contextWindow: 200_000 }],
      ['usage', 'assistant', 'assistant', 'usage', 'usage', 'result'],
      true,
    ]);
  });
});
