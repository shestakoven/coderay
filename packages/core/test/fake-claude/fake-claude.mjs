#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";
const INTERRUPTED = '[Request interrupted by user for tool use]';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const sessionId = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
const readJson = (path) => (path ? JSON.parse(readFileSync(path, 'utf8')) : null);
const settings = readJson(flag('--settings'));
const mcpConfig = readJson(flag('--mcp-config'));
const record = (entry) => {
  if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify(entry)}\n`);
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event).replaceAll('$SESSION', sessionId)}\n`);
const interruptAnswer = (requestId) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } });
if (!argv.includes('-p') && process.stdin.isTTY) await import('./fake-claude-tui.mjs');
const steps = readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8')
  .replaceAll('$CWD', process.cwd())
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const inbox = [];
const answers = [];
const openToolUses = new Set();
const foregroundTasks = new Map();
const backgroundAgents = new Map();
const backgroundShells = new Map();
let pendingRequest = null;
let running = null;
let keepRunning = false;
let interrupt = null;
let inTurn = false;
let lastAnswer = 'allow';
let ignoringSigterm = false;
let reapHooked = false;
let wake = () => {};

record({ argv, pid: process.pid, claudecode: process.env.CLAUDECODE ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, hookNames: Object.keys(settings?.hooks ?? {}).sort() });

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line);
    record({ stdin: message });
    if (message.type === 'user') inbox.push(message);
    else if (message.type === 'control_response') answers.push(message);
    else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      if (inTurn) {
        interrupt = message.request_id;
        running?.kill();
      } else {
        killAgents();
        emit(interruptAnswer(message.request_id));
      }
    } else if (message.type === 'control_request') {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } });
    }
    wake();
  })
  .on('close', async () => {
    if (keepRunning) return;
    await reapShells();
    process.exit(0);
  });

// Real claude does not orphan its background tasks; interrupts never call this (c6, c7).
async function reapShells() {
  const live = [...backgroundShells.values()].filter((shell) => !shell.exited);
  const signalGroups = (signal) => {
    for (const shell of live) {
      try {
        process.kill(-shell.pid, signal);
      } catch {}
    }
  };
  signalGroups('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 300);
    const check = setInterval(() => {
      if (live.every((shell) => shell.exited)) {
        clearTimeout(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => clearInterval(check), 400).unref();
  });
  signalGroups('SIGKILL');
}

function waitUntil(ready, ms) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      wake = () => {};
      clearTimeout(timer);
      resolve();
    };
    if (ms !== undefined) timer = setTimeout(finish, ms);
    wake = () => {
      if (ready()) finish();
    };
    wake();
  });
}

function track(event) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === 'assistant' && !event.parent_tool_use_id) {
    for (const block of blocks) if (block.type === 'tool_use') openToolUses.add(block.id);
  }
  if (event.type === 'user') {
    for (const block of blocks) if (block.type === 'tool_result') openToolUses.delete(block.tool_use_id);
  }
  if (event.type === 'system' && event.subtype === 'task_started' && event.is_backgrounded === false) foregroundTasks.set(event.task_id, event);
  if (event.type === 'system' && event.subtype === 'task_started' && event.is_backgrounded !== false && event.task_type === 'local_agent') {
    backgroundAgents.set(event.task_id, event);
  }
  if (event.type === 'system' && (event.subtype === 'task_updated' || event.subtype === 'task_notification')) backgroundAgents.delete(event.task_id);
  if (event.type === 'control_request') pendingRequest = event.request_id;
}

function killAgents() {
  for (const task of backgroundAgents.values()) {
    emit({ type: 'system', subtype: 'task_updated', task_id: task.task_id, patch: { status: 'killed' }, session_id: sessionId });
    emit({ type: 'system', subtype: 'task_notification', task_id: task.task_id, tool_use_id: task.tool_use_id, status: 'stopped', summary: task.description, session_id: sessionId });
  }
  backgroundAgents.clear();
}

