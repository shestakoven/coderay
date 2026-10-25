#!/usr/bin/env node
// Stands in for `opencode serve` 1.19: answers CodeRay's routes and replays a scenario (test/fixtures/opencode/README.md).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const env = process.env;
const argv = process.argv.slice(2);
const VERSION = env.FAKE_OPENCODE_VERSION ?? '1.19.0';
if (argv[0] === '--version') { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (argv[0] !== 'serve') { process.stderr.write(`fake-opencode: unsupported arguments ${argv.join(' ')}\n`); process.exit(2); }

const XDG = { XDG_DATA_HOME: '.local/share', XDG_CONFIG_HOME: '.config', XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache' };
// A test that forgot its temp home must never read or write the owner's opencode.
for (const [name, real] of Object.entries(XDG)) {
  if (env[name] !== undefined && resolve(env[name]) === join(homedir(), real)) { process.stderr.write(`fake-opencode: ${name} is the real ~/${real}\n`); process.exit(2); }
}

// 1.19 started beside another server on the same home, while that one sets the database up: it exits before it listens.
if (env.FAKE_OPENCODE_DB_BUSY && env.FAKE_OPENCODE_RECORD) {
  const counter = `${env.FAKE_OPENCODE_RECORD}.busy`;
  const failed = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  if (failed < Number(env.FAKE_OPENCODE_DB_BUSY)) {
    writeFileSync(counter, String(failed + 1));
    // A home's first servers fail on its setup query, later ones on the lock.
    process.stderr.write(failed === 0 ? 'Error: Unexpected error\nFailed query: \nparams: \n' : 'Error: Unexpected error\n\ndatabase is locked\n');
    process.exit(1);
  }
}

const record = (entry) => { if (env.FAKE_OPENCODE_RECORD) appendFileSync(env.FAKE_OPENCODE_RECORD, `${JSON.stringify(entry)}\n`); };
record({
  pid: process.pid, argv, xdg: Object.fromEntries(Object.keys(XDG).map((name) => [name, env[name] ?? null])),
  credentials: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID'].filter((name) => env[name] !== undefined),
  env: ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_LSP_DOWNLOAD'].filter((name) => env[name] === '1'),
  opencodeVars: Object.keys(env).filter((name) => name.startsWith('OPENCODE_')).sort(),
  configContent: env.OPENCODE_CONFIG_CONTENT === undefined ? null : JSON.parse(env.OPENCODE_CONFIG_CONTENT),
  // A digest, so a test can tell two servers' passwords apart without the record holding one.
  passwordHash: env.OPENCODE_SERVER_PASSWORD === undefined ? null : createHash('sha256').update(env.OPENCODE_SERVER_PASSWORD).digest('hex'),
});
const inline = env.OPENCODE_CONFIG_CONTENT === undefined ? {} : JSON.parse(env.OPENCODE_CONFIG_CONTENT);
const configured = env.FAKE_OPENCODE_CONFIG ? JSON.parse(env.FAKE_OPENCODE_CONFIG) : {};
const expectedAuth = `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${env.OPENCODE_SERVER_PASSWORD ?? ''}`).toString('base64')}`;
const dataHome = env.XDG_DATA_HOME ?? join(process.cwd(), 'fake-data');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// opencode merges its config layers deeply; a key keeps the position it first had, which decides the rules' evaluation order.
const merge = (base, over) => {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
  return out;
};
const config = () => merge(configured, inline);
// GET /config echoes a permission map in 1.19's schema order, which is not the order the rules are evaluated in.
const SCHEMA_KEYS = ['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'external_directory', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'doom_loop', 'skill'];
const schemaOrder = (map) => (isObject(map) ? Object.fromEntries([...SCHEMA_KEYS.filter((key) => key in map).map((key) => [key, map[key]]), ...Object.entries(map).filter(([key]) => !SCHEMA_KEYS.includes(key))]) : map);
const configEcho = () => {
  const merged = config();
  const agent = isObject(merged.agent) ? Object.fromEntries(Object.entries(merged.agent).map(([name, entry]) => [name, isObject(entry) && 'permission' in entry ? { ...entry, permission: schemaOrder(entry.permission) } : entry])) : merged.agent;
  return { plugin: [], ...merged, ...(merged.permission === undefined ? {} : { permission: schemaOrder(merged.permission) }), ...(agent === undefined ? {} : { agent }) };
};

const rule = (permission, pattern, action) => ({ permission, pattern, action });
const rules = (value) => (typeof value === 'string' ? [rule('*', '*', value)] : Object.entries(isObject(value) ? value : {}).flatMap(([permission, entry]) => (typeof entry === 'string' ? [rule(permission, '*', entry)] : Object.entries(isObject(entry) ? entry : {}).map(([pattern, action]) => rule(permission, pattern, action)))));
const TOOL_OUTPUT = rule('external_directory', `${dataHome}/opencode/tool-output/*`, 'allow');
const DEFAULTS = [
  rule('*', '*', 'allow'), rule('doom_loop', '*', 'ask'), rule('external_directory', '*', 'ask'), TOOL_OUTPUT, rule('external_directory', `${tmpdir()}/opencode/*`, 'allow'),
  rule('question', '*', 'deny'), rule('plan_enter', '*', 'deny'), rule('plan_exit', '*', 'deny'),
  rule('read', '*', 'allow'), rule('read', '*.env', 'ask'), rule('read', '*.env.*', 'ask'), rule('read', '*.env.example', 'allow'), rule('question', '*', 'allow'), rule('plan_enter', '*', 'allow'),
];
const BUILT_IN = {
  build: { mode: 'primary', rules: [] },
  compaction: { mode: 'primary', hidden: true, rules: [] },
  explore: { mode: 'subagent', rules: [rule('*', '*', 'deny'), ...['grep', 'glob', 'list', 'bash', 'webfetch', 'websearch', 'read'].map((tool) => rule(tool, '*', 'allow'))] },
  general: { mode: 'subagent', rules: [rule('todowrite', '*', 'deny')] },
  plan: { mode: 'primary', rules: [rule('task', 'general', 'deny'), rule('edit', '*', 'deny'), rule('edit', '.opencode/plans/*.md', 'allow')] },
  summary: { mode: 'primary', hidden: true, rules: [] },
  title: { mode: 'primary', hidden: true, rules: [] },
};
let rulesFlipped = false;
// Each agent's rules as 1.19 evaluates them: defaults, the agent's defaults, the top-level map, the agent's map, then the tool-output glob it appends.
const agents = () => {
  if (env.FAKE_OPENCODE_AGENTS) return JSON.parse(env.FAKE_OPENCODE_AGENTS);
  const merged = config();
  const own = isObject(merged.agent) ? merged.agent : {};
  return [...new Set([...Object.keys(BUILT_IN), ...Object.keys(own)])].sort().filter((name) => own[name]?.disable !== true).map((name) => {
    const builtIn = BUILT_IN[name];
    const permission = [...DEFAULTS, ...(builtIn?.rules ?? []), ...rules(merged.permission), ...rules(own[name]?.permission), TOOL_OUTPUT, ...(rulesFlipped && name === 'build' ? [rule('edit', '*', 'allow')] : [])];
    return { name, description: own[name]?.description ?? `The ${name} agent.`, mode: own[name]?.mode ?? builtIn?.mode ?? 'all', native: builtIn !== undefined, hidden: builtIn?.hidden ?? null, permission, options: {} };
  });
};

const TOOL_IDS = ['invalid', 'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'webfetch', 'todowrite', 'websearch', 'skill', 'apply_patch'];
const authFile = join(dataHome, 'opencode', 'auth.json');
const auth = new Map(existsSync(authFile) ? Object.entries(JSON.parse(readFileSync(authFile, 'utf8'))) : []);
const saveAuth = () => { mkdirSync(dirname(authFile), { recursive: true }); writeFileSync(authFile, JSON.stringify(Object.fromEntries(auth))); };
// /config/providers shows the providers the instance loaded: a key set later shows after /instance/dispose (Q1).
let loaded = [...auth.keys()];
const FREE = { input: 0, output: 0, cache: { read: 0, write: 0 } };
const baseProviders = env.FAKE_OPENCODE_PROVIDERS ? JSON.parse(env.FAKE_OPENCODE_PROVIDERS) : { providers: [{ id: 'opencode', name: 'OpenCode Zen', env: ['OPENCODE_API_KEY'], models: {
  'nemotron-3.5-lightning-free': { id: 'nemotron-3.5-lightning-free', providerID: 'opencode', name: 'Nemotron 3.5 Lightning (free)', limit: { context: 262144, output: 32768 }, variants: {}, cost: FREE },
  'gpt-oss-120b-free': { id: 'gpt-oss-120b-free', providerID: 'opencode', name: 'GPT OSS 120B (free)', limit: { context: 131072, output: 32768 }, variants: { low: {}, high: {} }, cost: FREE },
} }], default: { opencode: 'nemotron-3.5-lightning-free' } };
const KNOWN = { openai: 'OpenAI', anthropic: 'Anthropic' };
// A key of a provider the catalog does not know loads nothing.
const providers = () => ({ ...baseProviders, providers: [...baseProviders.providers, ...loaded.filter((id) => Object.hasOwn(KNOWN, id) && !baseProviders.providers.some((p) => p.id === id)).map((id) => ({ id, name: KNOWN[id], env: [], models: { stub: { id: 'stub', providerID: id, name: 'Stub', limit: { context: 8192, output: 1024 }, variants: {} } } }))] });
const commands = [{ name: 'probe-skill', description: 'A skill of the user', source: 'skill', template: 'Probe.', hints: [] }];

const steps = env.FAKE_OPENCODE_SCENARIO ? readFileSync(env.FAKE_OPENCODE_SCENARIO, 'utf8').split('\n').filter((line) => line.trim() !== '') : [];
const progress = env.FAKE_OPENCODE_RECORD ? `${env.FAKE_OPENCODE_RECORD}.at` : null;
let at = progress !== null && existsSync(progress) ? Number(readFileSync(progress, 'utf8')) : 0;
const reached = () => { if (progress !== null) writeFileSync(progress, String(at)); };
const skipTurn = () => { while (at < steps.length) { const line = JSON.parse(steps[at]); at += 1; reached(); if (line.fake === 'await-turn') break; } };

// Sessions outlive a server (opencode.db): kept beside the record, so a restarted fake still answers GET /session/:id.
const sessionFile = env.FAKE_OPENCODE_RECORD ? `${env.FAKE_OPENCODE_RECORD}.sessions.json` : null;
const sessions = new Map(sessionFile !== null && existsSync(sessionFile) ? Object.entries(JSON.parse(readFileSync(sessionFile, 'utf8'))) : []);
const saveSessions = () => { if (sessionFile !== null) writeFileSync(sessionFile, JSON.stringify(Object.fromEntries([...sessions].map(([id, s]) => [id, { id: s.id, parentID: s.parentID, directory: s.directory, permission: s.permission ?? null }])))); };
const info = (s) => ({ id: s.id, slug: 'fake-session', version: VERSION, projectID: 'global', directory: s.directory, ...(s.parentID ? { parentID: s.parentID } : {}), title: 'New session', permission: s.permission ?? [], time: { created: 1, updated: 1 } });

const streams = new Set();
let eventHoldMs = 0;
const waiting = new Map();   // permission or question id → { kind, session, asked?, resolve }
const sleepers = [];
let ids = 0; let prompts = 0;
const nextId = (prefix) => `${prefix}_${process.pid}_${String(++ids).padStart(4, '0')}`;
const send = (type, properties) => { const frame = `data: ${JSON.stringify({ type, properties })}\n\n`; for (const res of streams) res.write(frame); };
const killSleepers = () => { for (const child of sleepers.splice(0)) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const ABORTED = Symbol('aborted');
const REJECTED = 'The user rejected permission to use this specific tool call';
const ASKED_FIRST = new Set(['task', 'webfetch', 'external_directory']);

// A reject rejects every other pending ask of that session, as 1.19 does.
function rejectOthers(sessionID, except) {
  for (const [id, w] of waiting) {
    if (id === except || w.kind !== 'permission' || w.session !== sessionID) continue;
    waiting.delete(id);
    record({ reply: { id, reply: 'reject', message: null, cascaded: true } });
    send('permission.replied', { sessionID, requestID: id, reply: 'reject' });
    w.resolve({ reply: 'reject', message: null });
  }
}

async function play(session, messageID) {
  const fill = (line) => line.replaceAll('$SESSION', session.id).replaceAll('$MESSAGE', messageID).replaceAll('$CWD', session.directory).replaceAll('$PASSWORD', env.OPENCODE_SERVER_PASSWORD ?? '');
  let abort;
  const aborted = new Promise((resolve) => { abort = () => resolve(ABORTED); });
  Object.assign(session, { busy: true, aborted: false, abort });
  send('session.status', { sessionID: session.id, status: { type: 'busy' } });
  const running = new Map();   // callID → its tool part while it runs
  const finishers = [];
  const parallel = [];
  let partSeq = 0; let ended = false; let closed = false; let over = false;
  const part = (p) => {
    send('message.part.updated', { sessionID: p.sessionID, part: p, time: Date.now() });
    if (p.type === 'tool' && p.callID) { if (p.state?.status === 'pending' || p.state?.status === 'running') running.set(p.callID, p); else running.delete(p.callID); }
  };
  const toolPart = (sessionID, tool, callID, state) => ({ id: `prt_${callID}`, sessionID, messageID, type: 'tool', tool, callID, state });
  const start = (sessionID, tool, callID, input) => {
    if (running.has(callID)) return;
    part(toolPart(sessionID, tool, callID, { status: 'pending', input: {}, raw: '' }));
    part(toolPart(sessionID, tool, callID, { status: 'running', input, time: { start: Date.now() } }));
  };
  const wait = (promise) => Promise.race([promise, aborted]);

  // The session an ask or a question comes from: the chat's, a child (an unannounced one is a task resumed by task_id, created on an
  // earlier server), or another named one: another client's root session, which GET /session/:id answers.
  const sessionFor = (kind) => {
    if (!kind) return session.id;
    if (kind !== 'child' && kind !== 'unannounced') {
      if (!sessions.has(kind)) { sessions.set(kind, { id: kind, parentID: null, directory: session.directory, permission: null }); saveSessions(); }
      return kind;
    }
    const child = { id: nextId('ses'), parentID: session.id, directory: session.directory, permission: [rule('task', '*', 'deny')] };
    sessions.set(child.id, child); saveSessions();
    if (kind === 'child') send('session.created', { sessionID: child.id, info: info(child) });
    return child.id;
  };

  async function ask(line) {
    const sessionID = sessionFor(line.session);
    const tool = line.tool ?? line.ask;
    const input = line.input ?? {};
    // 1.19 asks about these before it reports the call running, and may for a bash call.
    const late = (line.running ?? (ASKED_FIRST.has(line.ask) ? 'after' : 'before')) === 'after';
    if (late) part(toolPart(sessionID, tool, line.callID, { status: 'pending', input: {}, raw: '' }));
    else start(sessionID, tool, line.callID, input);
    const id = nextId('per');
    const always = line.always ?? (line.ask === 'bash' ? (line.patterns ?? []).map((pattern) => `${pattern.split(' ')[0]} *`) : ['*']);
    const asked = { id, sessionID, permission: line.ask, patterns: line.patterns ?? [], metadata: line.metadata ?? {}, always, tool: { messageID, callID: line.callID } };
    const reply = new Promise((resolve) => { waiting.set(id, { kind: 'permission', session: sessionID, asked, resolve }); });
    send('permission.asked', asked);
    // Running 50 ms after the ask, or before its answer's part when that comes first.
    let ran = !late;
    const run = () => { if (!ran) { ran = true; part(toolPart(sessionID, tool, line.callID, { status: 'running', input, time: { start: Date.now() } })); } };
    if (late) setTimeout(run, 50);
    // Another client with the server's password answers the ask (the model curling the server, say).
    if (line.answeredBy) setImmediate(() => { const w = waiting.get(id); if (!w) return; waiting.delete(id); send('permission.replied', { sessionID, requestID: id, reply: line.answeredBy }); w.resolve({ reply: line.answeredBy, message: null }); });
    const settle = (answer) => {
      // An ask answered after its turn ended (Q12-abort-leaves) changes nothing in the turn.
      if (over) return;
      run();
      if (answer.reply === 'reject') {
        part(toolPart(sessionID, tool, line.callID, { status: 'error', input, error: answer.message ? `${REJECTED} with the following feedback: ${answer.message}` : `${REJECTED}.`, time: { start: 1, end: 2 } }));
        // A reject with feedback lets the model go on; a plain one ends the turn.
        if (!answer.message) ended = true;
        return;
      }
      if (line.before) return;
      for (const file of [line.apply ?? []].flat()) { mkdirSync(dirname(join(session.directory, file.path)), { recursive: true }); writeFileSync(join(session.directory, file.path), file.content); }
      const done = () => part(toolPart(sessionID, tool, line.callID, { status: 'completed', input, output: line.output ?? 'ok', title: tool, metadata: line.metadata ?? {}, time: { start: 1, end: 2 } }));
      // A subagent's task ends when the subagent does: with the turn.
      if (tool === 'task') finishers.push(done); else done();
    };
    if (line.parallel) { parallel.push(reply.then(settle)); return; }
    const answer = await wait(reply);
    if (answer !== ABORTED) settle(answer);
  }

  async function question(line) {
    const callID = line.question.callID ?? 'q1';
    const questions = [{ question: line.question.text, header: line.question.header ?? 'Question', options: line.question.options.map((label) => ({ label, description: '' })), multiple: false }];
    const sessionID = sessionFor(line.question.session);
    start(sessionID, 'question', callID, { questions });
    const id = nextId('que');
    const reply = new Promise((resolve) => { waiting.set(id, { kind: 'question', session: sessionID, resolve }); });
    send('question.asked', { id, sessionID, questions, tool: { messageID, callID } });
    const answer = await wait(reply);
    if (answer === ABORTED) return;
    if (answer.kind === 'reject') {
      part(toolPart(sessionID, 'question', callID, { status: 'error', input: { questions }, error: 'The user dismissed this question', time: { start: 1, end: 2 } }));
      ended = true;
      return;
    }
    const chosen = questions.map((q, index) => `"${q.question}"="${[answer.answers?.[index] ?? []].flat().join(', ') || 'Unanswered'}"`).join(', ');
    part(toolPart(sessionID, 'question', callID, { status: 'completed', input: { questions }, output: `User has answered your questions: ${chosen}. You can now continue with the user's answers in mind.`, title: 'question', metadata: {}, time: { start: 1, end: 2 } }));
  }

  while (at < steps.length && !session.aborted && !ended) {
    const line = JSON.parse(fill(steps[at])); at += 1; reached();
    if (line.fake === 'await-turn') { closed = true; break; }
    if (line.fake === 'sleep') { await new Promise((done) => { const timer = setTimeout(done, line.ms); void aborted.then(() => { clearTimeout(timer); done(); }); }); continue; }
    if (line.fake === 'write') { mkdirSync(dirname(join(session.directory, line.path)), { recursive: true }); writeFileSync(join(session.directory, line.path), line.content); continue; }
    // The event stream drops: what is sent until the client opens it again is lost to it.
    if (line.fake === 'close-stream') { for (const res of streams) res.end(); streams.clear(); eventHoldMs = line.holdMs ?? 0; continue; }
    if (line.fake === 'spawn-sleeper') { const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' }); child.unref(); sleepers.push(child); record({ sleeperPid: child.pid }); continue; }
    if (line.fake === 'error') { send('session.error', { ...(line.session === false ? {} : { sessionID: session.id }), error: { name: 'UnknownError', data: { message: line.message } } }); continue; }
    if (line.ask) { await ask(line); continue; }
    if (line.question) { await question(line); continue; }
    if (line.type === 'message.part.updated' && line.properties?.part) { part(line.properties.part.id ? line.properties.part : { ...line.properties.part, id: `prt_${partSeq++}` }); continue; }
    if (line.type) send(line.type, line.properties);
  }
  await wait(Promise.all(parallel));
  if (session.aborted) {
    // As 1.19: the message is aborted, every running tool ends with an error, and held asks stay pending (Q12-abort-leaves).
    send('session.error', { sessionID: session.id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
    for (const p of running.values()) part({ ...p, state: { status: 'error', input: p.state.input, error: 'Tool execution aborted', time: { start: 1, end: 2 } } });
  } else {
    for (const finish of finishers) finish();
  }
  if ((session.aborted || ended) && !closed) skipTurn();
  over = true;
  session.busy = false;
  session.abort = null;
  for (const answer of session.answers.splice(0)) answer();
  send('session.status', { sessionID: session.id, status: { type: 'idle' } });
  send('session.idle', { sessionID: session.id });
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += String(chunk);
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { return json(res, 400, { name: 'BadRequest', data: { message: 'Malformed JSON in request body' } }); }
  const url = new URL(req.url ?? '/', 'http://x');
  const header = req.headers['x-opencode-directory'];
  const directory = url.searchParams.get('directory') ?? (typeof header === 'string' ? header : null);
  const path = url.pathname;
  record({ req: { method: req.method, path, body: body ?? null, directory } });
  if (req.headers.authorization !== expectedAuth) return json(res, 401, { error: 'unauthorized' });
  const m = (re) => re.exec(path);
  if (path === '/global/health') return env.FAKE_OPENCODE_HEALTH === 'down' ? json(res, 503, { healthy: false }) : json(res, 200, { healthy: env.FAKE_OPENCODE_HEALTH !== 'unhealthy', version: VERSION });
  if (path === '/global/dispose') { if (env.FAKE_OPENCODE_DISPOSE === 'hang') return; killSleepers(); return json(res, 200, true); }
  if (path === '/instance/dispose') { loaded = [...auth.keys()]; return json(res, 200, true); }
  if (path === '/agent') return json(res, 200, agents());
  if (path === '/config' && req.method === 'GET') return json(res, 200, configEcho());
  if (path === '/config/providers') return json(res, 200, providers());
  if (path === '/provider') return json(res, 200, { all: [{ id: 'opencode', name: 'OpenCode Zen', env: ['OPENCODE_API_KEY'] }, { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] }, { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'] }], default: baseProviders.default, connected: ['opencode', ...auth.keys()] });
  if (path === '/provider/auth') return json(res, 200, { openai: [{ type: 'api', label: 'API key' }], anthropic: [{ type: 'oauth', label: 'Claude Pro/Max' }, { type: 'oauth', label: 'Create an API Key' }, { type: 'api', label: 'Manually enter API Key' }] });
  let a;
  if ((a = m(/^\/auth\/([^/]+)$/))) {
    // A validation error that quotes the body back, key and all.
    if (req.method === 'PUT' && env.FAKE_OPENCODE_AUTH === 'fail') return json(res, 400, { name: 'BadRequest', data: { message: `Invalid auth ${raw}` } });
    if (req.method === 'PUT') { auth.set(a[1], body); saveAuth(); return json(res, 200, true); }
    if (req.method === 'DELETE') { auth.delete(a[1]); saveAuth(); return json(res, 200, true); }
  }
  if (path === '/command') return json(res, 200, commands);
  if (path === '/experimental/tool/ids') {
    const answer = () => json(res, 200, env.FAKE_OPENCODE_TOOL_IDS ? JSON.parse(env.FAKE_OPENCODE_TOOL_IDS) : TOOL_IDS);
    return env.FAKE_OPENCODE_TOOL_IDS_HOLD_MS ? void setTimeout(answer, Number(env.FAKE_OPENCODE_TOOL_IDS_HOLD_MS)) : answer();
  }
  if (path === '/permission' && req.method === 'GET') return json(res, 200, [...waiting.values()].filter((w) => w.kind === 'permission').map((w) => w.asked));
  if (path === '/session' && req.method === 'POST') {
    if (env.FAKE_OPENCODE_SESSION_FAIL === '1') return json(res, 500, { name: 'UnknownError', data: { message: 'the database is read-only' } });
    const s = { id: nextId('ses'), parentID: null, directory: directory ?? process.cwd(), permission: body?.permission ?? null, answers: [] };
    sessions.set(s.id, s); saveSessions();
    record({ session: { id: s.id, permission: s.permission } });
    send('session.created', { sessionID: s.id, info: info(s) });
    // The event can come before the answer, as from a busy 1.19.
    setTimeout(() => json(res, 200, info(s)), 20);
    return;
  }
  let s;
  if ((s = m(/^\/session\/([^/]+)$/))) {
    if (req.method === 'DELETE') { sessions.delete(s[1]); saveSessions(); send('session.deleted', { sessionID: s[1], info: { id: s[1] } }); return json(res, 200, true); }
    if (s[1] === env.FAKE_OPENCODE_GONE || !sessions.has(s[1])) return json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${s[1]}` } });
    return json(res, 200, info(sessions.get(s[1])));
  }
  if ((s = m(/^\/session\/([^/]+)\/(prompt_async|command)$/))) {
    const session = sessions.get(s[1]);
    if (!session) return json(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${s[1]}` } });
    session.answers ??= [];
    // 1.19 takes the model of a command as "provider/model" only.
    if (s[2] === 'command' && body?.model !== undefined && body.model !== null && typeof body.model !== 'string') return json(res, 400, { name: 'BadRequest', data: { message: `Expected string | null, got ${JSON.stringify(body.model)}\n  at ["model"]`, kind: 'Payload' } });
    const messageID = nextId('msg');
    prompts += 1;
    record({ prompt: { session: session.id, kind: s[2], body: body ?? null } });
    if (env.FAKE_OPENCODE_RULES_FLIP === '1' && prompts === 1) rulesFlipped = true;
    if (env.FAKE_OPENCODE_REPLIED && prompts === 1) send('permission.replied', { sessionID: session.id, requestID: 'per_nobody', reply: env.FAKE_OPENCODE_REPLIED === 'reject' ? 'reject' : 'once' });
    const answer = () => json(res, 200, { info: { id: messageID, sessionID: session.id, role: 'assistant', finish: 'stop' }, parts: [] });
    if (env.FAKE_OPENCODE_UNKNOWN_MODEL === '1') {
      if (s[2] === 'prompt_async') json(res, 204); else answer();
      const model = typeof body?.model === 'string' ? body.model : `${body?.model?.providerID}/${body?.model?.modelID}`;
      // Every turn of 1.19 says busy before it reads the model.
      send('session.status', { sessionID: session.id, status: { type: 'busy' } });
      send('session.error', { sessionID: session.id, error: { name: 'UnknownError', data: { message: `Model not found: ${model}. Did you mean: nemotron-3.5-lightning-free?` } } });
      send('session.idle', { sessionID: session.id });
      return;
    }
    if (env.FAKE_OPENCODE_PROMPT_FAIL === '1') return json(res, 400, { name: 'BadRequest', data: { message: 'Expected a part at ["parts",0]', kind: 'Payload' } });
    // prompt_async answers at once; /command answers when the turn ends (Q10). A prompt on a busy session joins the running turn (Q12b).
    if (s[2] === 'prompt_async') json(res, 204); else session.answers.push(answer);
    if (!session.busy) session.turn = play(session, messageID);
    return;
  }
  if ((s = m(/^\/session\/([^/]+)\/abort$/))) {
    // A server that takes the abort and goes on: no idle comes.
    if (env.FAKE_OPENCODE_ABORT === 'ignore') return json(res, 200, true);
    const session = sessions.get(s[1]);
    if (session?.busy) {
      session.aborted = true;
      killSleepers();
      session.abort?.();
      await session.turn;
    }
    return json(res, 200, true);
  }
  let p;
  if ((p = m(/^\/permission\/([^/]+)\/reply$/))) {
    const w = waiting.get(p[1]);
    if (!w || w.kind !== 'permission') return json(res, 404, { name: 'NotFoundError', data: { message: `Permission not found: ${p[1]}` } });
    if (!['once', 'always', 'reject'].includes(body?.reply)) return json(res, 400, { name: 'BadRequest', data: { message: 'Expected "once" | "always" | "reject" at ["reply"]', kind: 'Payload' } });
    waiting.delete(p[1]);
    record({ reply: { id: p[1], reply: body.reply, message: body.message ?? null } });
    send('permission.replied', { sessionID: w.session, requestID: p[1], reply: body.reply });
    if (body.reply === 'reject') rejectOthers(w.session, p[1]);
    w.resolve({ reply: body.reply, message: body.message ?? null });
    return json(res, 200, true);
  }
  let q;
  if ((q = m(/^\/question\/([^/]+)\/(reply|reject)$/))) {
    const w = waiting.get(q[1]);
    if (!w || w.kind !== 'question') return json(res, 404, { name: 'NotFoundError', data: { message: `Question not found: ${q[1]}` } });
    waiting.delete(q[1]);
    record({ questionReply: { id: q[1], kind: q[2], answers: body?.answers ?? null } });
    if (q[2] === 'reply') send('question.replied', { sessionID: w.session, requestID: q[1], answers: body?.answers ?? [] });
    else send('question.rejected', { sessionID: w.session, requestID: q[1] });
    w.resolve({ kind: q[2], answers: body?.answers ?? null });
    return json(res, 200, true);
  }
  if (path === '/event' || path === '/global/event') {
    const subscribe = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
    };
    // A slow reconnect: what is sent before the stream opens is lost to it.
    const hold = eventHoldMs;
    eventHoldMs = 0;
    if (hold > 0) setTimeout(subscribe, hold); else subscribe();
    return;
  }
  json(res, 404, { error: `fake-opencode: no route ${req.method} ${path}` });
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  if (env.FAKE_OPENCODE_NO_LISTEN !== '1') (env.FAKE_OPENCODE_LISTEN_STREAM === 'stderr' ? process.stderr : process.stdout).write(`opencode server listening on http://127.0.0.1:${port}\n`);
});
// SIGTERM alone leaves the sleepers, as the real server does; dispose and abort kill them.
process.on('SIGTERM', () => process.exit(0));
