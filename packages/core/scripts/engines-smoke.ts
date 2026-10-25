// Opt-in re-check of the Codex engine on the real binary (`pnpm engines:smoke [--codex <path>] [--model <id>] [--only <name>] [--dry-run]`), and the
// re-verification when the pinned version moves. Runs under the System account in a scratch project and deletes the threads it made.
// `--engine opencode [--opencode <path>]` re-checks opencode instead (scripts/opencode-smoke.ts); `--engine background` the background AI on
// real cores in scratch homes (scripts/background-smoke.ts).
// Never part of `pnpm check`. PASS and FAIL check what CodeRay relies on; INFO records what codex does where CodeRay holds either way.
// --dry-run asks the model nothing: it checks the cleanup's guard and the diagnostics tap, and says what the cleanup would delete.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { accountHome, SYSTEM_HOME } from '../src/accounts/account-homes';
import { APP_SERVER_FLAGS, handshake, startAppServer, withAppServer, type AppServer } from '../src/agent/codex/app-server';
import { approvalReply, elicitationReply, NO_PERMISSIONS } from '../src/agent/codex/approvals';
import { codexCommand, codexEnv, codexUnder, type CodexCommand } from '../src/agent/codex/command';
import { codexMcp } from '../src/agent/codex/mcp';
import type { ConfigReadResponse, JsonValue, ThreadStartResponse } from '../src/agent/codex/protocol';
import { hideSecrets } from '../src/agent/codex/secrets';
import { startCodexTransport } from '../src/agent/codex/transport';
import { codexStatus, keyRejectedHint, signedOutHint } from '../src/agent/engines/codex';
import { reapOrphans } from '../src/agent/reaper';
import type { StreamEvent } from '../src/agent/stream';
import { CODEX_APPROVALS } from '../src/agent/system-prompt';
import { userMessage, type AgentTransport, type CodexLaunch, type GateCall } from '../src/agent/transport';
import type { HookAnswer } from '../src/gate/hook-gate';
import { isRecord } from '../src/json';
import { isAlive } from '../src/os-process';

