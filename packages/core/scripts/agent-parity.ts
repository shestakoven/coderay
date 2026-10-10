import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startClaude, type ClaudeCommand, type ProcessExit } from '../src/agent/claude-process';
import { startSdkTransport } from '../src/agent/sdk-transport';
import { DISALLOWED_TOOLS, isModelChoice } from '../src/agent/tools';
import { userMessage, type Launch, type TransportSink, type UserMessage } from '../src/agent/transport';
import { isRecord, parseJson } from '../src/json';
import { defaultTranscriptsDir, transcriptPath } from '../src/watchdog/recovery';

// Fields of claude's init that say what the agent can do; ids, paths and timings are left out, and no environment value is ever printed.
const FIELDS = ['claude_code_version', 'model', 'permissionMode', 'apiKeySource', 'output_style', 'tools', 'slash_commands', 'skills', 'agents', 'plugins', 'mcp_servers'];
const PROMPT = 'Reply with exactly: OK';
const ANSWER_TIMEOUT_MS = 120_000;

type Init = Record<string, unknown>;
interface Started { send(message: UserMessage): void; exited: Promise<ProcessExit>; kill(): Promise<ProcessExit> }
type Start = (launch: Launch, sink: TransportSink) => Started;
interface Run { init: Init; initMs: number; textMs: number; resultMs: number }
type Timing = 'initMs' | 'textMs' | 'resultMs';

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300) ?? '';

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.map((entry) => (isRecord(entry) ? `${String(entry.name)}${entry.status === undefined ? '' : `:${String(entry.status)}`}` : String(entry))).sort();
}

export function summarizeInit(init: Init): Record<string, string[]> {
  return Object.fromEntries(FIELDS.map((field) => [field, names(init[field])]));
}

export function compareInits(raw: Init, sdk: Init): string[] {
  return FIELDS.flatMap((field) => {
    const before = names(raw[field]);
    const after = names(sdk[field]);
    const changes = [...after.filter((name) => !before.includes(name)).map((name) => `+${name}`), ...before.filter((name) => !after.includes(name)).map((name) => `-${name}`)];
    return changes.length === 0 ? [] : [`${field}: ${changes.join(' ')}`];
  });
}

const isTextDelta = (message: Init): boolean =>
  message.type === 'stream_event' && isRecord(message.event) && message.event.type === 'content_block_delta' && isRecord(message.event.delta) && message.event.delta.type === 'text_delta';

// The argv the chat's claude was started with before the agent SDK, frozen here as the baseline the SDK is measured against.
function printArgs(launch: Launch): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    launch.resume ? '--resume' : '--session-id', launch.claudeSessionId,
    ...(launch.model !== null ? ['--model', launch.model] : []),
    ...(launch.effort !== null ? ['--effort', launch.effort] : []),
    '--mcp-config', launch.mcpConfigPath,
    '--disallowedTools', launch.disallowedTools.join(','),
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
  ];
}

const startClaudeP: Start = (launch, sink) => {
  const child = startClaude(launch.claude, printArgs(launch), launch.cwd, (line) => {
    if (line.trim() !== '') sink.message(parseJson(line) ?? line);
  });
  return { send: (message) => child.write(message), exited: child.exited, kill: () => child.kill() };
};

