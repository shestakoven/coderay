import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookAnswer } from '../../src/gate/hook-gate';
import { ruleset } from '../../src/agent/opencode/config';
import { opencodeMcp } from '../../src/agent/opencode/mcp';
import { shellWrapper } from '../../src/agent/opencode/server';
import { startOpencodeTransport } from '../../src/agent/opencode/transport';
import type { StreamEvent } from '../../src/agent/stream';
import { userMessage, type AgentTransport, type GateCall, type OpencodeLaunch } from '../../src/agent/transport';
import { fakeOpencode, opencodeRecords, requests, type OpencodeRecord } from '../fake-opencode/fake';
import { fixture, tempDir, waitFor } from '../helpers';

type Decide = (calls: GateCall[], signal: AbortSignal) => Promise<HookAnswer | null>;
interface Options { model?: string; effort?: string | null; env?: Record<string, string>; decide?: Decide; resume?: string; record?: string; cwd?: string; userServers?: string[] | null; listenTimeoutMs?: number }
interface Scene {
  transport: AgentTransport; events: StreamEvent[]; asked: GateCall[]; cwd: string; recordFile: string;
  records(): OpencodeRecord[]; said(): string; results(): string[]; refused(): string | null;
  send(text: string): void; ended(count?: number): Promise<unknown>; refusedOrEnded(count?: number): Promise<unknown>;
}
const open: AgentTransport[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((transport) => transport.kill())); });

function start(scenario: string, options: Options = {}): Scene {
  const cwd = options.cwd ?? tempDir('oc-transport-');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  if (!existsSync(join(cwd, 'src/other.ts'))) writeFileSync(join(cwd, 'src/other.ts'), "export const other = 'helo';\n");
  const recordFile = options.record ?? join(cwd, 'rec.jsonl');
  // Every home of the fake is the scene's own: nothing reads or writes the owner's opencode.
  const homes = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map((name) => [name, join(cwd, name.toLowerCase())]));
  const events: StreamEvent[] = [];
  const asked: GateCall[] = [];
  const mcp = opencodeMcp({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer core-secret' } } });
  const launch: OpencodeLaunch = {
    engine: 'opencode', cwd, engineSessionId: options.resume ?? '', resume: options.resume !== undefined,
    model: options.model ?? 'opencode/nemotron-3.5-lightning-free', effort: options.effort ?? null,
    opencode: fakeOpencode(fixture(scenario), recordFile, { ...homes, ...options.env }), servers: mcp.names, mcp, userServers: options.userServers ?? null,
    shell: shellWrapper(cwd, '/bin/zsh'), system: 'SYSTEM TEXT', providerHint: (id) => `opencode has no provider "${id}" connected for this model: add its key in Settings → Accounts, or pick another model.`,
    ...(options.decide ? { decide: async (calls, signal) => { asked.push(...calls); return options.decide!(calls, signal); } } : {}),
    killGraceMs: 500, pidDir: cwd, ...(options.listenTimeoutMs ? { listenTimeoutMs: options.listenTimeoutMs } : {}),
  };
  const transport = startOpencodeTransport(launch, { event: (event) => events.push(event) });
  open.push(transport);
  const results = () => events.flatMap((event) => (event.type === 'result' ? [event.subtype] : []));
  const refused = () => events.flatMap((event) => (event.type === 'refused' ? [event.reason] : []))[0] ?? null;
  return {
    transport, events, asked, cwd, recordFile, results, refused,
    records: () => opencodeRecords(recordFile),
    said: () => events.flatMap((event) => (event.type === 'assistant' ? event.blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : [])) : [])).join('\n'),
    send: (text) => transport.send(userMessage(text, [])),
    ended: (count = 1) => waitFor(() => results().length >= count, `${count} turns ended`),
    refusedOrEnded: (count = 1) => waitFor(() => refused() !== null || results().length >= count, 'refused or ended'),
  };
}
const allow: Decide = async () => ({ permissionDecision: 'allow', permissionDecisionReason: 'in plan' });
const deny = (reason: string, final?: true): Decide => async () => ({ permissionDecision: 'deny', permissionDecisionReason: reason, ...(final ? { final } : {}) });
const hold: Decide = (_calls, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)));
const servers = (t: Scene) => new Set(t.records().flatMap((r) => (r.pid === undefined ? [] : [r.pid])));

