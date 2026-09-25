import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.";
const INTERRUPTED = '[Request interrupted by user for tool use]';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const sessionId = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
const record = (entry) => {
  if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify(entry)}\n`);
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event).replaceAll('$SESSION', sessionId)}\n`);
const interruptAnswer = (requestId) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } });
const steps = readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const inbox = [];
const answers = [];
const openToolUses = new Set();
const foregroundTasks = new Map();
const backgroundAgents = new Map();
let pendingRequest = null;
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
      if (inTurn) interrupt = message.request_id;
      else emit(interruptAnswer(message.request_id));
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
  } else {
    emit(step);
    track(step);
  }
  if (interrupt !== null) index = abortTurn(index);
}