function abortTurn(from) {
  killAgents();
  if (pendingRequest !== null) emit({ type: 'control_cancel_request', request_id: pendingRequest });
  pendingRequest = null;
  emit(interruptAnswer(interrupt));
  interrupt = null;
  for (const task of foregroundTasks.values()) {
    emit({ type: 'system', subtype: 'task_notification', task_id: task.task_id, tool_use_id: task.tool_use_id, status: 'stopped', output_file: '', summary: task.description, session_id: sessionId });
  }
  foregroundTasks.clear();
  for (const id of openToolUses) {
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: REJECTED }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  if (openToolUses.size > 0) emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: INTERRUPTED }] }, parent_tool_use_id: null, session_id: sessionId });
  openToolUses.clear();
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], session_id: sessionId });
  inTurn = false;
  const next = steps.findIndex((step, index) => index >= from && step.fake === 'await-user');
  return next === -1 ? steps.length : next;
}

function finishTool(id, content, isError, parent = null) {
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: parent, session_id: sessionId };
  emit(result);
  track(result);
}

function startTool(id, name, input, parent = null) {
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent, session_id: sessionId };
  emit(use);
  track(use);
}

function runHook(hook, payload) {
  return new Promise((resolve) => {
    const child = spawn(hook.command, hook.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    running = { kill: () => child.kill('SIGTERM') };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      running = null;
      // Exit 2 blocks with stderr as the reason; JSON is read only on exit 0; exit 1 or output that is not a decision lets the call run (spike 1e, c15, c17, v1, v2).
      if (code === 2) return resolve({ allowed: false, reason: stderr.trim(), exit: 2 });
      let output = null;
      try {
        output = code === 0 ? JSON.parse(stdout).hookSpecificOutput : null;
      } catch {
        output = null;
      }
      if (output?.permissionDecision === 'deny') return resolve({ allowed: false, reason: output.permissionDecisionReason ?? '', exit: code });
      resolve({ allowed: true, reason: output?.permissionDecisionReason ?? '', exit: code });
    });
    child.stdin.end(payload);
  });
}

async function runHooks(name, input, id, cwd = process.cwd()) {
  const hooks = (settings?.hooks?.PreToolUse ?? [])
    .filter((entry) => entry.matcher === '*' || new RegExp(`^(?:${entry.matcher})$`).test(name))
    .flatMap((entry) => entry.hooks ?? []);
  const payload = JSON.stringify({
    session_id: sessionId, transcript_path: '', cwd, prompt_id: '', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id,
  });
  for (const hook of hooks) {
    const verdict = await runHook(hook, payload);
    if (!verdict.allowed || interrupt !== null) return verdict;
  }
  return { allowed: true, reason: '', exit: 0 };
}

function perform(step, cwd = process.cwd()) {
  const input = step.input;
  if (step.name === 'Write') writeFileSync(input.file_path, input.content);
  else if (step.name === 'Edit') writeFileSync(input.file_path, readFileSync(input.file_path, 'utf8').replace(input.old_string, () => input.new_string));
  else if (step.name === 'Bash') execFileSync('/bin/sh', ['-c', input.command], { cwd, stdio: 'ignore' });
}

function spawnBackground(step, cwd = process.cwd()) {
  const child = spawn('/bin/sh', ['-c', step.input.command], { cwd, detached: true, stdio: 'ignore' });
  const shell = { taskId: `task_bg_${step.id}`, pid: child.pid, exited: false, onExit: [] };
  child.on('exit', () => {
    shell.exited = true;
    for (const fire of shell.onExit) fire();
  });
  child.unref();
  backgroundShells.set(step.id, shell);
  if (!reapHooked) {
    reapHooked = true;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, async () => {
        await reapShells();
        if (!ignoringSigterm) process.exit(signal === 'SIGTERM' ? 143 : 130);
      });
    }
  }
  record({ background: { id: step.id, pid: child.pid } });
  emit({ type: 'system', subtype: 'task_started', task_id: shell.taskId, tool_use_id: step.id, description: step.input.description ?? step.input.command, is_backgrounded: true, task_type: 'local_bash', session_id: sessionId });
}

