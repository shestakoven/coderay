import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DISALLOWED_TOOLS } from '../src/agent/tools';
import { defaultTranscriptsDir, transcriptPath } from '../src/watchdog/recovery';

const PROMPT = 'Reply with exactly: OK';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const kind = (message: SDKMessage): string => (message.type === 'system' ? `system/${message.subtype}` : message.type);

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
  const pump = (async () => {
    for await (const message of q) messages.push(message);
  })().catch(() => {});
  const results = () => messages.filter((message) => message.type === 'result').length;
  return {
    q, messages,
    send(text: string) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    async turn(text: string, ms = 90_000): Promise<boolean> {
      const before = results();
      this.send(text);
      const end = Date.now() + ms;
      while (results() === before && Date.now() < end) await sleep(100);
      return results() > before;
    },
    async close() {
      q.close();
      await pump;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { claude: { type: 'string', default: 'claude' } } });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-probe-')));
  const marker = join(cwd, 'session-start.log');
  const hook = join(cwd, 'hook.mjs');
  writeFileSync(hook, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], `${Date.now()}\\n`);\n");
  const settings = join(cwd, 'probe.settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [hook, marker] }] }] } }));
  const rows: string[] = [];

  const a = session(values.claude, cwd, settings, null);
  await sleep(10_000);
  rows.push(`| P1 | SessionStart hook ran before the first message | ${existsSync(marker) ? 'yes' : 'no'} |`);
  const first = await a.turn(PROMPT);
  const tools = (message: SDKMessage | undefined) => (message?.type === 'system' && message.subtype === 'init' ? message.tools.length : -1);
  const toolsA = tools(a.messages.find((message) => message.type === 'system' && message.subtype === 'init'));
  const before = a.messages.length;
  await a.q.setModel('sonnet');
  await sleep(4_000);
  rows.push(`| P2 | messages within 4 s after set_model, no turn open | ${a.messages.slice(before).map(kind).join(', ') || 'none'} |`);
  await a.turn('/clear', 30_000);
  const reset = a.messages.find((message) => message.type === 'conversation_reset');
  const cleared = reset?.type === 'conversation_reset' ? reset.new_conversation_id : '';
  const transcript = cleared === '' ? '' : transcriptPath(defaultTranscriptsDir(), cwd, cleared);
  rows.push(`| P5 | transcript of the new conversation right after /clear | ${cleared === '' ? 'no conversation_reset' : existsSync(transcript) ? 'exists' : 'missing'} |`);
  const resetAt = reset ? a.messages.indexOf(reset) : -1;
  const next = resetAt < 0 ? undefined : a.messages.slice(resetAt).find((message) => message.type === 'system' && message.subtype === 'init');
  const nextId = next?.type === 'system' && next.subtype === 'init' ? next.session_id : '';
  const nextState = nextId === '' ? 'no init' : existsSync(transcriptPath(defaultTranscriptsDir(), cwd, nextId)) ? 'exists' : 'missing';
  rows.push(`| P5b | transcript under the session_id of the init after /clear (${nextId === cleared ? 'same id as conversation_reset' : 'another id than conversation_reset'}) | ${nextState} |`);
  const kindsA = a.messages.map(kind);
  await a.close();

  const b = session(values.claude, cwd, settings, 'cli');
  const turnB = await b.turn(PROMPT);
  const toolsB = tools(b.messages.find((message) => message.type === 'system' && message.subtype === 'init'));
  rows.push(`| P3 | a turn with an inherited CLAUDE_CODE_ENTRYPOINT=cli | ${turnB ? 'answered' : 'no result'}; tools ${toolsB} vs ${toolsA} with sdk-ts |`);
  const counts = new Map<string, number>();
  for (const name of [...kindsA, ...b.messages.map(kind)]) counts.set(name, (counts.get(name) ?? 0) + 1);
  rows.push(`| P4 | message kinds seen | ${[...counts].map(([name, count]) => `${name} ×${count}`).join(', ')} |`);
  await b.close();

  console.log(`first turn answered: ${first}; SessionStart runs logged: ${existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0}`);
  console.log(['| # | Question | Answer |', '|---|---|---|', ...rows.sort()].join('\n'));
  rmSync(dirname(transcriptPath(defaultTranscriptsDir(), cwd, 'probe')), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

await main();
process.exit(0);