// One chat's start as the product makes it: the same Launch goes through the given transport, the first message is sent at once, and the clock runs from the spawn.
async function measure(start: Start, launch: Launch, interrupted: Promise<never>): Promise<Run> {
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  let init: Init | null = null;
  let initMs = 0;
  let textMs: number | null = null;
  let answer!: (run: Run) => void;
  let fail!: (error: Error) => void;
  const answered = new Promise<Run>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  const sink: TransportSink = {
    message(value) {
      if (!isRecord(value)) return;
      if (value.type === 'system' && value.subtype === 'init' && init === null) {
        init = value;
        initMs = elapsed();
      }
      if (textMs === null && isTextDelta(value)) textMs = elapsed();
      if (value.type !== 'result') return;
      if (value.is_error === true) fail(new Error(`claude answered with an error (${String(value.subtype)})`));
      else if (init === null) fail(new Error('claude answered without ever printing an init'));
      else answer({ init, initMs, textMs: textMs ?? elapsed(), resultMs: elapsed() });
    },
  };
  const transport = start(launch, sink);
  const timer = setTimeout(() => fail(new Error(`claude gave no answer within ${ANSWER_TIMEOUT_MS / 1000} s`)), ANSWER_TIMEOUT_MS);
  try {
    transport.send(userMessage(PROMPT, []));
    const ended = transport.exited.then((exit) => {
      throw new Error(`claude (${launch.claude.command}) ended before it answered: ${exit.error ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`)}`);
    });
    return await Promise.race([answered, ended, interrupted]);
  } finally {
    clearTimeout(timer);
    await transport.kill();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

const timings = (runs: Run[], key: Timing): number[] => runs.map((run) => Math.round(run[key]));

function unstable(runs: Run[]): string[] {
  const first = summarizeInit(runs[0]?.init ?? {});
  return FIELDS.filter((field) => runs.some((run) => summarizeInit(run.init)[field]?.join('\n') !== first[field]?.join('\n')));
}

const COUNTED = ['skills', 'slash_commands', 'plugins', 'mcp_servers', 'agents', 'tools'];

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: { cwd: { type: 'string' }, claude: { type: 'string', default: 'claude' }, model: { type: 'string', default: 'haiku' }, runs: { type: 'string', default: '3' }, out: { type: 'string' } },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a whole number of at least 1');
  if (!isModelChoice(values.model)) throw new Error('--model must be a model alias or id');
  const cwd = realpathSync(values.cwd ?? process.cwd());
  const dir = mkdtempSync(join(tmpdir(), 'agent-parity-'));
  const mcpConfigPath = join(dir, 'mcp.json');
  const sessionIds: string[] = [];
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
    const transcripts = defaultTranscriptsDir();
    for (const id of sessionIds) {
      const file = transcriptPath(transcripts, cwd, id);
      rmSync(file, { force: true });
      // rmdir only removes what is empty: whatever else claude keeps for this directory or session stays.
      for (const empty of [join(dirname(file), 'memory'), dirname(file), join(dirname(transcripts), 'session-env', id)]) {
        try {
          rmdirSync(empty);
        } catch {
          // Not empty or already gone.
        }
      }
    }
  };
  // A signal stops the run through the same path as a failure, so that claude is gone before its transcript is cleaned up.
  const interrupted = new Promise<never>((_, reject) => {
    for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => reject(new Error(`interrupted by ${name}`)));
  });
  interrupted.catch(() => {});
  try {
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    const claude: ClaudeCommand = { command: values.claude, args: [] };
    const launch = (): Launch => {
      const claudeSessionId = randomUUID();
      sessionIds.push(claudeSessionId);
      return { claude, cwd, claudeSessionId, resume: false, model: values.model, effort: null, mcpConfigPath, disallowedTools: DISALLOWED_TOOLS, gate: null };
    };
    const cli: Run[] = [];
    const sdk: Run[] = [];
    // Alternating which side goes first keeps a warm disk cache from favouring one of them.
    for (let run = 0; run < runs; run += 1) {
      const order = run % 2 === 0 ? [[startClaudeP, cli], [startSdkTransport, sdk]] as const : [[startSdkTransport, sdk], [startClaudeP, cli]] as const;
      for (const [start, into] of order) into.push(await measure(start, launch(), interrupted));
    }
    const first = { cli: cli[0]?.init ?? {}, sdk: sdk[0]?.init ?? {} };
    const differences = compareInits(first.cli, first.sdk);
    const shaky = { 'claude -p': unstable(cli), 'agent SDK': unstable(sdk) };
    const latency = Object.fromEntries((['initMs', 'textMs', 'resultMs'] as Timing[]).map((key) => [key, { cli: timings(cli, key), sdk: timings(sdk, key), cliMedian: median(timings(cli, key)), sdkMedian: median(timings(sdk, key)) }]));
    const summary = { cli: summarizeInit(first.cli), sdk: summarizeInit(first.sdk) };
    const spread = (key: Timing): number => Math.max(...timings(cli, key)) - Math.min(...timings(cli, key));

    console.log(`claude ${String(first.cli.claude_code_version)}, model ${values.model}, ${runs} runs each, sides alternating`);
    for (const field of COUNTED) console.log(`${field.padEnd(15)} claude -p ${String(summary.cli[field]?.length)}  agent SDK ${String(summary.sdk[field]?.length)}`);
    console.log(`apiKeySource    claude -p ${summary.cli.apiKeySource?.join(',')}  agent SDK ${summary.sdk.apiKeySource?.join(',')}`);
    console.log(differences.length === 0 ? 'init: identical' : `init differs (+ in the agent SDK, - missing from it):\n  ${differences.join('\n  ')}`);
    for (const [side, fields] of Object.entries(shaky)) if (fields.length > 0) console.log(`not stable between runs of ${side}: ${fields.join(', ')}`);
    for (const [label, key] of [['init', 'initMs'], ['first text', 'textMs'], ['result', 'resultMs']] as const) {
      const entry = latency[key];
      console.log(`${label.padEnd(10)} claude -p ${String(entry?.cliMedian)} ms [${entry?.cli.join(' ')}]  agent SDK ${String(entry?.sdkMedian)} ms [${entry?.sdk.join(' ')}]  difference ${(entry?.sdkMedian ?? 0) - (entry?.cliMedian ?? 0)} ms (claude -p spread ${spread(key)} ms)`);
    }
    if (values.out !== undefined) {
      writeFileSync(values.out, `${JSON.stringify({ claude_code_version: first.cli.claude_code_version, model: values.model, runs, claudeP: summary.cli, agentSdk: summary.sdk, differences, unstable: shaky, latencyMs: latency }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(values.out, 0o600);
      console.log(`wrote ${values.out}`);
    }
    return differences.length === 0 ? 0 : 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main().catch((error: unknown) => {
    console.error(`agent-parity: ${firstLine(error)}`);
    return 2;
  });
  process.stdout.write('', () => process.exit(code));
}