function endShellTask(step) {
  const shell = backgroundShells.get(step.after ?? step.toolUseId);
  const taskId = shell?.taskId ?? `task_bg_${step.toolUseId}`;
  const status = step.status ?? 'completed';
  const fire = () => {
    emit({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status }, session_id: sessionId });
    emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: step.toolUseId, status, output_file: '', summary: '', session_id: sessionId });
  };
  if (!shell || shell.exited) fire();
  else shell.onExit.push(fire);
}

async function runTool(step) {
  const parent = step.parent ?? null;
  const cwd = step.cwd ? join(process.cwd(), step.cwd) : process.cwd();
  // "streamed": false stands for a tool_use still in claude's output buffer when its hook runs.
  if (step.streamed !== false) startTool(step.id, step.name, step.input, parent);
  let verdict = { allowed: true, reason: '', exit: 0 };
  if (!step.skipHook) {
    verdict = await runHooks(step.name, step.input, step.id, cwd);
    record({ hook: { id: step.id, tool: step.name, ...verdict } });
  }
  if (interrupt !== null) return;
  if (!verdict.allowed) return finishTool(step.id, `PreToolUse:${step.name} hook error: ${verdict.reason}`, true, parent);
  if (step.background && step.name === 'Bash') spawnBackground(step, cwd);
  else if (step.apply) perform(step, cwd);
  finishTool(step.id, step.result ?? 'ok', false, parent);
}

async function runMcpWrite(step) {
  const parent = step.parent ?? null;
  const name = `mcp__${step.server}__${step.tool}`;
  const input = { files: step.files.map((file) => file.path) };
  startTool(step.id, name, input, parent);
  let verdict = { allowed: true, reason: '', exit: 0 };
  if (!step.skipHook) {
    verdict = await runHooks(name, input, step.id);
    record({ hook: { id: step.id, tool: name, ...verdict } });
  }
  if (interrupt !== null) return;
  if (!verdict.allowed) return finishTool(step.id, `PreToolUse:${name} hook error: ${verdict.reason}`, true, parent);
  // "awaitStart": the writes wait until the test creates the file named by FAKE_CLAUDE_START, so the core has seen the tool_use before any file changes.
  while (step.awaitStart && !existsSync(process.env.FAKE_CLAUDE_START) && interrupt === null) await new Promise((resolve) => setTimeout(resolve, 20));
  if (interrupt !== null) return;
  const honorCancel = step.honorCancel !== false;
  const written = [];
  let done = false;
  const writeAll = async () => {
    for (const [at, file] of step.files.entries()) {
      if (honorCancel && interrupt !== null) break;
      const abs = join(process.cwd(), file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content);
      written.push(file.path);
      if (step.perFileMs && at < step.files.length - 1) {
        if (honorCancel) await waitUntil(() => interrupt !== null, step.perFileMs);
        else await new Promise((resolve) => setTimeout(resolve, step.perFileMs));
      }
    }
    done = true;
    record({ mcpWrite: { id: step.id, tool: name, written } });
    wake();
  };
  const writing = writeAll();
  if (honorCancel) await writing;
  else await waitUntil(() => done || interrupt !== null);
  if (interrupt !== null) return;
  // "awaitRelease": the tool result waits until the test creates the file named by FAKE_CLAUDE_RELEASE, so the test decides when the writes have been seen.
  while (step.awaitRelease && !existsSync(process.env.FAKE_CLAUDE_RELEASE) && interrupt === null) await new Promise((resolve) => setTimeout(resolve, 20));
  if (interrupt !== null) return;
  finishTool(step.id, 'ok', false, parent);
}