const { values } = parseArgs({ options: {
  engine: { type: 'string', default: 'codex' }, codex: { type: 'string', default: 'codex' }, opencode: { type: 'string', default: 'opencode' },
  model: { type: 'string' }, only: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  claude: { type: 'string', default: 'claude' }, 'ide-home': { type: 'string' }, port: { type: 'string', default: '4319' }, keep: { type: 'boolean', default: false },
} });
if (values.engine === 'opencode') {
  const { runOpencodeSmoke } = await import('./opencode-smoke');
  process.exit(await runOpencodeSmoke({ opencode: values.opencode, model: values.model ?? 'opencode/nemotron-3.5-lightning-free', only: values.only }));
}
if (values.engine === 'background') {
  const { runBackgroundSmoke } = await import('./background-smoke');
  process.exit(await runBackgroundSmoke({
    claude: values.claude, codex: values.codex, opencode: values.opencode, model: values.model ?? 'opencode/nemotron-3.5-lightning-free', ideHome: values['ide-home'],
    port: Number(values.port), only: values.only, keep: values.keep,
  }));
}
if (values.engine !== 'codex') throw new Error(`--engine is codex, opencode or background, not ${values.engine}`);
const codex = codexCommand(values.codex);
const model = values.model ?? 'gpt-6-luna';
const allow: HookAnswer = { permissionDecision: 'allow', permissionDecisionReason: 'smoke' };
const deny: HookAnswer = { permissionDecision: 'deny', permissionDecisionReason: 'smoke' };
// Longer than codex's own 300 s limit for a tool call: only idecore's tool_timeout_sec (a day) lets it finish.
const BLOCKING_MS = 330_000;
const THREAD_POLICY = { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
const TURN_POLICY = { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user', effort: 'low' } as const;
const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// Nothing the smoke prints carries a key, a token or an e-mail address, whatever codex or the model said.
const say = (line: string): void => console.log(hideSecrets(line).replace(EMAIL, '[e-mail hidden]'));
// The transport's log lines (requests it declined, approvals it could not read) are part of the record, not noise between the results.
const logged: string[] = [];
for (const level of ['warn', 'error'] as const) console[level] = (...parts: unknown[]) => void logged.push(parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (list: string[]): string => [...new Set(list)].map((entry) => `${entry}${list.filter((other) => other === entry).length > 1 ? ` (×${list.filter((other) => other === entry).length})` : ''}`).join('; ');

const aux = mkdtempSync(join(tmpdir(), 'coderay-smoke-aux-'));
const project = mkdtempSync(join(tmpdir(), 'coderay-smoke-'));
execFileSync('git', ['init', '-q'], { cwd: project });
writeFileSync(join(project, 'README.md'), '# smoke\n');
const roots = [project, realpathSync(project)];

// A stdio MCP server that leaves a file when it starts, with what its environment gave it: CodeRay's, the project's and an odd-named one.
const stdioServer = join(aux, 'stdio-server.mjs');
writeFileSync(stdioServer, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(process.argv[2], JSON.stringify({ env: process.env.SMOKE_STDIO ?? null }));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'smoke-stdio', version: '0' } } });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] } });
  if (message.method === 'tools/call') return send({ id: message.id, result: { content: [{ type: 'text', text: 'pong ' + process.env.SMOKE_STDIO }] } });
  send({ id: message.id, result: {} });
});
process.stdin.on('end', () => process.exit(0));
`);
const marker = (name: string): string => join(aux, `${name}.started`);
// codex behind a tap that records its notifications for a failing check: never its answers, which carry the user's configuration.
const tap = join(aux, 'codex-tap.mjs');
writeFileSync(tap, `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [command, ...args] = JSON.parse(process.env.SMOKE_TAP_CODEX);
const child = spawn(command, [...args, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
const SAID = new Set(['warning', 'configWarning', 'deprecationNotice', 'error', 'model/rerouted', 'item/mcpToolCall/progress']);
createInterface({ input: child.stdout }).on('line', (line) => {
  process.stdout.write(line + '\\n');
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method !== 'string' || message.id !== undefined || /[Dd]elta$/.test(message.method)) return;
  const item = message.params?.item;
  const detail = SAID.has(message.method) ? message.params : item ? { type: item.type, status: item.status, server: item.server, tool: item.tool } : undefined;
  appendFileSync(process.env.SMOKE_TAP_LOG, JSON.stringify({ at: Date.now(), method: message.method, detail }) + '\\n', { mode: 0o600 });
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
`);
const tapped = (log: string): CodexCommand => ({ ...codexCommand(tap), env: { SMOKE_TAP_LOG: log, SMOKE_TAP_CODEX: JSON.stringify([codex.command, ...codex.args]) } });
const toml = (value: string): string => JSON.stringify(value);
// The project's own Codex configuration names a server: it must never start in a CodeRay chat.
mkdirSync(join(project, '.codex'));
writeFileSync(join(project, '.codex/config.toml'), `[mcp_servers.smoke_project]\ncommand = ${toml(process.execPath)}\nargs = [${toml(stdioServer)}, ${toml(marker('project'))}]\n`);

// The smoke's gate allows what names only paths inside the scratch project (and the shell codex wraps commands in); it denies anything else.
const SYSTEM_PATHS = ['/bin/', '/usr/bin/', '/dev/null'];
const inside = (path: string): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`)) || SYSTEM_PATHS.some((prefix) => path.startsWith(prefix));
async function inProject(call: GateCall): Promise<HookAnswer> {
  // A command's justification is prose: "and/or" in it names no path.
  const named = call.tool_name === 'Bash' ? String(call.tool_input.command) : JSON.stringify(call.tool_input);
  const paths = named.match(/\/[^\s'"\\]+/g) ?? [];
  return inside(call.cwd) && paths.every(inside) ? allow : deny;
}

const token = `smoke-${Date.now()}`;
const header = `header-${process.pid}-${Date.now()}`;
const notes: string[] = [];
let headerSent: boolean | null = null;
let blockingAnswered = false;
// One HTTP server plays two MCP servers: "smoke" (a write tool, no hint) and an idecore stand-in (a blocking read-only tool, with idecore's settings).
const mcp = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
  // JSON answers only: no event stream for codex to open.
  if (req.method !== 'POST') return void res.writeHead(405).end();
  let message: { id?: number; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: { text?: string } } };
  try {
    message = JSON.parse(body) as typeof message;
  } catch {
    return void res.writeHead(400).end();
  }
  if (message.id === undefined) return void res.writeHead(202).end();
  const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  const idecore = req.url?.startsWith('/idecore') ?? false;
  if (message.method === 'initialize') {
    if (!idecore) headerSent = (headerSent ?? true) && req.headers['x-smoke'] === header;
    return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: idecore ? 'idecore' : 'smoke', version: '0' } });
  }
  if (message.method === 'tools/list') {
    return reply({ tools: idecore
      ? [
        { name: 'wait_for_user', description: 'Wait for the user to answer, as propose_plan does.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      ]
      : [{ name: 'write_note', description: 'Write a note into the project.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  }
  if (message.method === 'tools/call' && message.params?.name === 'write_note') {
    notes.push(message.params.arguments?.text ?? '');
    return reply({ content: [{ type: 'text', text: 'written' }] });
  }
  if (message.method === 'tools/call' && message.params?.name === 'ping') return reply({ content: [{ type: 'text', text: 'pong' }] });
  if (message.method === 'tools/call') {
    await pause(BLOCKING_MS);
    if (res.destroyed) return;
    blockingAnswered = true;
    return reply({ content: [{ type: 'text', text: 'The user answered: approved.' }] });
  }
  return reply({});
});
mcp.requestTimeout = 0;
mcp.listen(0, '127.0.0.1');
await new Promise((resolve) => mcp.once('listening', resolve));
const port = (mcp.address() as { port: number }).port;
const rendered = codexMcp({
  idecore: { type: 'http', url: `http://127.0.0.1:${port}/idecore`, headers: { Authorization: `Bearer ${token}` } },
  smoke: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}`, 'X-Smoke': header } },
  smoke_stdio: { type: 'stdio', command: process.execPath, args: [stdioServer, marker('stdio')], env: { SMOKE_STDIO: 'yes' } },
});

const threads = new Set<string>();
const live = new Set<AgentTransport>();
const unknown: string[] = [];
type Decide = (call: GateCall, signal: AbortSignal) => Promise<HookAnswer | null>;
type Init = Extract<StreamEvent, { type: 'init' }>;
interface Run {
  events: StreamEvent[];
  asked: GateCall[];
  results: () => string[];
  refused: () => string | null;
  said: () => string;
  /** What the tools answered: command output, MCP results. */
  output: () => string;
  inits: () => Init[];
  /** The threads the chat ran its turns in, in order. */
  threadIds: () => string[];
  notices: () => string[];
  stop: () => void;
  send: (text: string) => void;
  kill: () => Promise<unknown>;
}

const pick = <T extends StreamEvent['type']>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }>[] =>
  events.filter((event): event is Extract<StreamEvent, { type: T }> => event.type === type);

function start(decide: Decide, command: CodexCommand = codex): Run {
  const events: StreamEvent[] = [];
  const asked: GateCall[] = [];
  const launch: CodexLaunch = {
    engine: 'codex', cwd: project, engineSessionId: '', resume: false, model, effort: 'low', codex: command, pidDir: aux, servers: rendered.names,
    config: rendered.config, env: { ...rendered.env, SMOKE_PROBE: '1' }, developerInstructions: CODEX_APPROVALS,
    signedOutHint: signedOutHint(SYSTEM_HOME), keyRejectedHint: keyRejectedHint(SYSTEM_HOME),
    // As the gate does: call by call, until one is not allowed.
    decide: async (calls, signal) => {
      let answer: HookAnswer | null = null;
      for (const call of calls) {
        asked.push(call);
        answer = await decide(call, signal);
        if (answer?.permissionDecision !== 'allow') break;
      }
      return answer;
    },
  };
  const transport = startCodexTransport(launch, { event: (event) => {
    events.push(event);
    if (event.type === 'init') threads.add(event.sessionId);
    if (event.type === 'unknown') unknown.push(event.label);
  } });
  live.add(transport);
  return {
    events, asked,
    results: () => pick(events, 'result').map((event) => event.subtype),
    refused: () => pick(events, 'refused')[0]?.reason ?? null,
    said: () => pick(events, 'assistant').flatMap((event) => event.blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []))).join('\n'),
    output: () => pick(events, 'user').flatMap((event) => event.toolResults.map((result) => result.text)).join('\n'),
    inits: () => pick(events, 'init'),
    threadIds: () => [...new Set(pick(events, 'init').map((init) => init.sessionId))],
    notices: () => pick(events, 'notice').map((event) => event.text),
    stop: () => transport.interrupt(),
    send: (text) => transport.send(userMessage(text, [])),
    kill: () => {
      live.delete(transport);
      return transport.kill();
    },
  };
}

const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await pause(200);
  }
  return true;
};
const ended = (r: Run, count = 1, ms = 180_000) => until(() => r.results().length >= count || r.refused() !== null, ms);
const running = (pattern: string): string => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
// After a Stop the chat goes on in its own thread, or, when codex kept no record of it, in a new one with a notice.
const continued = (r: Run): string => {
  const ids = r.threadIds();
  if (r.notices().some((text) => text.includes('has no record'))) return 'went on in a new thread (codex kept no record of the stopped one)';
  return ids.length === 1 ? 'resumed the same thread' : `ran in ${ids.length} threads`;
};
const pending: string[] = [];
const note = (text: string): void => void pending.push(text);

// What a raw app-server (no transport) sees: the facts below read codex's own messages, with the owner's MCP servers, apps and plugins off.
let quiet: Record<string, JsonValue> = {};
const limitShapes = new Set<string>();
const rawRequests: string[] = [];
const agentModes = new Set<string>();
let grantRoots = 0;

function limitShape(snapshot: unknown): string {
  if (!isRecord(snapshot)) return 'not an object';
  const window = (value: unknown): string => (isRecord(value) ? `${String(value.windowDurationMins)} min` : 'none');
  return `limitId ${JSON.stringify(snapshot.limitId)} (${JSON.stringify(snapshot.limitName)}): primary ${window(snapshot.primary)}, secondary ${window(snapshot.secondary)}`;
}

interface Raw { server: AppServer; seen: string[]; open: (ephemeral: boolean) => Promise<ThreadStartResponse>; turn: (threadId: string, text: string) => Promise<boolean> }

async function raw(): Promise<Raw> {
  const seen: string[] = [];
  const server: AppServer = startAppServer(codex, {
    cwd: project,
    onNotification: ({ method, params }) => {
      seen.push(method);
      if (method === 'account/rateLimits/updated' && isRecord(params)) limitShapes.add(limitShape(params.rateLimits));
    },
    onRequest: ({ id, method, params }) => {
      seen.push(method);
      rawRequests.push(method);
      if (isRecord(params) && params.grantRoot !== null && params.grantRoot !== undefined) grantRoots += 1;
      if (method === 'item/permissions/requestApproval') server.rpc.reply(id, NO_PERMISSIONS);
      else if (method === 'mcpServer/elicitation/request') server.rpc.reply(id, elicitationReply('decline'));
      else if (method.endsWith('/requestApproval')) server.rpc.reply(id, approvalReply('decline'));
      else server.rpc.fail(id, -32601, `CodeRay does not handle ${method}.`);
    },
  });
  await handshake(server.rpc);
  return {
    server, seen,
    open: async (ephemeral) => {
      const answer = await server.rpc.request<ThreadStartResponse>('thread/start', { cwd: project, model, ...THREAD_POLICY, ephemeral, config: quiet });
      agentModes.add(JSON.stringify(answer.multiAgentMode ?? null));
      return answer;
    },
    turn: async (threadId, text) => {
      const from = seen.length;
      await server.rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], model, ...TURN_POLICY });
      return until(() => seen.indexOf('turn/completed', from) !== -1, 180_000);
    },
  };
}

async function quietConfig(): Promise<Record<string, JsonValue>> {
  const answer = await withAppServer(codex, project, (rpc) => rpc.request<ConfigReadResponse>('config/read', { cwd: project, includeLayers: false }));
  const servers = isRecord(answer.config.mcp_servers) ? Object.keys(answer.config.mcp_servers) : [];
  return { 'features.apps': false, 'features.plugins': false, 'features.deferred_executor': false, ...Object.fromEntries(servers.map((name) => [`mcp_servers.${name}.enabled`, false])) };
}

// What a failing turn leaves before the cleanup deletes it: codex's items, and the notifications the transport does not turn into events.
async function explain(threadId: string | undefined, wire: string): Promise<void> {
  type Turns = { thread: { turns?: { items?: Record<string, unknown>[] }[] } };
  const answer = threadId === undefined ? new Error('no thread') : await withAppServer(codex, project, (rpc) => rpc.request<Turns>('thread/read', { threadId, includeTurns: true })).catch((error: Error) => error);
  const item = (entry: Record<string, unknown>): string => {
    const error = isRecord(entry.error) ? ` ${String(entry.error.message)}` : '';
    const words = typeof entry.text === 'string' ? ` (${String(entry.phase)}) ${entry.text.slice(0, 100)}` : '';
    const tool = typeof entry.tool === 'string' ? ` ${String(entry.server)}/${entry.tool} ${String(entry.status)} ${String(entry.durationMs)} ms` : '';
    return `${String(entry.type)}${tool}${error}${words}`;
  };
  note(`the failing turn's items: ${answer instanceof Error ? `could not be read (${answer.message})` : (answer.thread.turns ?? []).flatMap((turn) => turn.items ?? []).map(item).join(' | ') || 'none'}`);
  const lines = (existsSync(wire) ? readFileSync(wire, 'utf8').split('\n') : []).filter((line) => line !== '').map((line) => JSON.parse(line) as { at: number; method: string; detail?: unknown });
  const first = lines[0]?.at ?? 0;
  const shown = lines.filter((line) => !/^(thread\/tokenUsage|account\/rateLimits)\//.test(line.method));
  note(`its notifications: ${shown.map((line) => `+${((line.at - first) / 1000).toFixed(1)} s ${line.method}${line.detail === undefined ? '' : ` ${JSON.stringify(line.detail).slice(0, 160)}`}`).join(' | ') || 'none recorded'}`);
}

interface Item { name: string; check?: () => Promise<string | null>; fact?: () => Promise<string> }

const items: Item[] = [
  { name: 'patch accepted', check: async () => {
    const r = start(inProject);
    r.send('Create the file hello.txt containing the word hi, using apply_patch. Do nothing else.');
    await ended(r);
    await r.kill();
    return r.refused() ?? (existsSync(join(project, 'hello.txt')) && r.asked.some((call) => call.tool_name === 'Write') ? null : 'no file or no Write asked');
  } },
  { name: 'patch declined', check: async () => {
    const r = start(async () => deny);
    r.send('Create the file declined.txt containing no, using apply_patch. Do nothing else.');
    await ended(r);
    await r.kill();
    return r.refused() ?? (!existsSync(join(project, 'declined.txt')) && r.asked.length > 0 ? null : 'the file exists or nothing was asked');
  } },
  { name: 'multi-file patch: an update, a deletion and a move, each path its own question', check: async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(project, name), `${name}\n`);
    const r = start(inProject);
    r.send('In one single apply_patch call: change a.txt to contain the word A, delete b.txt, and move c.txt to d.txt. Do nothing else.');
    await ended(r);
    await r.kill();
    const asked = r.asked.map((call) => (call.tool_name === 'Bash' ? String(call.tool_input.command).split(' ')[0] : call.tool_name));
    const landed = readFileSync(join(project, 'a.txt'), 'utf8').includes('A') && !existsSync(join(project, 'b.txt')) && existsSync(join(project, 'd.txt'));
    return r.refused() ?? (['Edit', 'rm', 'mv'].every((kind) => asked.includes(kind)) && landed ? null : `asked ${asked.join(', ') || 'nothing'}; landed: ${landed}`);
  } },
  { name: 'escalated shell write', check: async () => {
    const r = start(inProject);
    r.send('Run the shell command `echo x > esc.txt` in the project. It writes a file, so request escalation. Do nothing else.');
    await ended(r);
    await r.kill();
    const bash = r.asked.find((call) => call.tool_name === 'Bash');
    note(`the shell codex wraps an escalated command in: ${bash ? String(bash.tool_input.command).split(' ')[0] : 'not seen (no escalated command)'}`);
    return r.refused() ?? (existsSync(join(project, 'esc.txt')) && bash !== undefined ? null : 'no file or no Bash asked');
  } },
  { name: 'sandboxed shell write (no escalation)', check: async () => {
    const r = start(inProject);
    r.send('Run the shell command `echo y > quiet.txt` without requesting escalation. If it fails, just say so.');
    await ended(r);
    await r.kill();
    return r.refused() ?? (!existsSync(join(project, 'quiet.txt')) && r.asked.length === 0 ? null : 'the OS sandbox let it write, or it was asked');
  } },
  { name: "a shell command sees none of CodeRay's MCP secrets (shell_environment_policy.exclude)", check: async () => {
    const r = start(inProject);
    r.send("Run exactly this shell command once, without escalation, and do nothing else: printenv | grep -c '^CODERAY_' ; printenv | grep -c '^SMOKE_PROBE='");
    await ended(r);
    await r.kill();
    const counts = r.output().trim().split(/\s+/).join(' ');
    if (r.refused() !== null) return r.refused();
    if (counts === '0 1') return null;
    return counts === '0 0' ? 'inconclusive: the shell inherits nothing from the app-server' : `the counts of CODERAY_ and SMOKE_PROBE variables were: ${JSON.stringify(counts)}`;
  } },
  { name: "CodeRay's MCP servers start under codex (http with bearer and env_http_headers, stdio with command, args and env), and no other", check: async () => {
    const r = start(inProject);
    r.send('Call the smoke_stdio MCP tool ping once and reply with its answer. Do nothing else.');
    await ended(r);
    await r.kill();
    const servers = r.inits().flatMap((init) => init.mcpServers);
    note(`MCP servers when the turn started: ${count(servers.map((server) => `${server.name} ${server.status}`)) || 'none'}`);
    const others = [...new Set(servers.map((server) => server.name))].filter((name) => !rendered.names.includes(name));
    const stdio = existsSync(marker('stdio')) ? (JSON.parse(readFileSync(marker('stdio'), 'utf8')) as { env: string | null }).env : undefined;
    const problems = [
      ...(others.length > 0 ? [`servers CodeRay did not configure: ${others.join(', ')}`] : []),
      ...(existsSync(marker('project')) ? ["the project's own server started"] : []),
      ...(stdio === undefined ? ['the stdio server never started'] : stdio === 'yes' ? [] : [`the stdio server got SMOKE_STDIO=${String(stdio)}`]),
      ...(r.output().includes('pong yes') ? [] : ['its tool did not answer']),
      ...(headerSent === true ? [] : [`the X-Smoke header ${headerSent === null ? 'never came (no initialize)' : 'did not reach the http server'}`]),
    ];
    return r.refused() ?? (problems.length === 0 ? null : problems.join('; '));
  } },
  { name: 'MCP elicitation accept', check: async () => {
    const r = start(inProject);
    r.send('Call the smoke MCP tool write_note with text "hi". Do nothing else.');
    await ended(r);
    await r.kill();
    return r.refused() ?? (notes.includes('hi') && r.asked.some((call) => call.tool_name === 'mcp__smoke__write_note') ? null : 'the tool did not run, or was not asked');
  } },
  // What the model says its tools are called is no evidence (gpt-6-luna answers nothing, bare names or "none"): the calls a prompt's names lead to are.
  { name: 'the model calls MCP tools by mcp__<server>__<tool>, the names the Codex prompt uses', check: async () => {
    const r = start(async () => deny);
    r.send('Call the tool mcp__idecore__ping, then call the tool mcp__smoke__write_note with text "named". Do nothing else.');
    await ended(r);
    await r.kill();
    const called = pick(r.events, 'assistant').flatMap((event) => event.blocks.flatMap((block) => (block.kind === 'tool_use' ? [block.name] : [])));
    return r.refused() ?? (['mcp__idecore__ping', 'mcp__smoke__write_note'].every((name) => called.includes(name)) ? null : `called: ${called.join(', ') || 'nothing'}; said: ${r.said().slice(0, 160)}`);
  } },
  { name: "a blocking idecore call outlives codex's 300 s tool limit and its deferred executor's 160 s", check: async () => {
    const wire = join(aux, 'blocking-wire.jsonl');
    const r = start(async () => deny, tapped(wire));
    r.send('Call the idecore MCP tool wait_for_user once and report its answer.');
    await ended(r, 1, BLOCKING_MS + 120_000);
    await r.kill();
    const said = r.said();
    const problem = r.refused() ?? (blockingAnswered && said.toLowerCase().includes('approved') && r.asked.length === 0 ? null : `answered: ${blockingAnswered}, ${r.asked.length} asked, said: ${said.slice(0, 120)}`);
    if (problem !== null) await explain(r.threadIds()[0], wire);
    return problem;
  } },
  { name: 'Stop while a write waits for the user', check: async () => {
    let held = false;
    const r = start((_call, signal) => new Promise((resolve) => {
      held = true;
      signal.addEventListener('abort', () => resolve(null));
    }));
    r.send('Create the file held.txt containing held, using apply_patch. Do nothing else.');
    const asked = await until(() => held, 180_000);
    const at = Date.now();
    r.stop();
    const stopped = await until(() => r.results().length > 0, 6_000);
    const took = Date.now() - at;
    r.send('Reply with the single word back.');
    const answered = await ended(r, 2, 120_000);
    await r.kill();
    note(`after Stop with a held write the next message ${continued(r)}`);
    if (!asked) return 'the write never reached the gate';
    return stopped && !existsSync(join(project, 'held.txt')) && answered ? null : `stopped: ${stopped} (${took} ms); file written: ${existsSync(join(project, 'held.txt'))}; answered after Stop: ${answered}`;
  } },
  { name: 'Stop with a running shell command', check: async () => {
    const r = start(inProject);
    r.send('Run the shell command `sleep 1207` and wait for it to finish.');
    const started = await until(() => r.events.some((event) => event.type === 'assistant' && event.blocks.some((block) => block.kind === 'tool_use' && block.name === 'Bash')), 120_000);
    await pause(2_000);
    const at = Date.now();
    r.stop();
    const stopped = await until(() => r.results().length > 0, 6_000);
    const took = Date.now() - at;
    await pause(3_000);
    const left = running('sleep 1207');
    if (left !== '') execFileSync('kill', ['-9', ...left.split('\n')]);
    r.send('Reply with the single word back.');
    const answered = await ended(r, 2, 120_000);
    await r.kill();
    note(`Stop ended the turn with a running command in ${took} ms; the next message ${continued(r)}`);
    if (!started || !stopped) return `the command never ran or Stop did not end the turn (${took} ms)`;
    return left === '' && answered ? null : `sleep left running: ${left || 'none'}; answered after Stop: ${answered}`;
  } },
  { name: 'Stop as soon as a turn starts, then the next message', check: async () => {
    const r = start(inProject);
    r.send('Reply with the single word one.');
    const begun = await until(() => r.inits().length > 0, 120_000);
    r.stop();
    const stopped = await until(() => r.results().length > 0, 6_000);
    r.send('Reply with the single word two.');
    const answered = await ended(r, 2, 120_000);
    await r.kill();
    note(`after a turn stopped as it started the next message ${continued(r)}`);
    return begun && stopped && answered && r.refused() === null ? null : `turn started: ${begun}; stopped: ${stopped}; answered: ${answered}; refused: ${r.refused() ?? 'no'}`;
  } },
  { name: "item/fileChange/patchUpdated and a patch's approval", fact: async () => {
    const session = await raw();
    try {
      const { thread } = await session.open(true);
      const from = session.seen.length;
      await session.turn(thread.id, 'In one apply_patch call create x1.txt, x2.txt and x3.txt, each containing x.');
      const order = session.seen.slice(from);
      const updated = order.indexOf('item/fileChange/patchUpdated');
      const asked = order.indexOf('item/fileChange/requestApproval');
      if (asked === -1) return `no approval was requested (patchUpdated ${updated === -1 ? 'never sent' : 'sent'})`;
      return updated === -1 ? 'never sent' : updated < asked ? 'sent before the approval' : 'sent after the approval';
    } finally {
      await session.server.kill();
    }
  } },
  { name: 'a request for more permissions', fact: async () => {
    const session = await raw();
    try {
      const { thread } = await session.open(true);
      const from = session.seen.length;
      const done = await session.turn(thread.id, 'Ask for network access permission for this turn with your permissions request, then fetch https://example.com and say what happened.');
      const asked = session.seen.slice(from).includes('item/permissions/requestApproval');
      return `${asked ? 'sent; answered with none' : 'not provoked by this prompt'}, and the turn ${done ? 'ended' : 'did not end in 180 s'}`;
    } finally {
      await session.server.kill();
    }
  } },
  { name: "a turnless thread's rollout", fact: async () => {
    const session = await raw();
    try {
      const { thread } = await session.open(false);
      await pause(1_000);
      const written = thread.path !== null && existsSync(thread.path);
      const deleted = await session.server.rpc.request('thread/delete', { threadId: thread.id }).then(() => true, () => false);
      if (!deleted) threads.add(thread.id);
      return written ? 'written at thread/start' : 'not written until a turn';
    } finally {
      await session.server.kill();
    }
  } },
  { name: 'thread/resume with excludeTurns of a thread with turns', fact: async () => {
    const first = await raw();
    let threadId: string;
    try {
      threadId = (await first.open(false)).thread.id;
      threads.add(threadId);
      if (!(await first.turn(threadId, 'Reply with the single word ok.'))) return 'its turn did not end in 180 s';
    } finally {
      await first.server.kill();
    }
    const second = await raw();
    try {
      type Turns = { thread: { turns?: unknown[] } };
      const read = await second.server.rpc.request<Turns>('thread/read', { threadId, includeTurns: true });
      const resumed = await second.server.rpc.request<Turns>('thread/resume', { threadId, cwd: project, model, ...THREAD_POLICY, config: quiet, excludeTurns: true });
      return `a thread with ${read.thread.turns?.length ?? 'no'} turns resumes with ${resumed.thread.turns === undefined ? 'no turns field' : `${resumed.thread.turns.length} turns`}`;
    } finally {
      await second.server.kill();
    }
  } },
  { name: 'app-server on stdin EOF', fact: async () => {
    const child = spawn(codex.command, [...codex.args, 'app-server', ...APP_SERVER_FLAGS], { cwd: project, env: codexEnv(codex), stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end();
    const exited = await Promise.race([new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))), pause(5_000).then(() => false)]);
    if (!exited) child.kill('SIGKILL');
    return exited ? 'exits' : 'keeps running';
  } },
  { name: 'a core killed with SIGKILL, and the next core reaping', fact: async () => {
    const pidDir = join(aux, 'pids-kill');
    mkdirSync(pidDir);
    // The prompt travels in the environment: pgrep reads command lines, and the host's must not name the command it looks for.
    const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const env = process.env;
      const { startAppServer, handshake } = await import(env.SMOKE_APP_SERVER);
      const server = startAppServer(JSON.parse(env.SMOKE_CODEX), { cwd: env.SMOKE_PROJECT, pidDir: env.SMOKE_PIDS });
      await handshake(server.rpc);
      const { thread } = await server.rpc.request('thread/start', { cwd: env.SMOKE_PROJECT, model: env.SMOKE_MODEL, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, config: JSON.parse(env.SMOKE_CONFIG) });
      await server.rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: env.SMOKE_PROMPT, text_elements: [] }] });
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore', env: {
      ...process.env, SMOKE_APP_SERVER: new URL('../src/agent/codex/app-server.ts', import.meta.url).href, SMOKE_CODEX: JSON.stringify(codex),
      SMOKE_PROJECT: project, SMOKE_PIDS: pidDir, SMOKE_MODEL: model, SMOKE_CONFIG: JSON.stringify(quiet), SMOKE_PROMPT: 'Run the shell command sleep 1211 and wait for it.',
    } });
    const started = await until(() => running('sleep 1211') !== '', 120_000);
    const pidFile = readdirSync(pidDir).find((name) => name.startsWith('codex-'));
    const serverPid = pidFile === undefined ? null : Number(/\d+/.exec(pidFile)?.[0]);
    host.kill('SIGKILL');
    await pause(5_000);
    const serverAlive = serverPid !== null && isAlive(serverPid);
    const reaped = await reapOrphans(pidDir, 2_000);
    await pause(1_000);
    const left = running('sleep 1211');
    if (left !== '') execFileSync('kill', ['-9', ...left.split('\n')]);
    if (!started) return 'the shell command never started';
    const server = serverPid === null ? 'left no pid file' : serverAlive ? 'kept running after its core died' : 'exited when its core died';
    return `the app-server ${server}; the reaper stopped ${reaped.length} process(es); the shell command was ${left === '' ? 'gone' : 'left running (the smoke killed it)'}`;
  } },
  { name: 'rate-limit buckets', fact: async () => {
    const answer = await withAppServer(codex, project, (rpc) => rpc.request<Record<string, unknown>>('account/rateLimits/read', { excludeResetCreditDetails: true }));
    const buckets = isRecord(answer.rateLimitsByLimitId) ? Object.entries(answer.rateLimitsByLimitId).map(([id, snapshot]) => `${id} → ${limitShape(snapshot)}`) : [];
    return `account/rateLimits/read: ${buckets.join('; ') || 'no buckets'}; account/rateLimits/updated in this run: ${[...limitShapes].join('; ') || 'none'}`;
  } },
  { name: 'a sub-agent the user asks for', fact: async () => {
    const from = logged.length;
    const r = start(inProject);
    r.send('Start one sub-agent and have it create the file sub.txt containing sub, using apply_patch. Do not create the file yourself, and do nothing else.');
    const done = await ended(r, 1, 300_000);
    await r.kill();
    const asked = r.asked.map((call) => `${call.tool_name}${JSON.stringify(call.tool_input).includes('sub.txt') ? ' sub.txt' : ''}`);
    const odd = pick(r.events, 'unknown').map((event) => event.label);
    return [
      ...(r.refused() === null ? [] : [`refused: ${r.refused()}`]),
      `the turn ${done ? 'ended' : 'did not end in 300 s'}`,
      `the gate was asked: ${asked.join(', ') || 'nothing'}`,
      `sub.txt ${existsSync(join(project, 'sub.txt')) ? 'written' : 'not written'}`,
      `unknown events: ${count(odd) || 'none'}`,
      `log: ${count(logged.slice(from)) || 'none'}`,
      `the model said: ${r.said().replace(/\s+/g, ' ').slice(0, 200)}`,
    ].join('; ');
  } },
  { name: "the user's Codex configuration in a trusted project, and a server named with a dot (scratch home, no turn)", fact: async () => {
    const home = join(aux, 'codex-home');
    mkdirSync(home);
    const trust = roots.map((root) => `[projects.${toml(root)}]\ntrust_level = "trusted"\n`).join('');
    writeFileSync(join(home, 'config.toml'), `${trust}\n[mcp_servers.${toml('odd.name')}]\ncommand = ${toml(process.execPath)}\nargs = [${toml(stdioServer)}, ${toml(marker('odd'))}]\n`);
    for (const name of ['project', 'odd']) rmSync(marker(name), { force: true });
    const statuses: string[] = [];
    const server = startAppServer(codexUnder(codex, accountHome('codex', home)), {
      cwd: project,
      onNotification: ({ method, params }) => {
        if (method === 'mcpServer/startupStatus/updated' && isRecord(params)) statuses.push(`${String(params.name)} ${String(params.status)}`);
      },
    });
    try {
      await handshake(server.rpc);
      const { config } = await server.rpc.request<ConfigReadResponse>('config/read', { cwd: project, includeLayers: false });
      const names = isRecord(config.mcp_servers) ? Object.keys(config.mcp_servers) : [];
      const open = (off: string[]) => server.rpc.request('thread/start', {
        cwd: project, ...THREAD_POLICY, ephemeral: true, config: { 'features.apps': false, 'features.plugins': false, ...Object.fromEntries(off.map((name) => [`mcp_servers.${name}.enabled`, false])) },
      }).then(() => 'opened', (error: Error) => `refused (${error.message.split('\n')[0]})`);
      const plain = names.filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
      const opened = await open(plain);
      await pause(5_000);
      const started = ['project', 'odd'].filter((name) => existsSync(marker(name)));
      const dotted = await open(names.filter((name) => !plain.includes(name)));
      return [
        `config/read lists ${names.map((name) => JSON.stringify(name)).join(', ') || 'no server'}`,
        `a thread switching off ${plain.join(', ') || 'none'} by mcp_servers.<name>.enabled: ${opened}, then started: ${started.join(', ') || 'none'}, startup statuses: ${count(statuses) || 'none'}`,
        `a thread switching off the dotted names the same way: ${dotted}`,
      ].join('; ');
    } finally {
      await server.kill();
    }
  } },
];