describe('startOpencodeTransport', () => {
  it("reads the user's servers from a server without CodeRay's, starts the hardened one with the wrapper shell, checks it, lists the commands as skills, opens the session with the ruleset at the first message, and sends the prompt with the agent, the model, the variant and the system text", async () => {
    const t = start('opencode/reply.jsonl', { model: 'opencode/gpt-oss-120b-free', effort: 'high' });
    expect(await t.transport.skills()).toEqual(['probe-skill']);
    t.send('hi');
    await t.ended();
    const session = t.records().find((r) => r.session)?.session;
    const prompt = t.records().find((r) => r.prompt)?.prompt?.body as Record<string, unknown>;
    const boot = requests(t.records(), 'GET', /^\/(agent|config|config\/providers|command)$/).map((r) => r.path);
    const content = t.records()[0]?.configContent as { shell: string; permission: unknown };
    const init = t.events.find((e) => e.type === 'init') as { skills: string[] };
    const usage = t.events.find((e) => e.type === 'usage') as { update: { contextWindow?: number } };
    expect([t.records()[0]?.env, boot.slice(0, 5), content.shell.endsWith('/opencode-shell/zsh'), session?.permission, prompt.agent, prompt.model, prompt.variant, prompt.system, (prompt.parts as { text: string }[])[0]?.text, t.said(), t.results(), init.skills, usage.update.contextWindow]).toEqual([
      ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_LSP_DOWNLOAD'],
      ['/config', '/agent', '/config', '/config/providers', '/command'], true,
      ruleset(), 'build', { providerID: 'opencode', modelID: 'gpt-oss-120b-free' }, 'high', 'SYSTEM TEXT', 'hi', 'OK', ['success'], ['probe-skill'], 131072,
    ]);
  });

  it('drops an effort the model does not list, opens no session before the first message, and sends a message that comes during a turn after it', async () => {
    const t = start('opencode/multi-turn.jsonl', { effort: 'high' });
    await t.transport.skills();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = requests(t.records(), 'POST', '/session').length;
    // 1.19 folds a prompt sent during a turn into it (Q12b): the second must wait for the first's idle to get its own answer.
    t.send('hi');
    t.send('again');
    await t.ended(2);
    expect([before, 'variant' in ((t.records().find((r) => r.prompt)?.prompt?.body as object) ?? {}), t.said(), t.results()]).toEqual([0, false, 'OK\n42', ['success', 'success']]);
  });

  it.each([
    ['an agent that allows edits', { FAKE_OPENCODE_AGENTS: JSON.stringify([{ name: 'build', mode: 'primary', permission: { '*': 'ask', edit: 'allow' } }]) }, 'opencode agent build would run edit without asking (its rule for edit on * is allow), so the chat was not started.'],
    ['a subagent that allows any tool', { FAKE_OPENCODE_AGENTS: JSON.stringify([{ name: 'build', mode: 'primary', permission: { '*': 'ask' } }, { name: 'general', mode: 'subagent', permission: [{ permission: '*', pattern: '*', action: 'ask' }, { permission: '*', pattern: '*', action: 'allow' }] }]) }, 'opencode agent general would run any tool without asking (its rule for * on * is allow), so the chat was not started.'],
    ['a server that never listens', { FAKE_OPENCODE_NO_LISTEN: '1' }, /^opencode did not start: opencode did not say where it listens/],
    ['a server older than 1.19', { FAKE_OPENCODE_VERSION: '1.18.9' }, /^opencode did not start: opencode 1\.18\.9 is older than 1\.19\.0/],
    ['a model whose provider is not connected', { FAKE_OPENCODE_UNKNOWN_MODEL: '1' }, 'opencode has no provider "opencode" connected for this model: add its key in Settings → Accounts, or pick another model.'],
    ['a reject of an ask CodeRay never saw', { FAKE_OPENCODE_REPLIED: 'reject' }, "Something answered opencode's asks besides CodeRay (permission per_nobody), so the chat was stopped."],
    ['an ask another client allowed', { FAKE_OPENCODE_SCENARIO: fixture('opencode/foreign-reply.jsonl') }, /^Something answered opencode's asks besides CodeRay \(permission per_\d+_\d+\), so the chat was stopped\.$/],
    ['a root session CodeRay did not create', { FAKE_OPENCODE_SCENARIO: fixture('opencode/foreign-session.jsonl') }, "Something created a session on this chat's opencode server besides CodeRay (ses_foreign), so the chat was stopped."],
    ['a provider name that carries the server\'s password', { FAKE_OPENCODE_SCENARIO: fixture('opencode/secret-refusal.jsonl') }, 'opencode has no provider "…" connected for this model: add its key in Settings → Accounts, or pick another model.'],
    ['rules that changed after the first turn', { FAKE_OPENCODE_RULES_FLIP: '1' }, 'opencode agent build would run edit without asking (its rule for edit on * is allow), so the chat was not started.'],
  ])('refuses the chat with the reason on %s, and the agent says nothing', async (_name, env, reason) => {
    // The gate holds every ask: only CodeRay's tripwire can end one.
    const t = start('opencode/multi-turn.jsonl', { env, decide: hold, listenTimeoutMs: 'FAKE_OPENCODE_NO_LISTEN' in env ? 1_000 : undefined });
    t.send('hi');
    await t.refusedOrEnded();
    if (t.refused() === null) { t.send('again'); await t.refusedOrEnded(2); }
    expect([t.said().includes('42'), reason instanceof RegExp ? reason.test(t.refused() ?? '') : t.refused()]).toEqual([false, reason instanceof RegExp ? true : reason]);
  });

  it("switches the user's own MCP servers off by name on the server the chat uses, and refuses a name that clashes with CodeRay's", async () => {
    const quiet = start('opencode/reply.jsonl', { env: { FAKE_OPENCODE_CONFIG: JSON.stringify({ mcp: { usersrv: { type: 'local', command: ['node'] } } }) } });
    quiet.send('hi');
    await quiet.ended();
    const clash = start('opencode/reply.jsonl', { env: { FAKE_OPENCODE_CONFIG: JSON.stringify({ mcp: { idecore: { type: 'remote', url: 'http://x' } } }) } });
    clash.send('hi');
    await clash.refusedOrEnded();
    const config = quiet.records().filter((r) => r.configContent).at(-1)?.configContent as { mcp: Record<string, unknown> };
    expect([config.mcp.usersrv, clash.refused()]).toEqual([{ enabled: false }, 'Your opencode configuration defines an MCP server named "idecore", as CodeRay does: rename yours to run opencode in CodeRay.']);
  });

  it("asks the gate about an edit with its diff and replies once so the file lands; a guard denial travels as the reason, the user's is a plain reject; an edit asked while the event stream was down is judged once it is open again", async () => {
    // The stream drops before the ask: the ask is found with GET /permission when the stream opens again a second later.
    const gap = start('opencode/stream-gap.jsonl', { decide: allow });
    gap.send('fix');
    // The stream takes two seconds to open again, and the ask comes while it opens: only a GET /permission after it opened finds it.
    const slow = start('opencode/stream-hold.jsonl', { decide: allow });
    slow.send('fix');
    const run = async (decide: Decide) => { const t = start('opencode/edit.jsonl', { decide }); t.send('ready?'); await t.ended(1); t.send('fix'); await t.ended(2); return t; };
    const allowed = await run(allow);
    const guard = await run(deny('CodeRay: no approved plan covers src/other.ts'));
    const user = await run(deny('CodeRay: the user denied this call', true));
    await gap.ended(1);
    await slow.ended(1);
    const reply = (t: Scene) => { const r = t.records().find((entry) => entry.reply)?.reply; return r && [r.reply, r.message]; };
    expect([
      allowed.asked.map((call) => [call.tool_name, call.tool_use_id, (call.tool_input.diff as string).includes("+export const other = 'hello';")]), reply(allowed), existsSync(join(allowed.cwd, 'src/other.ts')) && readFileSync(join(allowed.cwd, 'src/other.ts'), 'utf8'),
      reply(guard), guard.events.some((e) => e.type === 'user' && e.toolResults[0]?.rejected === true),
      reply(user),
      gap.asked.map((call) => [call.tool_name, call.tool_use_id]), reply(gap), requests(gap.records(), 'GET', '/event').length, requests(gap.records(), 'GET', '/permission').length, gap.said(),
      slow.asked.map((call) => call.tool_use_id), reply(slow),
    ]).toEqual([[['Edit', 'call_edit1', true]], ['once', null], "export const other = 'hello';\n", ['reject', 'CodeRay: no approved plan covers src/other.ts'], true, ['reject', null], [['Edit', 'call_gap']], ['once', null], 2, 1, 'Done.', ['call_hold'], ['once', null]]);
  });

  it('judges a two-file patch whole, a bash in its workdir after the directory it asked to reach, and rejects an ask whose session opencode cannot find', async () => {
    const patch = start('opencode/two-file.jsonl', { decide: async (calls) => ({ permissionDecision: calls.every((call) => call.tool_name === 'Edit') ? 'allow' : 'deny', permissionDecisionReason: 'only edits' }) });
    patch.send('ready?'); await patch.ended(1); patch.send('patch'); await patch.ended(2);
    const bash = start('opencode/bash-workdir.jsonl', { decide: allow, env: { FAKE_OPENCODE_GONE: 'ses_gone' } });
    bash.send('go'); await bash.ended(1);
    const elsewhere = join(bash.cwd, '../elsewhere');
    expect([
      patch.asked.map((call) => call.tool_name), patch.records().find((r) => r.reply)?.reply?.reply, existsSync(join(patch.cwd, 'src/new.ts')),
      bash.asked.map((call) => [call.tool_name, call.tool_input.command ?? call.tool_input.file_path, call.cwd]), bash.records().filter((r) => r.reply).map((r) => r.reply!.reply),
    ]).toEqual([
      ['Edit', 'Write'], 'reject', false, [['Read', `${bash.cwd}/../elsewhere/*`, bash.cwd], ['Bash', 'rm -rf src', elsewhere]], ['once', 'once', 'reject'],
    ]);
  });

  it("judges the asks of the chat's subagents, announced or resumed, shows a subagent's calls under its task, allows a task only for a subagent that passed, and rejects an ask of a session that is not the chat's before the gate sees it", async () => {
    const t = start('opencode/child-ask.jsonl', { decide: allow });
    t.send('go');
    await t.ended();
    const underTask = t.events.some((e) => e.type === 'assistant' && e.parentToolUseId === 'call_task1' && e.blocks.some((b) => b.kind === 'tool_use' && b.id === 'call_edit2'));
    expect([t.asked.map((call) => call.tool_name), t.records().filter((r) => r.reply).map((r) => r.reply!.reply), underTask]).toEqual([['Task', 'Edit', 'Edit'], ['once', 'once', 'once', 'reject'], true]);
  });

  it("rejects a bash naming the server's secrets before the gate sees it, and never shows the server's password or CodeRay's bearer token", async () => {
    const t = start('opencode/bash-secret.jsonl', { decide: allow });
    t.send('go');
    await t.ended();
    const shown = (type: string) => JSON.stringify(t.events.filter((e) => e.type === type));
    expect([t.asked.length, t.records().find((r) => r.reply)?.reply?.reply, t.said(), ['text_delta', 'user', 'notice', 'assistant'].map((type) => [shown(type).includes('pw=…') || shown(type).includes('OPENCODE_SERVER_PASSWORD=…'), /[0-9a-f]{64}|core-secret/.test(shown(type))])]).toEqual([
      0, 'reject', 'OPENCODE_SERVER_PASSWORD=…, Bearer …', [[true, false], [true, false], [true, false], [true, false]],
    ]);
  });

  it('drops the prompt of a second ask when the first reject made opencode reject it too', async () => {
    let seen = 0;
    const t = start('opencode/parallel-asks.jsonl', { decide: (calls, signal) => { seen += 1; return calls[0]!.tool_name === 'Edit' ? Promise.resolve({ permissionDecision: 'deny', permissionDecisionReason: 'no' }) : new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))); } });
    t.send('go');
    await t.ended();
    const replies = t.records().filter((r) => r.reply).map((r) => [r.reply!.reply, r.reply!.cascaded ?? false]);
    expect([seen, replies]).toEqual([2, [['reject', false], ['reject', true]]]);
  });

  it('answers a held ask with a plain reject on Stop, aborts the session, ends the turn within a second, answers the next message on the same server, and ends a Stop with no turn at once; a server that takes the abort and goes on gets the turn ended after 5 s and its later ask rejected', async () => {
    // Runs beside the rest: its turn goes on after Stop, asks 7 s in, and never idles before that.
    const stuck = start('opencode/stuck.jsonl', { decide: hold, env: { FAKE_OPENCODE_ABORT: 'ignore' } });
    stuck.send('go');
    await waitFor(() => stuck.events.some((e) => e.type === 'assistant' && e.blocks.some((b) => b.kind === 'tool_use')), 'the stuck call runs');
    const stuckAt = Date.now();
    stuck.transport.interrupt();
    const t = start('opencode/hang.jsonl', { decide: hold });
    t.send('hi');
    await waitFor(() => t.asked.length === 1, 'the edit is held');
    const before = servers(t);
    const at = Date.now();
    t.transport.interrupt();
    await t.ended(1);
    const took = Date.now() - at;
    t.send('again');
    await t.ended(2);
    // A Stop with no turn running ends at once and sends opencode nothing.
    t.transport.interrupt();
    await stuck.ended(1);
    const stuckTook = Date.now() - stuckAt;
    await waitFor(() => stuck.records().some((r) => r.reply), 'the late ask is answered');
    const cutOff = stuck.events.some((e) => e.type === 'user' && e.toolResults.some((r) => r.toolUseId === 'call_grep' && r.text === 'unfinished'));
    expect([
      t.results(), took < 1000, requests(t.records(), 'POST', /\/abort$/).length, t.records().find((r) => r.reply)?.reply?.reply, t.said(), servers(t),
      stuck.results(), stuckTook >= 4_900, cutOff, stuck.asked.length, stuck.records().find((r) => r.reply)?.reply?.reply,
    ]).toEqual([['error_during_execution', 'success', 'error_during_execution'], true, 1, 'reject', 'Back.', before, ['error_during_execution'], true, true, 0, 'reject']);
  });

  it("resumes the stored session when it exists with the chat's ruleset, and opens a new one with a notice when opencode has no record of it, or it has other rules or another directory", async () => {
    const t = start('opencode/multi-turn.jsonl');
    t.send('hi'); await t.ended(1);
    const id = (t.events.find((e) => e.type === 'init') as { sessionId: string }).sessionId;
    await t.transport.kill();
    const first = t.records().length;
    const again = start('opencode/multi-turn.jsonl', { resume: id, record: t.recordFile, cwd: t.cwd });
    again.send('again'); await again.ended(1);
    // opencode keeps sessions beside the record: one stored with rules that allow everything, one of another directory.
    const stored = (session: { id: string; permission?: unknown; directory?: string }) => {
      const cwd = tempDir('oc-transport-');
      writeFileSync(join(cwd, 'rec.jsonl.sessions.json'), JSON.stringify({ [session.id]: { parentID: null, directory: cwd, permission: ruleset(), ...session } }));
      return start('opencode/reply.jsonl', { resume: session.id, cwd });
    };
    const others = [
      start('opencode/reply.jsonl', { resume: 'ses_gone', env: { FAKE_OPENCODE_GONE: 'ses_gone' } }),
      stored({ id: 'ses_loose', permission: [{ permission: '*', pattern: '*', action: 'allow' }] }),
      stored({ id: 'ses_moved', directory: '/elsewhere' }),
    ];
    for (const other of others) other.send('hi');
    await Promise.all(others.map((other) => other.ended(1)));
    const second = again.records().slice(first);
    expect([second.find((r) => r.prompt)?.prompt?.session, requests(second, 'POST', '/session').length, again.said(), others.map((other) => [other.events.some((e) => e.type === 'notice' && e.text.includes('no record of this chat')), other.records().filter((r) => r.session).length])]).toEqual([
      id, 0, '42', [[true, 1], [true, 1], [true, 1]],
    ]);
  });

  it("sends a /name message as the command with no request timeout, and a question of the chat or of its resumed subagent to the chat's prompt, answered through opencode, or declined and withdrawn on Stop; another session's question is declined unseen", async () => {
    const t = start('opencode/question.jsonl');
    t.send('/probe-skill now');
    const questions = () => t.events.flatMap((e) => (e.type === 'control_request' ? [e] : []));
    const [first] = await waitFor(() => questions().length === 1 && questions(), 'the question shows');
    t.transport.respond({ subtype: 'success', request_id: first!.requestId, response: { behavior: 'allow', updatedInput: { answers: { 'A or B?': 'A' } } } });
    await t.ended();
    t.send('again');
    const second = (await waitFor(() => questions().length === 2 && questions(), 'the second question shows'))[1]!;
    t.transport.interrupt();
    await t.ended(2);
    t.send('third');
    const third = (await waitFor(() => questions().length === 3 && questions(), 'the subagent question shows'))[2]!;
    t.transport.respond({ subtype: 'success', request_id: third.requestId, response: { behavior: 'allow', updatedInput: { answers: { 'E or F?': 'E' } } } });
    await t.ended(3);
    const prompt = t.records().find((r) => r.prompt)?.prompt;
    const withdrawn = t.events.flatMap((e) => (e.type === 'control_cancel' ? [e.requestId] : []));
    expect([
      prompt?.kind, (prompt?.body as { command: string; arguments: string }).command, (prompt?.body as { arguments: string }).arguments, (first!.input as { questions: { multiSelect: boolean }[] }).questions[0]?.multiSelect,
      t.records().flatMap((r) => (r.questionReply ? [[r.questionReply.kind, r.questionReply.answers]] : [])), t.said(), withdrawn, t.results(), questions().length,
    ]).toEqual(['command', 'probe-skill', 'now', false, [['reply', [['A']]], ['reject', null], ['reply', [['E']]], ['reject', null]], 'You chose A.', [second.requestId], ['success', 'error_during_execution', 'success'], 3]);
  });
});
