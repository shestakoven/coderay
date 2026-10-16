#!/usr/bin/env node
// Stands in for `codex app-server`: answers CodeRay's requests and replays a scenario (test/fixtures/codex/README.md).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const argv = process.argv.slice(2);
const VERSION = env.FAKE_CODEX_VERSION ?? '0.160.0';
if (argv[0] === '--version') {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}
if (argv[0] !== 'app-server') {
  process.stderr.write(`fake-codex: unsupported arguments ${argv.join(' ')}\n`);
  process.exit(2);
}

const ownHome = env.CODEX_HOME !== undefined;
const authFile = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
const record = (entry) => {
  if (env.FAKE_CODEX_RECORD) appendFileSync(env.FAKE_CODEX_RECORD, `${JSON.stringify(entry)}\n`);
};
record({
  pid: process.pid, argv, codexHome: env.CODEX_HOME ?? null,
  credentials: ['OPENAI_API_KEY', 'CODEX_API_KEY'].filter((name) => env[name] !== undefined),
  secrets: Object.keys(env).filter((name) => name.startsWith('CODERAY_')).sort(),
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ id, result });
const refuse = (id, message) => send({ id, error: { code: -32602, message } });
const notify = (method, params) => send({ method, params });

function account() {
  if (env.FAKE_CODEX_ACCOUNT === 'none') return null;
  if (!ownHome) return { type: 'chatgpt', email: env.FAKE_CODEX_EMAIL ?? 'owner@example.com', planType: 'plus' };
  return existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf8')) : null;
}

