import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { accountHome, SYSTEM_HOME } from '../../src/accounts/account-homes';
import { startCodexTransport } from '../../src/agent/codex/transport';
import { keyRejectedHint } from '../../src/agent/engines/codex';
import type { StreamEvent } from '../../src/agent/stream';
import { userMessage, type CodexLaunch, type GateCall } from '../../src/agent/transport';
import type { HookAnswer } from '../../src/gate/hook-gate';
import { isAlive } from '../../src/os-process';
import { codexRecords, fakeCodex, sent } from '../fake-codex/fake';
import { tempDir, waitFor } from '../helpers';

const POLICY = { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
const ALLOW: HookAnswer = { permissionDecision: 'allow', permissionDecisionReason: 'ok' };
const DENY: HookAnswer = { permissionDecision: 'deny', permissionDecisionReason: 'no' };

function scene(scenario: string, overrides: Partial<CodexLaunch> = {}, env: Record<string, string> = {}) {
  const dir = tempDir('codex-transport-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/other.ts'), "export const other = 'helo';\n");
  const record = join(dir, 'record.jsonl');
  const launch: CodexLaunch = {
    engine: 'codex', cwd: dir, engineSessionId: 'unused', resume: false, model: 'gpt-6-luna', effort: 'medium',
    codex: fakeCodex(scenario, record, env), servers: ['idecore'],
    config: { 'mcp_servers.idecore.url': 'http://127.0.0.1:9/mcp?readOnlyHints=1' },
    env: { CODERAY_IDECORE_TOKEN: 'secret' }, developerInstructions: 'Writes go to the user.', signedOutHint: 'Sign in.', keyRejectedHint: 'Replace the key.', ...overrides,
  };
  return { dir, record, launch, records: () => codexRecords(record) };
}

function run(launch: CodexLaunch) {
  const events: StreamEvent[] = [];
  const transport = startCodexTransport(launch, { event: (event) => events.push(event) });
  onTestFinished(() => void transport.kill());
  const results = () => events.flatMap((event) => (event.type === 'result' ? [event.subtype] : []));
  return { transport, events, results };
}

const replies = (s: ReturnType<typeof scene>) => s.records().flatMap((entry) => (entry.reply ? [entry.reply.result] : []));

