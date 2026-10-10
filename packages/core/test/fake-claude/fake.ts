import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCommand } from '../../src/agent/claude-process';
import { commandLine } from '../../src/os-process';
import { fixture } from '../helpers';

export interface FakeRecord {
  argv?: string[];
  pid?: number;
  claudecode?: string | null;
  configDir?: string | null;
  hookNames?: string[];
  credentials?: string[];
  entrypoint?: string | null;
  sdkVersion?: string | null;
  nodeOptions?: boolean;
  initialize?: { appendSystemPrompt: string | null; systemPromptSnapshot: boolean | null; pid: number };
  setModel?: string | null;
  sleeperPid?: number;
  ignoredSignal?: string;
  keepsRunning?: boolean;
  stdin?: { type: string; [key: string]: unknown };
  hook?: { id: string; tool: string; allowed: boolean; reason: string; exit: number | null };
  mcp?: { id: string; tool: string; text: string; isError: boolean };
  background?: { id: string; pid: number };
  mcpWrite?: { id: string; tool: string; written: string[] };
}

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export function fakeClaude(scenario: string, recordFile: string): ClaudeCommand {
  return {
    command: process.execPath,
    args: [FAKE_CLAUDE],
    env: { FAKE_CLAUDE_SCENARIO: isAbsolute(scenario) ? scenario : fixture(`stream/${scenario}.jsonl`), FAKE_CLAUDE_RECORD: recordFile },
  };
}

export function readRecords(recordFile: string): FakeRecord[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeRecord);
}

export function argValue(argv: string[] | undefined, name: string): string | undefined {
  if (!argv) return undefined;
  const at = argv.indexOf(name);
  if (at !== -1) return argv[at + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export const hasArg = (argv: string[] | undefined, name: string): boolean =>
  argv !== undefined && (argv.includes(name) || argv.some((arg) => arg.startsWith(`${name}=`)));

// One claude start as the session meant it, whichever transport wrote its flags (argv) or its handshake (initialize).
export interface Launched {
  pid: number;
  sessionId: string | undefined;
  resume: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  mcpConfig: string | undefined;
  settings: string | undefined;
  disallowedTools: string[];
  bypass: boolean;
  promptsOnStdio: boolean;
  partialMessages: boolean;
  appendSystemPrompt: string | null;
  systemPromptSnapshot: boolean | null;
  configDir: string | null;
}

export function launches(records: FakeRecord[]): Launched[] {
  const handshakes = new Map(records.flatMap((r) => (r.initialize ? [[r.initialize.pid, r.initialize] as const] : [])));
  return records.flatMap((r) => {
    const argv = r.argv;
    if (!argv) return [];
    const handshake = handshakes.get(r.pid ?? -1);
    const snapshot = argValue(argv, '--system-prompt-snapshot');
    return [{
      pid: r.pid ?? -1,
      sessionId: argValue(argv, '--session-id'),
      resume: argValue(argv, '--resume'),
      model: argValue(argv, '--model'),
      effort: argValue(argv, '--effort'),
      mcpConfig: argValue(argv, '--mcp-config'),
      settings: argValue(argv, '--settings'),
      disallowedTools: argValue(argv, '--disallowedTools')?.split(',') ?? [],
      bypass: argv.includes('--dangerously-skip-permissions')
        || (argValue(argv, '--permission-mode') === 'bypassPermissions' && argv.includes('--allow-dangerously-skip-permissions')),
      promptsOnStdio: argValue(argv, '--permission-prompt-tool') === 'stdio',
      partialMessages: argv.includes('--include-partial-messages'),
      appendSystemPrompt: argValue(argv, '--append-system-prompt') ?? handshake?.appendSystemPrompt ?? null,
      systemPromptSnapshot: snapshot !== undefined ? snapshot !== 'off' : handshake?.systemPromptSnapshot ?? null,
      configDir: r.configDir ?? null,
    }];
  });
}

// A pid file as a core that is gone left it: the owner and its command line are whatever the test says.
export function writePidRecord(dir: string, pid: number, owner: number, ownerCommand: string, command = commandLine(pid)?.trim() ?? ''): string {
  const file = join(dir, `claude-${pid}.pid.json`);
  writeFileSync(file, JSON.stringify({ pid, command, owner, ownerCommand }));
  return file;
}
