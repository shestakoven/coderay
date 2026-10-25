import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_TOOLS } from '../../src/agent/opencode/config';
import { OpencodeModel, pickOpencodeModel } from '../../src/models/opencode-model';
import { fakeOpencode, opencodeHomes, opencodeRecords, requests } from '../fake-opencode/fake';
import { fixture, tempDir, waitFor } from '../helpers';

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const ASK = { prompt: 'Say hi', schema: SCHEMA };
const model = (scenario: string, dir: string, env: Record<string, string> = {}, timeoutMs = 5_000) => new OpencodeModel({
  // The fake's data home under `dir`: its tool-output glob is then the one the self-check expects.
  command: () => fakeOpencode(fixture(`opencode/${scenario}.jsonl`), join(dir, 'record.jsonl'), { ...opencodeHomes(dir), ...env }),
  model: { providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' }, userServers: ['github'], runDir: dir, timeoutMs,
});
const records = (dir: string) => opencodeRecords(join(dir, 'record.jsonl'));
const prompts = (dir: string) => requests(records(dir), 'POST', /^\/session\/[^/]+\/message$/) as { body: any }[];
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('model-') || /^opencode-\d+\.pid\.json$/.test(name));
const failure = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'answered', (error: Error) => error.message);

describe('OpencodeModel', () => {
  it("answers, after a busy start and a retry within its deadline, in a deny-all session with every tool and the user's MCP servers off, titles on its own model, then deletes the session", async (t) => {
    const dir = tempDir('bg-opencode-', t);
    expect(await model('structured', dir, { FAKE_OPENCODE_DB_BUSY: '1' }).generate(ASK)).toEqual({ answer: 'hi' });
    const deny = { '*': 'deny' };
    expect(records(dir).find((record) => record.configContent)!.configContent).toEqual({
      permission: deny, agent: { build: { permission: deny }, plan: { permission: deny }, general: { permission: deny }, explore: { permission: deny } },
      mcp: { github: { enabled: false } }, share: 'disabled', autoupdate: false, lsp: false, formatter: false, snapshot: false,
      shell: expect.stringContaining(`${dir}/opencode-shell/`), small_model: 'opencode/nemotron-3.5-lightning-free',
    });
    // A session with a title of its own costs no second model call to title it.
    expect(requests(records(dir), 'POST', '/session')[0]!.body).toEqual({ title: 'CodeRay background call', permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
    const [prompt] = prompts(dir);
    expect(prompt!.body).toMatchObject({
      agent: 'build', model: { providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' }, system: expect.stringContaining('exactly one JSON document'),
      tools: { bash: false, edit: false, write: false, read: false, webfetch: false, websearch: false, task: false, 'github_*': false },
    });
    expect(String(prompt!.body.parts[0].text)).toMatch(/^Say hi\n[\s\S]*"required":\["answer"\]/);
    expect(requests(records(dir), 'DELETE', /^\/session\/[^/]+$/)).toHaveLength(1);
    expect(leftovers(dir)).toEqual([]);
  });

  it('asks once more after an answer with no JSON, and fails on a second that does not fit', async (t) => {
    const dir = tempDir('bg-opencode-', t);
    expect(await failure(model('prose', dir).generate(ASK))).toBe('the answer does not fit the schema: $.answer is not of type string');
    expect(prompts(dir).map((prompt) => prompt.body.parts[0].text)).toEqual([expect.stringMatching(/^Say hi/), expect.stringContaining('not valid JSON')]);
  });

  it("refuses, before any prompt, a server whose rules would allow a tool after the deny-all, or that loaded a user's tool", async (t) => {
    const [loose, custom] = [tempDir('bg-opencode-', t), tempDir('bg-opencode-', t)];
    const rule = (permission: string, action: string) => ({ permission, pattern: '*', action });
    // The chat's self-check lets a read through; a background call reads nothing.
    const agents = ['build', 'plan', 'general', 'explore'].map((name) => ({ name, mode: 'primary', permission: [rule('*', 'allow'), rule('*', 'deny'), ...(name === 'build' ? [rule('read', 'allow')] : [])] }));
    expect(await Promise.all([
      failure(model('structured', loose, { FAKE_OPENCODE_AGENTS: JSON.stringify(agents) }).generate(ASK)),
      failure(model('structured', custom, { FAKE_OPENCODE_TOOL_IDS: JSON.stringify([...BUILT_IN_TOOLS, 'deploy']) }).generate(ASK)),
    ])).toEqual(["opencode's agent build would allow read *", 'opencode loaded a custom tool "deploy", which would run without asking']);
    expect([prompts(loose), prompts(custom), leftovers(loose), leftovers(custom)]).toEqual([[], [], [], []]);
  });

  it('an abort stops the turn, deletes the session and stops the server; one while it starts sends no prompt, one before starts nothing', async (t) => {
    const [dir, early, before] = [tempDir('bg-opencode-', t), tempDir('bg-opencode-', t), tempDir('bg-opencode-', t)];
    const abort = new AbortController();
    const pending = failure(model('hang', dir).generate(ASK, { signal: abort.signal }));
    await waitFor(() => prompts(dir).length > 0, 'the prompt sent');
    abort.abort();
    expect(await pending).toBe('cancelled');
    expect([requests(records(dir), 'POST', /\/abort$/).length, requests(records(dir), 'DELETE', /^\/session\/[^/]+$/).length, leftovers(dir)]).toEqual([1, 1, []]);
    const starting = new AbortController();
    const started = failure(model('structured', early).generate(ASK, { signal: starting.signal }));
    starting.abort();
    expect([await started, prompts(early), leftovers(early)]).toEqual(['cancelled', [], []]);
    expect([await failure(model('structured', before).generate(ASK, { signal: AbortSignal.abort() })), records(before)]).toEqual(['cancelled', []]);
  });

  it("fails at once with opencode's reason, the server's password and keys hidden: a failed turn, a retry only after the deadline, the timeout", async (t) => {
    const [failed, limited, hung] = [tempDir('bg-opencode-', t), tempDir('bg-opencode-', t), tempDir('bg-opencode-', t)];
    expect(await Promise.all([
      failure(model('failed-turn', failed).generate(ASK)),
      // Its event stream opens late: the prompt waits for it, or the retry would go unseen until the timeout.
      failure(model('free-limit', limited, { FAKE_OPENCODE_EVENT_HOLD_MS: '300' }).generate(ASK)),
      failure(model('hang', hung, {}, 1_000).generate(ASK)),
    ])).toEqual([
      "opencode's model failed: the provider refused [key hidden] from …",
      "opencode's model is not available until 2100-01-01T00:00:00.000Z: Free usage exceeded, subscribe to Go",
      'opencode did not answer in 1 s',
    ]);
    expect(prompts(failed)).toHaveLength(1);
  });
});

describe('pickOpencodeModel', () => {
  const c = (value: string, cost: number | null) => ({ value, name: value, efforts: [], context: null, cost });
  it('takes the cheapest, an opencode model and then a cheap-sounding one first among equals, a known cost before an unknown', () => {
    expect(pickOpencodeModel([c('opencode:anthropic/claude-x', 18), c('opencode:openai/gpt-x-mini', 0), c('opencode:opencode/grok-code', 0)]))
      .toEqual({ providerID: 'opencode', modelID: 'grok-code', value: 'opencode:opencode/grok-code' });
    expect(pickOpencodeModel([c('opencode:opencode/big-pickle', 0), c('opencode:opencode/glm-5.3-flash-free', 0)])).toMatchObject({ modelID: 'glm-5.3-flash-free' });
    expect(pickOpencodeModel([c('opencode:anthropic/claude-x', null), c('opencode:openai/gpt-x-mini', 2)])).toMatchObject({ providerID: 'openai', modelID: 'gpt-x-mini' });
    expect(pickOpencodeModel([])).toBeNull();
  });
});
