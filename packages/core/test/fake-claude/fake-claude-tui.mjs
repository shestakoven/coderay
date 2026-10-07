// The interactive claude of CodeRay's agent terminal: no -p, a TTY. It runs the hooks of --settings the way claude does and prints what it does.
//   FAKE_CLAUDE_TUI_TOOL    {"name","input"}: every turn runs this tool between the prompt and the answer.
//   FAKE_CLAUDE_TUI_SLOW_MS every turn waits this long for Esc before it answers; Esc interrupts it.
//   FAKE_CLAUDE_TUI_HOOK_SESSION the session id the turn hooks report, as another claude's would.
// The answer is printed after the Stop hook: a test that sees it on screen knows CodeRay has seen the turn end. "/exit" quits.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const sessionId = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
const settings = flag('--settings') ? JSON.parse(readFileSync(flag('--settings'), 'utf8')) : null;
const tool = process.env.FAKE_CLAUDE_TUI_TOOL ? JSON.parse(process.env.FAKE_CLAUDE_TUI_TOOL) : null;
const slowMs = Number(process.env.FAKE_CLAUDE_TUI_SLOW_MS ?? 0);
const transcript = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);

const say = (text) => process.stdout.write(`${text}\r\n`);
const record = (entry) => {
  if (process.env.FAKE_CLAUDE_RECORD) appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify(entry)}\n`);
};
const append = (entry) => {
  mkdirSync(dirname(transcript), { recursive: true });
  appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
};

function runHook(hook, payload) {
  return new Promise((resolve) => {
    const child = spawn(hook.command, hook.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 2) return resolve({ allowed: false, reason: stderr.trim() });
      let output = null;
      try {
        output = code === 0 ? JSON.parse(stdout).hookSpecificOutput : null;
      } catch {
        output = null;
      }
      resolve(output?.permissionDecision === 'deny' ? { allowed: false, reason: output.permissionDecisionReason ?? '' } : { allowed: true, reason: '' });
    });
    child.stdin.end(payload);
  });
}

async function fire(event, fields = {}, toolName) {
  const reported = event === 'SessionStart' ? sessionId : (process.env.FAKE_CLAUDE_TUI_HOOK_SESSION ?? sessionId);
  const payload = JSON.stringify({ session_id: reported, transcript_path: transcript, cwd: process.cwd(), permission_mode: 'default', hook_event_name: event, ...fields });
  const matches = (entry) => toolName === undefined || !entry.matcher || entry.matcher === '*' || new RegExp(`^(?:${entry.matcher})$`).test(toolName);
  let verdict = { allowed: true, reason: '' };
  for (const entry of (settings?.hooks?.[event] ?? []).filter(matches)) {
    for (const hook of entry.hooks ?? []) {
      const result = await runHook(hook, payload);
      if (!result.allowed) verdict = result;
    }
  }
  return verdict;
}

async function useTool() {
  const id = 'toolu_fake_tui';
  const input = tool.input ?? {};
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool.name, input }] } });
  const verdict = await fire('PreToolUse', { tool_name: tool.name, tool_input: input, tool_use_id: id }, tool.name);
  record({ hook: { id, tool: tool.name, ...verdict } });
  if (!verdict.allowed) {
    say(`✗ ${tool.name} denied: ${verdict.reason}`);
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: verdict.reason }] } });
    return;
  }
  say(`✓ ${tool.name} done`);
  await fire('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: 'ok', tool_use_id: id }, tool.name);
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
}

let escape = null;
const waitForEscape = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => {
    escape = null;
    resolve(false);
  }, ms);
  escape = () => {
    clearTimeout(timer);
    escape = null;
    resolve(true);
  };
});

async function turn(prompt) {
  append({ type: 'user', message: { role: 'user', content: prompt } });
  await fire('UserPromptSubmit', { prompt });
  say('● working');
  if (tool) await useTool();
  if (slowMs > 0) {
    const interrupted = waitForEscape(slowMs);
    say('● thinking slowly, Esc interrupts');
    if (await interrupted) {
      append({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      say('Interrupted · What should Claude do instead?');
      return;
    }
  }
  const answer = `fake answer to: ${prompt}`;
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  await fire('Stop', { last_assistant_message: answer, stop_hook_active: false });
  say(`● ${answer}`);
}

let line = '';
let busy = false;
const ask = () => process.stdout.write('> ');

function submit() {
  const prompt = line;
  line = '';
  say('');
  if (prompt === '/exit') {
    say('bye');
    process.stdout.write('', () => process.exit(0));
    return;
  }
  if (prompt === '') return ask();
  busy = true;
  void turn(prompt).finally(() => {
    busy = false;
    ask();
  });
}

function onInput(chunk) {
  if (chunk === '\x1b') return escape?.();
  if (chunk.startsWith('\x1b') || busy) return;
  for (const char of chunk) {
    if (char === '\r' || char === '\n') submit();
    else if (char === '\x7f') {
      line = line.slice(0, -1);
      process.stdout.write('\b \b');
    } else if (char >= ' ') {
      line += char;
      process.stdout.write(char);
    }
  }
}

record({ argv, pid: process.pid, claudecode: process.env.CLAUDECODE ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, interactive: true });
if (process.env.FAKE_CLAUDE_HOOKS !== 'off') await fire('SessionStart', { source: flag('--resume') ? 'resume' : 'startup' });
say('FAKE CLAUDE INTERACTIVE');
say(flag('--resume') ? 'resumed the conversation' : 'a new conversation');
ask();
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', onInput);
process.stdin.on('close', () => process.exit(0));
await new Promise(() => {});