// One connection for the whole process, as the CLI keeps: closing it right after an abort would drop the notifications/cancelled the abort sends (c19).
let idecore = null;
async function idecoreClient() {
  if (idecore) return idecore;
  const server = mcpConfig?.mcpServers?.idecore;
  const client = new Client({ name: 'fake-claude', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
  idecore = client;
  return client;
}

async function callIdecore(step) {
  const name = `mcp__idecore__${step.tool}`;
  startTool(step.id, name, step.input);
  const verdict = await runHooks(name, step.input, step.id);
  if (interrupt !== null) return;
  if (!verdict.allowed) return finishTool(step.id, `PreToolUse:${name} hook error: ${verdict.reason}`, true);
  const controller = new AbortController();
  running = { kill: () => controller.abort() };
  let text = '';
  let isError = false;
  try {
    const client = await idecoreClient();
    const timeout = mcpConfig?.mcpServers?.idecore?.timeout ?? 60_000;
    const result = await client.callTool({ name: step.tool, arguments: step.input }, undefined, { signal: controller.signal, timeout });
    text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
    isError = result.isError === true;
  } catch (error) {
    text = String(error?.message ?? error);
    isError = true;
  } finally {
    running = null;
  }
  record({ mcp: { id: step.id, tool: step.tool, text, isError } });
  if (interrupt !== null) return;
  finishTool(step.id, text, isError);
}

async function runSessionStartHooks() {
  if (process.env.FAKE_CLAUDE_HOOKS === 'off') return;
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId });
  for (const entry of settings?.hooks?.SessionStart ?? []) {
    for (const hook of entry.hooks ?? []) await runHook(hook, payload);
  }
}

// The headless check of the hooks (the only run with --no-session-persistence) can start slowly, to leave time to act while CodeRay waits for it.
if (process.env.FAKE_CLAUDE_PROBE_STARTUP_MS && argv.includes('--no-session-persistence')) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_PROBE_STARTUP_MS)));
// A check that goes on running after it has reported, until it is killed: CodeRay then waits for it to stop.
if (process.env.FAKE_CLAUDE_PROBE_IGNORES_SIGTERM && argv.includes('--no-session-persistence')) process.on('SIGTERM', () => record({ ignoredSignal: 'SIGTERM' }));
await runSessionStartHooks();

let index = 0;
while (index < steps.length) {
  const step = steps[index];
  index += 1;
  if (step.fake === 'await-user') {
    inTurn = false;
    await waitUntil(() => inbox.length > 0);
    inbox.shift();
    inTurn = true;
  } else if (step.fake === 'sleep') {
    await waitUntil(() => interrupt !== null, step.ms);
  } else if (step.fake === 'await-control-response') {
    const matching = () => answers.findIndex((answer) => step.request === undefined || answer.response?.request_id === step.request);
    await waitUntil(() => matching() !== -1 || interrupt !== null);
    const at = matching();
    if (at !== -1) {
      const [answer] = answers.splice(at, 1);
      if (answer.response?.request_id === pendingRequest) pendingRequest = null;
      lastAnswer = answer.response?.response?.behavior === 'deny' ? 'deny' : 'allow';
    }
  } else if (step.fake === 'spawn-sleeper') {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    record({ sleeperPid: sleeper.pid });
  } else if (step.fake === 'ignore-sigterm') {
    ignoringSigterm = true;
    process.on('SIGTERM', () => record({ ignoredSignal: 'SIGTERM' }));
  } else if (step.fake === 'ignore-stdin-close') {
    keepRunning = true;
    record({ keepsRunning: true });
  } else if (step.fake === 'stderr') {
    process.stderr.write(`${step.text}\n`);
  } else if (step.fake === 'exit') {
    await new Promise((resolve) => process.stderr.write('', () => process.stdout.write('', resolve)));
    await reapShells();
    process.exit(step.code);
  } else if (step.fake === 'hang') {
    await new Promise(() => setInterval(() => {}, 60_000));
  } else if (step.fake === 'tool') {
    await runTool(step);
  } else if (step.fake === 'mcp') {
    await callIdecore(step);
  } else if (step.fake === 'mcp-write') {
    await runMcpWrite(step);
  } else if (step.fake === 'task-end') {
    endShellTask(step);
  } else if (step.when !== undefined && step.when !== lastAnswer) {
    continue;
  } else {
    if (step.type === 'result') inTurn = false;
    if (step.type === 'system' && step.subtype === 'init') inTurn = true;
    const { when, ...event } = step;
    emit(event);
    track(event);
  }
  if (interrupt !== null) index = abortTurn(index);
}
