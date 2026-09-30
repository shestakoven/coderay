import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCommand } from '../../src/agent/claude-process';
import { fixture } from '../helpers';

export interface FakeRecord {
  argv?: string[];
  pid?: number;
  claudecode?: string | null;
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