interface Listed { id: string; cwd?: unknown }

// The threads the cleanup may delete: those the smoke saw, and those codex lists with the scratch project as their own cwd. Never one
// that codex's cwd filter merely returned: a version that drops or renames the filter would list the user's whole history.
function ours(listed: Listed[], seen: Set<string>): { ids: string[]; byCwd: number; foreign: number } {
  const own = (cwd: unknown): boolean => typeof cwd === 'string' && roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  const byCwd = listed.filter((thread) => own(thread.cwd)).map((thread) => thread.id);
  const ids = [...new Set([...seen, ...byCwd])];
  return { ids, byCwd: byCwd.length, foreign: listed.filter((thread) => !ids.includes(thread.id)).length };
}

async function deleteThreads(dryRun = false): Promise<string> {
  return withAppServer(codex, project, async (rpc) => {
    const list = async (): Promise<Listed[]> => {
      const found: Listed[] = [];
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        do {
          const page: { data: Listed[]; nextCursor: string | null } = await rpc.request('thread/list', { cwd: roots, archived, sourceKinds: SOURCES, limit: 100, cursor });
          found.push(...page.data.map((thread) => ({ id: thread.id, cwd: thread.cwd })));
          cursor = page.nextCursor;
        } while (cursor !== null);
      }
      return found;
    };
    const listed = await list();
    const { ids, byCwd, foreign } = ours(listed, threads);
    if (foreign > 0) {
      failed += 1;
      say(`FAIL cleanup: codex listed ${foreign} thread(s) of other projects for the scratch project; only the smoke's own are deleted`);
    }
    const found = `${listed.length} listed for the scratch project, ${byCwd} of them with its cwd`;
    if (dryRun) return `dry run: would delete ${ids.length} thread(s) (${found})`;
    const paths = await Promise.all(ids.map((threadId) => rpc.request<ThreadStartResponse>('thread/read', { threadId }).then((answer) => answer.thread.path, () => null)));
    const failures = (await Promise.all(ids.map((threadId) => rpc.request('thread/delete', { threadId }).then(() => null, (error: Error) => error.message.split('\n')[0] ?? '')))).filter((failure) => failure !== null);
    const left = ours(await list(), new Set()).ids.length;
    const kept = paths.filter((path) => path !== null && existsSync(path)).length;
    const notDeleted = failures.length === 0 ? '' : ` (not deleted: ${count(failures)})`;
    return `${ids.length - failures.length} of ${ids.length} threads deleted${notDeleted} (${found}); ${left} still listed for the project; ${kept} of ${paths.filter((path) => path !== null).length} rollout files left`;
  }, 120_000);
}

