import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexModel, pickCodexModel } from '../../src/models/codex-model';
import { codexRecords, fakeCodex, sent } from '../fake-codex/fake';
import { tempDir, waitFor } from '../helpers';

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const model = (scenario: string, dir: string, env: Record<string, string> = {}, timeoutMs = 5_000) => new CodexModel({
  command: () => fakeCodex(scenario, join(dir, 'record.jsonl'), env), model: 'gpt-5.1-codex-mini', effort: 'low', runDir: dir, timeoutMs,
});
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('model-') || /^codex-\d+\.pid\.json$/.test(name));

describe('CodexModel', () => {
  it('runs an ephemeral read-only thread with every tool and MCP server off, and returns the final message as JSON', async (t) => {
    const dir = tempDir('bg-codex-', t);
    expect(await model('structured', dir).generate({ prompt: 'Say hi', schema: SCHEMA })).toEqual({ answer: 'hi' });
    const records = codexRecords(join(dir, 'record.jsonl'));
    const [thread] = sent(records, 'thread/start') as Record<string, any>[];
    expect(thread).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: expect.stringContaining('JSON document only') });
    // node_repl is fake-codex's default user server: a JS REPL that would run outside the sandbox.
    expect(thread!.config).toMatchObject({
      'mcp_servers.node_repl.enabled': false, 'features.apps': false, 'features.plugins': false,
      'features.shell_tool': false, web_search: 'disabled', 'features.view_image': false, 'features.goals': false, 'features.shell_snapshot': false,
    });
    expect(String(thread!.cwd)).toMatch(/model-\d+-/);
    const [turn] = sent(records, 'turn/start') as Record<string, unknown>[];
    expect(turn).toMatchObject({ outputSchema: SCHEMA, effort: 'low', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: 'gpt-5.1-codex-mini' });
    expect(leftovers(dir)).toEqual([]);
  });

  it('interrupts and fails a turn that starts a tool, and fails a call in which an MCP server starts or the turn fails, with the reason', async (t) => {
    const dir = tempDir('bg-codex-', t);
    await expect(model('shell', dir).generate({ prompt: 'x', schema: SCHEMA })).rejects.toThrow('codex tried to run a tool in a background call (commandExecution)');
    expect(sent(codexRecords(join(dir, 'record.jsonl')), 'turn/interrupt')).toHaveLength(1);
    await expect(model('structured', tempDir('bg-codex-', t), { FAKE_CODEX_EXTRA_SERVER: 'rogue' }).generate({ prompt: 'x', schema: SCHEMA }))
      .rejects.toThrow('codex started an MCP server in a background call (rogue)');
    const failing = tempDir('bg-codex-', t);
    writeFileSync(join(failing, 'failed.jsonl'), `${JSON.stringify({ fake: 'fail', message: 'unexpected status 401 Unauthorized: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz' })}\n`);
    await expect(model(join(failing, 'failed.jsonl'), failing).generate({ prompt: 'x', schema: SCHEMA })).rejects.toThrow(/^codex turn failed: unexpected status 401 Unauthorized: \[key hidden\]$/);
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
      await expect(model('structured', dir, env).generate({ prompt: 'x', schema: SCHEMA })).rejects.toThrow(reason);
      expect(sent(codexRecords(join(dir, 'record.jsonl')), 'turn/start')).toHaveLength(0);
    }
  });

  it('abort or the timeout interrupts the turn and stops the app-server', async (t) => {
    const dir = tempDir('bg-codex-', t);
    const abort = new AbortController();
    const pending = model('hang', dir).generate({ prompt: 'x', schema: SCHEMA }, { signal: abort.signal });
    await waitFor(() => existsSync(join(dir, 'record.jsonl')) && sent(codexRecords(join(dir, 'record.jsonl')), 'turn/start').length > 0, 'turn/start sent');
    await new Promise((resolve) => setTimeout(resolve, 100)); // its answer, which names the turn, arrives
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(sent(codexRecords(join(dir, 'record.jsonl')), 'turn/interrupt')).toHaveLength(1);
    expect(leftovers(dir)).toEqual([]);
    const late = tempDir('bg-codex-', t);
    await expect(model('hang', late, {}, 500).generate({ prompt: 'x', schema: SCHEMA })).rejects.toThrow('codex did not answer in 0.5 s');
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