describe('the Codex transport', () => {
  it("starts read-only with every write sent to the user, the user's own servers switched off and CodeRay's secrets kept from shell commands, and resumes the thread with the same policy", async () => {
    const s = scene('multi-turn', {}, { FAKE_CODEX_CONFIG: '{"shell_environment_policy":{"exclude":["AWS_*"]}}' });
    const first = run(s.launch);
    first.transport.send(userMessage('hi', []));
    await waitFor(() => first.results().length === 1, 'the first turn ended');
    await first.transport.kill();
    const init = first.events.find((event) => event.type === 'init');
    const threadId = init?.type === 'init' ? init.sessionId : '';
    const second = run({ ...s.launch, resume: true, engineSessionId: threadId });
    second.transport.send(userMessage('again', []));
    await waitFor(() => second.results().length === 1, 'the resumed turn ended');
    const config = {
      'mcp_servers.node_repl.enabled': false, 'features.apps': false, 'features.plugins': false, 'features.deferred_executor': false,
      'shell_environment_policy.exclude': ['AWS_*', 'CODERAY_*'],
    };
    expect([sent(s.records(), 'thread/start'), sent(s.records(), 'thread/resume'), sent(s.records(), 'turn/start'), s.records()[0]?.secrets]).toMatchObject([
      [{ ...POLICY, cwd: s.dir, developerInstructions: 'Writes go to the user.', model: 'gpt-6-luna', config }],
      [{ ...POLICY, threadId, excludeTurns: true, config }],
      [
        { threadId, model: 'gpt-6-luna', effort: 'medium', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
        { threadId, input: [{ type: 'text', text: 'again', text_elements: [] }] },
      ],
      ['CODERAY_IDECORE_TOKEN'],
    ]);
  });

  it.each([
    ['has no record of it', 'no rollout found for thread id $THREAD', 1, "Codex has no record of this chat's thread thread-gone, so the chat goes on in a new thread, without what was said before.", 'success'],
    ['cannot resume it for another reason', 'thread thread-gone is archived', 0, 'Codex did not take the message: thread thread-gone is archived', 'failed'],
  ])("goes on in a new thread only when codex %s, and says so", async (_, error, starts, notice, result) => {
    const s = scene('multi-turn', { resume: true, engineSessionId: 'thread-gone' }, { FAKE_CODEX_RESUME_ERROR: error });
    const { transport, events, results } = run(s.launch);
    transport.send(userMessage('hi', []));
    await waitFor(() => results().length === 1, 'the turn ended');
    expect([sent(s.records(), 'thread/resume').length, sent(s.records(), 'thread/start').length, events.filter((event) => event.type === 'notice'), results()]).toEqual([
      1, starts, [{ type: 'notice', text: notice }], [result],
    ]);
  });

  it.each([
    ['its policy echo is not read-only', { FAKE_CODEX_ECHO_SANDBOX: 'workspace-write' }, /^Codex reported sandbox workspaceWrite/, {}],
    ['its policy echo gives the sandbox network access', { FAKE_CODEX_ECHO: '{"sandbox":{"type":"readOnly","networkAccess":true}}' }, /sandbox readOnly with network access true,/, {}],
    ['its policy echo runs commands without asking', { FAKE_CODEX_ECHO: '{"approvalPolicy":"never"}' }, /approvals "never"/, {}],
    ['its policy echo sends approvals to a reviewer other than the user', { FAKE_CODEX_ECHO: '{"approvalsReviewer":"auto_review"}' }, /by auto_review/, {}],
    ['the echo of a resumed thread sends approvals to another reviewer', { FAKE_CODEX_ECHO: '{"approvalsReviewer":"auto_review"}' }, /by auto_review/, { resume: true, engineSessionId: 'thread-old' }],
    ['its policy echo lets the model start sub-agents on its own', { FAKE_CODEX_ECHO: '{"multiAgentMode":"proactive"}' }, /sub-agents "proactive"/, {}],
    ['the account is signed out', { FAKE_CODEX_ACCOUNT: 'none' }, /^Sign in\.$/, {}],
    ['codex is older than 0.160', { FAKE_CODEX_VERSION: '0.159.9' }, /^codex 0\.159\.9 is older than 0\.160\.0/, {}],
    ['codex does not say its version, in words with a key', { FAKE_CODEX_USER_AGENT: 'codex (fake; sk-proj-abcdefghijklmnopqrstuvwx)' }, /^CodeRay cannot read Codex version in "codex \(fake; \[key hidden\]\)"/, {}],
    ['an MCP server CodeRay did not configure starts', { FAKE_CODEX_EXTRA_SERVER: 'surprise' }, /\(surprise\)/, {}],
    ["the user's Codex configuration defines a server named as one of CodeRay's", { FAKE_CODEX_USER_SERVERS: '{"idecore":{"command":"x"}}' }, /named "idecore"/, {}],
    ["the user's Codex configuration names a server CodeRay cannot switch off by name", { FAKE_CODEX_USER_SERVERS: '{"my.server":{"command":"x"}}' }, /named "my\.server", which CodeRay cannot switch off: rename yours/, {}],
  ])('refuses the chat when %s, with the reason, and stops its app-server', async (_, env, reason, overrides: Partial<CodexLaunch>) => {
    const { transport, events } = run(scene('multi-turn', overrides, env).launch);
    transport.send(userMessage('hi', []));
    const refused = await waitFor(() => events.find((event) => event.type === 'refused'), 'the refusal');
    await transport.exited;
    expect(refused.type === 'refused' ? refused.reason : '').toMatch(reason);
  });

  it('sends a message as a turn, a /skill of the project as a skill item, and a message during a turn as a steer', async () => {
    const s = scene('hang');
    const { transport, events } = run(s.launch);
    const skills = await transport.skills();
    transport.send(userMessage('/probe-skill check the readme', []));
    await waitFor(() => events.some((event) => event.type === 'init'), 'the turn started');
    transport.send(userMessage('also this', []));
    await waitFor(() => sent(s.records(), 'turn/steer').length === 1, 'the steer');
    expect([skills, (sent(s.records(), 'turn/start')[0] as { input: unknown }).input, sent(s.records(), 'turn/steer')[0]]).toMatchObject([
      ['probe-skill'],
      [{ type: 'skill', name: 'probe-skill', path: join(s.dir, '.agents/skills/probe-skill/SKILL.md') }, { type: 'text', text: 'check the readme', text_elements: [] }],
      { expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'also this', text_elements: [] }] },
    ]);
  });

  it("answers a patch's approval with the gate's verdict for each of its files, and declines without a gate", async () => {
    const outcome = async (decide: CodexLaunch['decide']) => {
      const s = scene('patch', decide ? { decide } : {});
      const { transport, results } = run(s.launch);
      transport.send(userMessage('ready?', []));
      await waitFor(() => results().length === 1, 'the first turn ended');
      transport.send(userMessage('edit', []));
      await waitFor(() => results().length === 2, 'the patch turn ended');
      return [replies(s), readFileSync(join(s.dir, 'src/other.ts'), 'utf8')];
    };
    const calls: GateCall[] = [];
    expect([await outcome(async (call) => { calls.push(call); return ALLOW; }), await outcome(undefined), calls.map((call) => [call.tool_name, call.tool_use_id, (call.tool_input as { file_path: string }).file_path.endsWith('src/other.ts')])]).toEqual([
      [[{ decision: 'accept' }], "export const other = 'hello';\n"],
      [[{ decision: 'decline' }], "export const other = 'helo';\n"],
      [['Edit', 'patch-1', true]],
    ]);
  });

  it.each([
    ['an escalated shell command', 'shell', true, ['Bash'], { decision: 'decline' }, true],
    ["an MCP tool's elicitation", 'elicitation', true, ['mcp__notes__write_note'], { action: 'decline', content: null, _meta: null }, true],
    ["an MCP tool's elicitation with no gate", 'elicitation', false, [], { action: 'decline', content: null, _meta: null }, false],
  ])('declines %s, and the call ends rejected only when the gate denied it', async (_, scenario, gate, tools, reply, refused) => {
    const asked: string[] = [];
    const s = scene(scenario, gate ? { decide: async (call) => { asked.push(call.tool_name); return DENY; } } : {});
    const { transport, events, results } = run(s.launch);
    transport.send(userMessage('go', []));
    await waitFor(() => results().length === 1, 'the turn ended');
    const rejected = events.flatMap((event) => (event.type === 'user' ? event.toolResults.map((result) => result.rejected) : []));
    expect([asked, replies(s), rejected]).toEqual([tools, [reply], [refused]]);
  });

  it('grants no extra permissions and answers any other request of the app-server with an error, never asking the gate', async () => {
    const scenario = join(tempDir('codex-requests-'), 'requests.jsonl');
    writeFileSync(scenario, [
      { request: 'item/permissions/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'x', reason: null, permissions: { network: { enabled: true } } } },
      { request: 'applyPatchApproval', params: { conversationId: '$THREAD', callId: 'p', fileChanges: {}, reason: null, grantRoot: null } },
    ].map((line) => JSON.stringify(line)).join('\n'));
    const asked: GateCall[] = [];
    const s = scene(scenario, { decide: async (call) => { asked.push(call); return ALLOW; } });
    const { transport, results } = run(s.launch);
    transport.send(userMessage('go', []));
    await waitFor(() => results().length === 1, 'the turn ended');
    expect([replies(s), asked]).toEqual([[{ permissions: {}, scope: 'turn' }, { error: { code: -32601, message: 'CodeRay does not handle applyPatchApproval.' } }], []]);
  });

  it('leaves a held approval unanswered; Stop ends the turn, restarts the app-server and resumes the thread for the next message', async () => {
    const s = scene('patch', { decide: (_call, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))) });
    const { transport, results } = run(s.launch);
    transport.send(userMessage('ready?', []));
    await waitFor(() => results().length === 1, 'the first turn ended');
    transport.send(userMessage('edit', []));
    await waitFor(() => sent(s.records(), 'turn/start').length === 2, 'the patch turn started');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = transport.pid;
    transport.interrupt();
    transport.send(userMessage('again', []));
    await waitFor(() => results().length === 3, 'the next message answered');
    expect([results(), replies(s), sent(s.records(), 'thread/resume').length, transport.pid !== before, isAlive(before!)]).toEqual([
      ['success', 'error_during_execution', 'success'], [], 1, true, false,
    ]);
  });

  it('withdraws a held approval at Stop and sends codex nothing the gate allows after it', async () => {
    let release = () => {};
    const withdrawn: boolean[] = [];
    const s = scene('patch', { decide: async (_call, signal) => {
      await new Promise<void>((resolve) => { release = resolve; });
      withdrawn.push(signal.aborted);
      return ALLOW;
    } });
    const { transport, results } = run(s.launch);
    transport.send(userMessage('ready?', []));
    await waitFor(() => results().length === 1, 'the first turn ended');
    transport.send(userMessage('edit', []));
    await waitFor(() => sent(s.records(), 'turn/start').length === 2, 'the patch turn started');
    await new Promise((resolve) => setTimeout(resolve, 300));
    transport.interrupt();
    release();
    await waitFor(() => results().length === 2, 'the turn stopped');
    expect([results(), withdrawn, replies(s), readFileSync(join(s.dir, 'src/other.ts'), 'utf8')]).toEqual([['success', 'error_during_execution'], [true], [], "export const other = 'helo';\n"]);
  });

  it("starts the next turn with a message whose steer lost the race with the turn's end", async () => {
    const scenario = join(tempDir('codex-steer-'), 'steer.jsonl');
    writeFileSync(scenario, [{ fake: 'sleep', ms: 150 }, { fake: 'await-turn' }].map((line) => JSON.stringify(line)).join('\n'));
    const s = scene(scenario, {}, { FAKE_CODEX_SLOW: 'turn/steer' });
    const { transport, events, results } = run(s.launch);
    transport.send(userMessage('first', []));
    await waitFor(() => events.some((event) => event.type === 'init'), 'the first turn started');
    transport.send(userMessage('second', []));
    await waitFor(() => results().length === 2, 'both turns ended');
    expect([results(), sent(s.records(), 'turn/steer').length, sent(s.records(), 'turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text)]).toEqual([
      ['success', 'success'], 1, ['first', 'second'],
    ]);
  });

  it('ends a message whose thread codex keeps opening when Stop comes, within the settle time, with its app-server', async () => {
    const s = scene('hang', {}, { FAKE_CODEX_SILENT: 'thread/start' });
    const { transport, results } = run(s.launch);
    transport.send(userMessage('first', []));
    await waitFor(() => sent(s.records(), 'thread/start').length === 1, 'thread/start sent');
    const before = transport.pid;
    const stopped = Date.now();
    transport.interrupt();
    await waitFor(() => results().length === 1 && transport.pid !== before, 'the message ended and the app-server replaced');
    expect([results(), Date.now() - stopped < 7_000, sent(s.records(), 'turn/start').length, isAlive(before!)]).toEqual([['error_during_execution'], true, 0, false]);
  });

  it.each([
    ['before its app-server is ready', null, [], 0],
    ['while its thread opens', 'thread/start', [], 0],
    ['while codex starts its turn', 'turn/start', ['first'], 1],
  ])('ends a message on a Stop that comes %s, before codex named the turn, and lets the next message run', async (_, slow, stopped, interrupts) => {
    // Every turn hangs, whether or not the stopped message reached a turn: the next one is still running when checked.
    const scenario = join(tempDir('codex-stop-'), 'hang-twice.jsonl');
    writeFileSync(scenario, [{ fake: 'sleep', ms: 60_000 }, { fake: 'await-turn' }, { fake: 'sleep', ms: 60_000 }].map((line) => JSON.stringify(line)).join('\n'));
    const s = scene(scenario, {}, slow === null ? {} : { FAKE_CODEX_SLOW: slow });
    const { transport, events, results } = run(s.launch);
    transport.send(userMessage('first', []));
    if (slow !== null) await waitFor(() => sent(s.records(), slow).length === 1, `${slow} sent`);
    transport.interrupt();
    await waitFor(() => results().length === 1, 'the stopped message ended');
    transport.send(userMessage('second', []));
    await waitFor(() => events.filter((event) => event.type === 'init').length === stopped.length + 1, 'the second message started a turn');
    expect([results(), sent(s.records(), 'turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text), sent(s.records(), 'turn/interrupt').length]).toEqual([
      ['error_during_execution'], [...stopped, 'second'], interrupts,
    ]);
  });

  it('judges a patch by its latest list of changes, one question per file, and declines it at the first file the gate denies', async () => {
    const asked: string[] = [];
    const s = scene('multi-patch', {
      decide: async (call) => {
        asked.push(`${call.tool_name} ${String(call.tool_input.file_path ?? call.tool_input.command).replaceAll(s.dir, '')}`);
        return call.tool_name === 'Bash' && String(call.tool_input.command).startsWith('mv') ? DENY : ALLOW;
      },
    });
    const { transport, results } = run(s.launch);
    transport.send(userMessage('tidy up', []));
    await waitFor(() => results().length === 1, 'the patch turn ended');
    expect([asked, replies(s)]).toEqual([
      ['Edit /src/other.ts', "Bash rm -- '/src/old.ts'", "Bash mv -- '/src/a.ts' '/src/b.ts'"], [{ decision: 'decline' }],
    ]);
  });

  it("ends a shell command still running on Stop, with the app-server it ran under, though a sub-agent's turn ended meanwhile", async () => {
    const s = scene('shell-running');
    const { transport, results } = run(s.launch);
    transport.send(userMessage('sleep', []));
    const sleeper = await waitFor(() => s.records().find((entry) => entry.sleeperPid !== undefined)?.sleeperPid, 'the shell command running');
    const before = transport.pid;
    transport.interrupt();
    await waitFor(() => results().length === 1 && transport.pid !== before, 'the turn stopped and the app-server replaced');
    expect(await waitFor(() => !isAlive(sleeper) && 'gone', 'the shell command gone')).toBe('gone');
  });

  it.each([
    ["an API-key account of CodeRay's fails with 401, its masked key in codex's words", { type: 'apiKey' }, { httpConnectionFailed: { httpStatusCode: 401 } },
      'unexpected status 401 Unauthorized: Incorrect API key provided: sk-dummy********************0000. You can find your API key at https://platform.openai.com/account/api-keys.',
      'Codex: unexpected status 401 Unauthorized: Incorrect API key provided: [key hidden]. You can find your API key at https://platform.openai.com/account/api-keys.',
      accountHome('codex', '/accounts/a'), ['OpenAI rejected the key of this Codex account: remove it in Settings → Accounts and add it again.']],
    ["the System API key fails as unauthorized, codex's words without 401", { type: 'apiKey' }, 'unauthorized', 'Your session token eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl was revoked.',
      'Codex: Your session token [key hidden] was revoked.', SYSTEM_HOME,
      ['OpenAI rejected the API key Codex is signed in with: run codex login with a valid key, or add an account in Settings → Accounts.']],
    ['an API-key account fails with an unclassified 401', { type: 'apiKey' }, null, 'unexpected status 401 Unauthorized', 'Codex: unexpected status 401 Unauthorized', null, ['Replace the key.']],
    ['an API-key account hits its usage limit, though its words say 401', { type: 'apiKey' }, 'usageLimitExceeded', 'usage limit reached (401 requests)', 'Codex: usage limit reached (401 requests)', null, []],
    ['an API-key account fails otherwise, though its words say 401', { type: 'apiKey' }, { responseStreamDisconnected: { httpStatusCode: 503 } }, 'unexpected status 503 (retry 401)', 'Codex: unexpected status 503 (retry 401)', null, []],
    ['a ChatGPT account fails with 401', { type: 'chatgpt', email: 'work@example.com', planType: 'plus' }, { httpConnectionFailed: { httpStatusCode: 401 } }, 'unexpected status 401 Unauthorized', 'Codex: unexpected status 401 Unauthorized', null, []],
  ])('tells why when a turn of %s, after its words and before the turn ends', async (_, account, codexErrorInfo, reason, said, hintHome, told) => {
    const home = tempDir('codex-key-home-');
    writeFileSync(join(home, 'auth.json'), JSON.stringify(account));
    // codex reports the error it gave up on, then fails the turn with the same words: the user reads them once, then why.
    const steps = [{ method: 'error', params: { error: { message: reason, codexErrorInfo, additionalDetails: null }, willRetry: false, threadId: '$THREAD', turnId: '$TURN' } }, { fake: 'fail', message: reason, codexErrorInfo }];
    writeFileSync(join(home, 'failed.jsonl'), steps.map((step) => JSON.stringify(step)).join('\n'));
    const s = scene(join(home, 'failed.jsonl'), hintHome === null ? {} : { keyRejectedHint: keyRejectedHint(hintHome) });
    const { transport, events, results } = run({ ...s.launch, codex: { ...s.launch.codex, env: { ...s.launch.codex.env, CODEX_HOME: home } } });
    transport.send(userMessage('hi', []));
    await waitFor(() => results().length === 1, 'the turn failed');
    expect(events.flatMap((event) => (event.type === 'notice' ? [event.text] : event.type === 'result' ? ['(turn ended)'] : []))).toEqual([said, ...told, '(turn ended)']);
  });
});