let failed = 0;
async function finish(code: number): Promise<never> {
  for (const transport of live) await transport.kill().catch(() => undefined);
  const cleanup = await deleteThreads().catch((error: Error) => `the threads could not be deleted: ${error.message}`);
  mcp.close();
  rmSync(aux, { recursive: true, force: true });
  if (code === 0) rmSync(project, { recursive: true, force: true });
  say(`${failed === 0 ? (code === 0 ? 'all passed' : 'stopped') : `${failed} failed`}; ${cleanup}${code === 0 ? '' : `; project kept at ${project}`}`);
  process.exit(code);
}

const state = await codexStatus(codex, project, signedOutHint(SYSTEM_HOME));
say(`codex: ${state.state}${state.hint ? ` (${state.hint})` : ''}`);
if (state.state !== 'ready') {
  mcp.close();
  rmSync(aux, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exit(1);
}
process.once('SIGINT', () => void finish(130));
if (values['dry-run']) {
  const sample = ours([{ id: 'own', cwd: roots[0] }, { id: 'own-resolved', cwd: `${roots[1]}/sub` }, { id: 'seen', cwd: '/elsewhere' }, { id: 'other', cwd: '/elsewhere' }, { id: 'no-cwd' }], new Set(['seen']));
  const guarded = sample.ids.join(',') === 'seen,own,own-resolved' && sample.byCwd === 2 && sample.foreign === 2;
  if (!guarded) failed += 1;
  say(`${guarded ? 'PASS' : 'FAIL'} the cleanup deletes only threads the smoke saw or whose own cwd is the scratch project${guarded ? '' : `: kept ${sample.ids.join(', ')}, ${sample.foreign} foreign`}`);
  const wire = join(aux, 'tap-check.jsonl');
  await withAppServer(tapped(wire), project, () => pause(1_000)).catch(() => undefined);
  const heard = existsSync(wire) ? readFileSync(wire, 'utf8').split('\n').filter((line) => line !== '').length : 0;
  if (heard === 0) failed += 1;
  say(`${heard > 0 ? 'PASS' : 'FAIL'} the diagnostics tap records codex's notifications (${heard} on a handshake)`);
  await explain(undefined, wire);
  for (const line of pending.splice(0)) say(`INFO what a failing blocking check would add: ${line}`);
  say(await deleteThreads(true).catch((error: Error) => `the cleanup could not list the threads: ${error.message}`));
  mcp.close();
  rmSync(aux, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
quiet = await quietConfig();
for (const item of items.filter((candidate) => values.only === undefined || candidate.name.includes(values.only))) {
  const at = Date.now();
  const took = () => `${Math.round((Date.now() - at) / 1000)} s`;
  if (item.check) {
    const problem = await item.check().catch((error: Error) => `threw: ${error.message}`);
    if (problem !== null) failed += 1;
    say(`${problem === null ? 'PASS' : 'FAIL'} ${item.name} (${took()})${problem === null ? '' : `: ${problem}`}`);
  } else if (item.fact) {
    const answer = await item.fact().catch((error: Error) => `could not be read: ${error.message}`);
    say(`INFO ${item.name} (${took()}): ${answer}`);
  }
  for (const line of pending.splice(0)) say(`INFO ${line}`);
}
say(`INFO multiAgentMode in the raw thread/start echoes: ${[...agentModes].join(', ') || 'no raw thread opened'}`);
say(`INFO server requests the raw sessions got: ${count(rawRequests) || 'none'}; grantRoot set on ${grantRoots}`);
say(`INFO unknown events in the chats: ${count(unknown) || 'none'}`);
say(`INFO log lines: ${count(logged) || 'none'}`);
await finish(failed === 0 ? 0 : 1);
