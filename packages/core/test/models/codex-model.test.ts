import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexModel, pickCodexModel } from '../../src/models/codex-model';
import { codexRecords, fakeCodex, sent } from '../fake-codex/fake';
import { tempDir, waitFor } from '../helpers';

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const ASK = { prompt: 'Say hi', schema: SCHEMA };
const model = (scenario: string, dir: string, env: Record<string, string> = {}, timeoutMs = 5_000) => new CodexModel({
  command: () => fakeCodex(scenario, join(dir, 'record.jsonl'), env), model: 'gpt-5.1-codex-mini', effort: 'low', runDir: dir, timeoutMs,
});
const records = (dir: string) => codexRecords(join(dir, 'record.jsonl'));
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('model-') || /^codex-\d+\.pid\.json$/.test(name));
/** A scenario of the given lines in `dir` (test/fixtures/codex/README.md). */
const scenario = (dir: string, lines: object[]): string => {
  const path = join(dir, 'scenario.jsonl');
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
};
const item = (value: object) => ({ method: 'item/started', params: { threadId: '$THREAD', turnId: '$TURN', item: value } });

describe('CodexModel', () => {
  it('runs an ephemeral read-only thread with every tool and MCP server off, declines every request, and returns the final message as JSON', async (t) => {
    const dir = tempDir('bg-codex-', t);
    expect(await model('structured', dir).generate(ASK)).toEqual({ answer: 'hi' });
    const [thread] = sent(records(dir), 'thread/start') as Record<string, any>[];
    expect(thread).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: expect.stringContaining('JSON document only') });
    // node_repl is fake-codex's default user server: a JS REPL that would run outside the sandbox.
    expect(thread!.config).toMatchObject({
      'mcp_servers.node_repl.enabled': false, 'features.apps': false, 'features.plugins': false,
      'features.shell_tool': false, web_search: 'disabled', 'features.view_image': false, 'features.goals': false, 'features.shell_snapshot': false,
    });
    expect(String(thread!.cwd)).toMatch(/model-\d+-/);
    const [turn] = sent(records(dir), 'turn/start') as Record<string, unknown>[];
    expect(turn).toMatchObject({ outputSchema: SCHEMA, effort: 'low', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: 'gpt-5.1-codex-mini' });
    expect(records(dir).flatMap((record) => (record.reply ? [record.reply] : []))).toEqual([
      { method: 'item/commandExecution/requestApproval', result: { decision: 'decline' } },
      { method: 'item/permissions/requestApproval', result: { permissions: {}, scope: 'turn' } },
      { method: 'mcpServer/elicitation/request', result: { action: 'decline', content: null, _meta: null } },
      { method: 'applyPatchApproval', result: { error: { code: -32601, message: 'A background call does not handle applyPatchApproval.' } } },
    ]);
    expect(leftovers(dir)).toEqual([]);
  });

  it('fails with the reason when a tool or an MCP server starts, the turn fails or codex exits', async (t) => {
    const tool = tempDir('bg-codex-', t);
    const command = { type: 'commandExecution', id: 'cmd-1', command: 'ls', cwd: '$CWD', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null };
    const answer = { method: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'msg-1', text: '{"answer":"hi"}', phase: 'final_answer' } } };
    // turn/start answered only after the turn, the interrupt ignored and the turn completed: the answer is refused all the same.
    await expect(model(scenario(tool, [item(command), answer]), tool, { FAKE_CODEX_TURN_REPLY: 'late', FAKE_CODEX_SILENT: 'turn/interrupt' }).generate(ASK))
      .rejects.toThrow('codex tried to run a tool in a background call (commandExecution)');
    expect(sent(records(tool), 'turn/interrupt')).toHaveLength(1);
    await expect(model('structured', tempDir('bg-codex-', t), { FAKE_CODEX_EXTRA_SERVER: 'rogue' }).generate(ASK))
      .rejects.toThrow('codex started an MCP server in a background call (rogue)');
    const failed = tempDir('bg-codex-', t);
    await expect(model(scenario(failed, [{ fake: 'fail', message: 'unexpected status 401 Unauthorized: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz' }]), failed).generate(ASK))
      .rejects.toThrow(/^codex turn failed: unexpected status 401 Unauthorized: \[key hidden\]$/);
    const exited = tempDir('bg-codex-', t);
    await expect(model(scenario(exited, [{ fake: 'exit', code: 1 }]), exited, {}, 60_000).generate(ASK)).rejects.toThrow('codex app-server stopped before it answered');
    expect(leftovers(exited)).toEqual([]);
  });

  it('refuses a thread whose echo is not read-only, offline and never asking, before any turn', async (t) => {
    const echoes: [Record<string, string>, string][] = [
      [{ FAKE_CODEX_ECHO_SANDBOX: 'workspace-write' }, 'codex reported sandbox workspaceWrite and approvals "never", not read-only'],
      [{ FAKE_CODEX_ECHO: '{"sandbox":{"type":"readOnly","networkAccess":true}}' }, 'codex reported sandbox readOnly with network access'],
      [{ FAKE_CODEX_ECHO: '{"approvalPolicy":"on-request"}' }, 'codex reported sandbox readOnly and approvals "on-request"'],
      [{ FAKE_CODEX_ECHO: '{"thread":{"id":null}}' }, 'codex opened no thread it could name'],
    ];
    for (const [env, reason] of echoes) {
      const dir = tempDir('bg-codex-', t);
      await expect(model('structured', dir, env).generate(ASK)).rejects.toThrow(reason);
      expect(sent(records(dir), 'turn/start')).toHaveLength(0);
    }
  });

  it('abort or the timeout interrupts the turn and stops the app-server', async (t) => {
    const dir = tempDir('bg-codex-', t);
    const abort = new AbortController();
    // turn/started never comes: only turn/start's answer names the turn.
    const pending = model('hang', dir, { FAKE_CODEX_TURN_STARTED_MS: '60000' }, 60_000).generate(ASK, { signal: abort.signal });
    await waitFor(() => existsSync(join(dir, 'record.jsonl')) && sent(records(dir), 'turn/start').length > 0, 'turn/start sent');
    await new Promise((resolve) => setTimeout(resolve, 200)); // its answer arrives
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(sent(records(dir), 'turn/interrupt')).toHaveLength(1);
    expect(leftovers(dir)).toEqual([]);

    const soon = tempDir('bg-codex-', t);
    const early = new AbortController();
    const starting = model('hang', soon, {}, 60_000).generate(ASK, { signal: early.signal });
    early.abort();
    await expect(starting).rejects.toThrow('cancelled');
    expect(leftovers(soon)).toEqual([]);

    let started = 0;
    const never = new CodexModel({ command: () => { started += 1; return fakeCodex('hang', join(soon, 'never.jsonl')); }, model: 'm', effort: null, runDir: soon });
    await expect(never.generate(ASK, { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(started).toBe(0);

    const late = tempDir('bg-codex-', t);
    await expect(model('hang', late, {}, 500).generate(ASK)).rejects.toThrow('codex did not answer in 0.5 s');
    expect(leftovers(late)).toEqual([]);
  });
});

describe('pickCodexModel', () => {
  const efforts = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort, description: '' }));
  const m = (id: string, extra: Record<string, unknown> = {}) => ({ id, model: id, displayName: id, description: '', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts('medium', 'low', 'high'), ...extra });
  it('prefers a visible mini model, then the default, then the first visible, at its lowest effort', () => {
    expect(pickCodexModel([m('gpt-6'), m('gpt-5.1-codex-mini'), m('gpt-6-nano', { hidden: true })], null)).toEqual({ id: 'gpt-5.1-codex-mini', effort: 'low' });
    expect(pickCodexModel([m('gpt-6'), m('gpt-6-luna', { isDefault: true, supportedReasoningEfforts: [] })], null)).toEqual({ id: 'gpt-6-luna', effort: null });
    expect(pickCodexModel([m('gpt-6-nano', { hidden: true }), m('gpt-6')], null)).toEqual({ id: 'gpt-6', effort: 'low' });
    // codex 0.160 lists max and ultra above xhigh; a name it may add later ranks last.
    expect(pickCodexModel([m('gpt-6-luna', { isDefault: true }), m('gpt-6', { supportedReasoningEfforts: efforts('turbo', 'ultra', 'max') })], 'gpt-6')).toEqual({ id: 'gpt-6', effort: 'max' });
    expect(pickCodexModel([m('gpt-6')], 'gpt-7')).toBeNull();
  });
});
