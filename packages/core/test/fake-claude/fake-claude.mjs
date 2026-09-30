#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
let pendingRequest = null;
let running = null;
let keepRunning = false;
let interrupt = null;
let inTurn = false;
let wake = () => {};

record({ argv, pid: process.pid, claudecode: process.env.CLAUDECODE ?? null });

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
        emit(interruptAnswer(message.request_id));
      }
    } else if (message.type === 'control_request') {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } });
    }
    wake();
  })
  .on('close', () => {
    if (!keepRunning) process.exit(0);
  });

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

function abortTurn(from) {
  for (const task of backgroundAgents.values()) {
    emit({ type: 'system', subtype: 'task_updated', task_id: task.task_id, patch: { status: 'killed' }, session_id: sessionId });
    emit({ type: 'system', subtype: 'task_notification', task_id: task.task_id, tool_use_id: task.tool_use_id, status: 'stopped', summary: task.description, session_id: sessionId });
  }
  backgroundAgents.clear();
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

function finishTool(id, content, isError) {
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] }, parent_tool_use_id: null, session_id: sessionId };
  emit(result);
  track(result);
}

function startTool(id, name, input) {
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: sessionId };
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

async function runHooks(name, input, id) {
  const hooks = (settings?.hooks?.PreToolUse ?? [])
    .filter((entry) => entry.matcher === '*' || new RegExp(`^(?:${entry.matcher})$`).test(name))
    .flatMap((entry) => entry.hooks ?? []);
  const payload = JSON.stringify({
    session_id: sessionId, transcript_path: '', cwd: process.cwd(), prompt_id: '', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id,
  });
  for (const hook of hooks) {
    const verdict = await runHook(hook, payload);
    if (!verdict.allowed || interrupt !== null) return verdict;
  }
  return { allowed: true, reason: '', exit: 0 };
}

function perform(step) {
  const input = step.input;
  if (step.name === 'Write') writeFileSync(input.file_path, input.content);
  else if (step.name === 'Edit') writeFileSync(input.file_path, readFileSync(input.file_path, 'utf8').replace(input.old_string, input.new_string));
  else if (step.name === 'Bash') execFileSync('/bin/sh', ['-c', input.command], { cwd: process.cwd(), stdio: 'ignore' });
}

async function runTool(step) {
  // "streamed": false stands for a tool_use still in claude's output buffer when its hook runs.
  if (step.streamed !== false) startTool(step.id, step.name, step.input);
  const verdict = await runHooks(step.name, step.input, step.id);
  record({ hook: { id: step.id, tool: step.name, ...verdict } });
  if (interrupt !== null) return;
  if (!verdict.allowed) return finishTool(step.id, `PreToolUse:${step.name} hook error: ${verdict.reason}`, true);
  if (step.apply) perform(step);
  finishTool(step.id, step.result ?? 'ok', false);
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
    await waitUntil(() => answers.length > 0 || interrupt !== null);
    if (answers.shift()) pendingRequest = null;
  } else if (step.fake === 'spawn-sleeper') {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    record({ sleeperPid: sleeper.pid });
  } else if (step.fake === 'ignore-sigterm') {
    process.on('SIGTERM', () => record({ ignoredSignal: 'SIGTERM' }));
  } else if (step.fake === 'ignore-stdin-close') {
    keepRunning = true;
    record({ keepsRunning: true });
  } else if (step.fake === 'stderr') {
    process.stderr.write(`${step.text}\n`);
  } else if (step.fake === 'exit') {
    await new Promise((resolve) => process.stderr.write('', () => process.stdout.write('', resolve)));
    process.exit(step.code);
  } else if (step.fake === 'hang') {
    await new Promise(() => setInterval(() => {}, 60_000));
  } else if (step.fake === 'tool') {
    await runTool(step);
  } else if (step.fake === 'mcp') {
    await callIdecore(step);
  } else {
    emit(step);
    track(step);
  }
  if (interrupt !== null) index = abortTurn(index);
}