const efforts = (names) => names.map((name) => ({ reasoningEffort: name, description: name }));
const MODELS = [
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max']) },
  { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Deep', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'ultra']) },
  { id: 'codex-internal', model: 'codex-internal', displayName: 'Internal', description: 'Hidden', hidden: true, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts(['medium']) },
];
const userServers = JSON.parse(env.FAKE_CODEX_USER_SERVERS ?? '{"node_repl":{"command":"node"}}');
const steps = env.FAKE_CODEX_SCENARIO ? readFileSync(env.FAKE_CODEX_SCENARIO, 'utf8').split('\n').filter((line) => line.trim() !== '') : [];

let at = 0;
let threadId = null;
let cwd = process.cwd();
let turn = null;
let turns = 0;
let nextRequest = 0;
let lastAnswer = null;
let wake = null;
let loginTimer;
const waiting = new Map();
const sleepers = [];
// A request an interrupt ended: codex records no reply for it.
const UNANSWERED = Symbol('unanswered');

const fill = (line) => line.replaceAll('$THREAD', threadId ?? '').replaceAll('$TURN', turn?.id ?? '').replaceAll('$CWD', cwd);
const sleep = (ms) => new Promise((resolve) => {
  const done = () => {
    clearTimeout(timer);
    wake = null;
    resolve();
  };
  const timer = setTimeout(done, ms);
  wake = done;
});

async function play(current) {
  while (at < steps.length) {
    const step = JSON.parse(fill(steps[at]));
    at += 1;
    if (step.fake === 'await-turn') break;
    if (current.interrupted || (step.when !== undefined && step.when !== lastAnswer)) continue;
    if (step.fake === 'sleep') await sleep(step.ms);
    else if (step.fake === 'write') writeFileSync(join(cwd, step.path), step.content);
    else if (step.fake === 'spawn-sleeper') {
      const child = spawn('sleep', ['600'], { stdio: 'ignore' });
      sleepers.push(child.pid);
      record({ sleeperPid: child.pid });
    } else if (step.fake === 'fail') {
      current.error = { message: step.message };
      current.failed = true;
    } else if (step.request !== undefined) {
      const id = nextRequest++;
      send({ id, method: step.request, params: step.params });
      const result = await new Promise((resolve) => waiting.set(id, resolve));
      if (result === UNANSWERED) {
        current.unanswered.push(id);
        continue;
      }
      record({ reply: { method: step.request, result } });
      notify('serverRequest/resolved', { threadId, requestId: id });
      lastAnswer = result?.decision ?? result?.action ?? null;
    } else if (step.method !== undefined) notify(step.method, step.params);
  }
  const status = current.interrupted ? 'interrupted' : current.failed ? 'failed' : 'completed';
  notify('turn/completed', { threadId, turn: { id: current.id, items: [], status, error: current.error ?? null } });
  for (const requestId of current.unanswered) notify('serverRequest/resolved', { threadId, requestId });
  if (turn === current) turn = null;
}

function startThread(id, method, params) {
  const config = params.config ?? {};
  for (const [key, value] of Object.entries(config)) {
    const name = /^mcp_servers\.([^.]+)\.enabled$/.exec(key)?.[1];
    // The real app-server stops at start when a server nobody defines is switched off by name.
    if (name !== undefined && value === false && !Object.hasOwn(userServers, name)) {
      process.stderr.write(`Error: MCP server ${name} is not defined\n`);
      process.exit(1);
    }
  }
  cwd = params.cwd ?? cwd;
  threadId = method === 'thread/resume' ? params.threadId : `thread-${process.pid}`;
  const sandbox = env.FAKE_CODEX_ECHO_SANDBOX === 'workspace-write' || params.sandbox === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' };
  reply(id, {
    thread: { id: threadId, cliVersion: VERSION, path: null }, model: params.model ?? 'gpt-6-luna',
    approvalPolicy: params.approvalPolicy ?? 'on-request', approvalsReviewer: params.approvalsReviewer ?? 'user', sandbox, reasoningEffort: 'medium',
  });
  const configured = Object.keys(config).flatMap((key) => /^mcp_servers\.([^.]+)\.(?:url|command)$/.exec(key)?.[1] ?? []);
  const user = Object.keys(userServers).filter((name) => config[`mcp_servers.${name}.enabled`] !== false);
  for (const name of [...new Set([...configured, ...user, ...(env.FAKE_CODEX_EXTRA_SERVER ? [env.FAKE_CODEX_EXTRA_SERVER] : [])])]) {
    notify('mcpServer/startupStatus/updated', { threadId, name, status: 'ready', error: null, failureReason: null });
  }
}

function startTurn(id) {
  turns += 1;
  turn = { id: `turn-${turns}`, interrupted: false, failed: false, error: null, unanswered: [] };
  const shown = { id: turn.id, items: [], status: 'inProgress', error: null };
  reply(id, { turn: shown });
  notify('turn/started', { threadId, turn: shown });
  void play(turn);
}

function interrupt(id) {
  reply(id, {});
  if (!turn) return;
  turn.interrupted = true;
  wake?.();
  for (const [requestId, resolve] of waiting) {
    waiting.delete(requestId);
    resolve(UNANSWERED);
  }
}

function login(id, params) {
  if (!ownHome) return refuse(id, 'fake-codex signs in only under CODEX_HOME');
  const outcome = env.FAKE_CODEX_LOGIN ?? 'ok';
  const finish = (loginId, saved) => {
    loginTimer = setTimeout(() => {
      if (outcome === 'hang') return;
      if (outcome === 'fail') return notify('account/login/completed', { loginId, success: false, error: 'Login was not completed.' });
      writeFileSync(authFile, JSON.stringify(saved));
      if (outcome === 'silent') return;
      notify('account/login/completed', { loginId, success: true, error: null });
      notify('account/updated', { authMode: saved.type, planType: saved.planType ?? null });
    }, 30);
  };
  const chatgpt = { type: 'chatgpt', email: env.FAKE_CODEX_EMAIL ?? 'new@example.com', planType: 'plus' };
  if (params.type === 'apiKey') {
    reply(id, { type: 'apiKey' });
    return finish(null, { type: 'apiKey' });
  }
  if (params.type === 'chatgpt') {
    reply(id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/oauth/authorize?state=FAKESTATE' });
    return finish('login-1', chatgpt);
  }
  if (params.type === 'chatgptDeviceCode') {
    reply(id, { type: 'chatgptDeviceCode', loginId: 'login-2', verificationUrl: 'https://auth.example.test/codex/device', userCode: 'ABCD-1234' });
    return finish('login-2', chatgpt);
  }
  return refuse(id, `unknown login type ${params.type}`);
}

function handle(id, method, params) {
  switch (method) {
    case 'initialize': return reply(id, { userAgent: `${params.clientInfo?.name}/${VERSION} (fake)`, codexHome: env.CODEX_HOME ?? join(homedir(), '.codex'), platformFamily: 'unix', platformOs: 'macos' });
    case 'account/read': return reply(id, { account: account(), requiresOpenaiAuth: true });
    case 'model/list': return reply(id, { data: MODELS, nextCursor: null });
    case 'skills/list': {
      const dir = params.cwds?.[0] ?? cwd;
      return reply(id, { data: [{ cwd: dir, skills: [{ name: 'probe-skill', description: 'A skill of the project', path: join(dir, '.agents/skills/probe-skill/SKILL.md'), scope: 'repo', enabled: true, pluginId: null }], errors: [] }] });
    }
    case 'config/read': return reply(id, { config: { mcp_servers: userServers }, origins: {}, layers: null });
    case 'thread/start':
    case 'thread/resume': return startThread(id, method, params);
    case 'turn/start': return startTurn(id);
    case 'turn/steer': return reply(id, { turnId: turn?.id ?? null });
    case 'turn/interrupt': return interrupt(id);
    case 'account/login/start': return login(id, params);
    case 'account/login/cancel':
      clearTimeout(loginTimer);
      reply(id, {});
      return notify('account/login/completed', { loginId: params.loginId ?? null, success: false, error: 'Login was cancelled.' });
    case 'account/logout':
      if (!ownHome) return refuse(id, 'fake-codex signs out only under CODEX_HOME');
      rmSync(authFile, { force: true });
      return reply(id, {});
    default: return send({ id, error: { code: -32601, message: `fake-codex does not answer ${method}` } });
  }
}

function shutdown() {
  for (const pid of sleepers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message.result ?? null);
    }
    return;
  }
  record({ in: { method: message.method, params: message.params ?? null } });
  if (message.id !== undefined) handle(message.id, message.method, message.params ?? {});
});
