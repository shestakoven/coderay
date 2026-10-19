import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DISALLOWED_TOOLS } from '../src/agent/tools';
import { defaultTranscriptsDir, transcriptPath } from '../src/watchdog/recovery';

const PROMPT = 'Reply with exactly: OK';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const kind = (message: SDKMessage): string => (message.type === 'system' ? `system/${message.subtype}` : message.type);
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300) ?? '';
const until = async (done: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await sleep(100);
};
const initOf = (messages: SDKMessage[]) => {
  for (const message of messages) if (message.type === 'system' && message.subtype === 'init') return message;
  return undefined;
};
const describe = (message: SDKMessage): string => {
  if (message.type !== 'user') return kind(message);
  const content = message.message.content;
  const replay = 'isReplay' in message ? String(message.isReplay) : 'absent';
  return `user (isReplay ${replay}, keys ${Object.keys(message).sort().join('/')}, ${typeof content === 'string' ? JSON.stringify(content) : 'block content'})`;
};

function claudeEnv(entrypoint: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint !== null) env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  return env;
}

// One session with CodeRay's options; the input stays open, as in the IDE.
function session(claude: string, cwd: string, settings: string, entrypoint: string | null) {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const messages: SDKMessage[] = [];
  const q = query({
    prompt: input(),
    options: {
      pathToClaudeCodeExecutable: claude, cwd, env: claudeEnv(entrypoint), model: 'haiku', sessionId: randomUUID(),
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, includePartialMessages: true,
      disallowedTools: DISALLOWED_TOOLS, settings,
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: 'Answer in as few words as possible.' },
      canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
    },
  });
  let failure: string | null = null;
  let over = false;
  const pump = (async () => {
    try {
      for await (const message of q) messages.push(message);
    } catch (error) {
      failure = firstLine(error);
    } finally {
      over = true;
    }
  })();
  let closing: Promise<void> | null = null;
  const results = () => messages.filter((message) => message.type === 'result').length;
  return {
    q, messages,
    over: () => over,
    failure: () => failure,
    send(text: string) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    async turn(text: string, ms = 90_000): Promise<boolean> {
      const before = results();
      this.send(text);
      const end = Date.now() + ms;
      while (results() === before && !over && Date.now() < end) await sleep(100);
      return results() > before;
    },
    close() {
      closing ??= (async () => {
        q.close();
        await pump;
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: { claude: { type: 'string', default: 'claude' } } });
  const claude = values.claude;
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-probe-')));
  const transcriptNames = (): Set<string> => {
    try {
      return new Set(readdirSync(dirname(transcriptPath(defaultTranscriptsDir(), cwd, 'x'))));
    } catch {
      return new Set();
    }
  };
  const open: { close(): Promise<void> }[] = [];
  try {
    const marker = join(cwd, 'session-start.log');
    const hook = join(cwd, 'hook.mjs');
    writeFileSync(hook, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `${Date.now()}\\n`);\n");
    const settings = join(cwd, 'probe.settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [hook, marker] }] }] } }));
    const rows: string[] = [];

    const a = session(claude, cwd, settings, null);
    open.push(a);
    await until(() => existsSync(marker) || a.over(), 10_000);
    if (a.over()) throw new Error(`claude (${claude}) did not start: ${a.failure() ?? 'the process ended at once'}`);
    rows.push(`| P1 | SessionStart hook ran before the first message | ${existsSync(marker) ? 'yes' : 'no'} (system/init before the first message: ${initOf(a.messages) ? 'yes' : 'no'}) |`);
    const first = await a.turn(PROMPT);
    if (!first) throw new Error(`claude (${claude}) did not answer the first message: ${a.over() ? `it ended${a.failure() ? ` (${a.failure()})` : ''}` : 'timed out'}`);
    const firstInit = initOf(a.messages);
    const toolsA = firstInit?.tools.length ?? -1;
    const before = a.messages.length;
    await a.q.setModel('sonnet');
    await sleep(4_000);
    rows.push(`| P2 | messages within 4 s after set_model, no turn open | ${a.messages.slice(before).map(describe).join(', ') || 'none'} |`);
    const namesBefore = transcriptNames();
    await a.turn('/clear', 30_000);
    const reset = a.messages.find((message) => message.type === 'conversation_reset');
    const cleared = reset?.type === 'conversation_reset' ? reset.new_conversation_id : '';
    rows.push(`| P5 | transcript named after conversation_reset's new_conversation_id, right after /clear | ${cleared === '' ? 'no conversation_reset' : transcriptNames().has(`${cleared}.jsonl`) ? 'exists' : 'missing'} |`);
    const nextInit = reset ? initOf(a.messages.slice(a.messages.indexOf(reset))) : undefined;
    const nextId = nextInit?.session_id ?? '';
    const nextFile = transcriptPath(defaultTranscriptsDir(), cwd, nextId);
    const nextState = nextId === '' ? 'no init' : existsSync(nextFile) ? `exists, ${statSync(nextFile).size} bytes` : 'missing';
    const idNote = `${nextId === firstInit?.session_id ? 'the id from before /clear' : 'a new id'}; ${nextId === cleared ? 'equals' : 'differs from'} conversation_reset's id`;
    rows.push(`| P5b | transcript named after the session_id of the init after /clear (${idNote}) | ${nextState}; file existed before /clear: ${namesBefore.has(`${nextId}.jsonl`) ? 'yes' : 'no'} |`);
    rows.push(`| P2b | model reported by the init after /clear, set_model had asked for sonnet | ${nextInit?.model ?? 'no init'} (first init: ${firstInit?.model ?? 'none'}) |`);
    const kindsA = a.messages.map(kind);
    await a.close();

    const b = session(claude, cwd, settings, 'cli');
    open.push(b);
    const turnB = await b.turn(PROMPT);
    const toolsB = initOf(b.messages)?.tools.length ?? -1;
    rows.push(`| P3 | a turn with an inherited CLAUDE_CODE_ENTRYPOINT=cli | ${turnB ? 'answered' : `no result (${b.failure() ?? 'timed out'})`}; ${toolsB} tools vs ${toolsA} with sdk-ts |`);
    const counts = new Map<string, number>();
    for (const name of [...kindsA, ...b.messages.map(kind)]) counts.set(name, (counts.get(name) ?? 0) + 1);
    rows.push(`| P4 | message kinds seen in these two sessions | ${[...counts].map(([name, count]) => `${name} ×${count}`).join(', ')} |`);
    await b.close();

    console.log(`first turn answered: ${first}; SessionStart runs logged: ${existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0}`);
    console.log(['| # | Question | Answer |', '|---|---|---|', ...rows.sort()].join('\n'));
  } finally {
    await Promise.all(open.map((entry) => entry.close()));
    rmSync(dirname(transcriptPath(defaultTranscriptsDir(), cwd, 'probe')), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

const code = await main().then(
  () => 0,
  (error: unknown) => {
    console.error(`sdk-probe: ${firstLine(error)}`);
    return 1;
  },
);
process.exit(code);
