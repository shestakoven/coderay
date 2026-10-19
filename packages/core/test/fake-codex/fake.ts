import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexCommand } from '../../src/agent/codex/command';
import { fixture } from '../helpers';

export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

export interface CodexRecord {
  pid?: number;
  argv?: string[];
  codexHome?: string | null;
  credentials?: string[];
  secrets?: string[];
  in?: { method: string; params: unknown };
  reply?: { method: string; result: unknown };
  sleeperPid?: number;
}

export function fakeCodex(scenario: string | null, recordFile: string, env: Record<string, string> = {}): CodexCommand {
  const path = scenario === null ? null : isAbsolute(scenario) ? scenario : fixture(`codex/${scenario}.jsonl`);
  return { command: process.execPath, args: [FAKE_CODEX], env: { ...(path === null ? {} : { FAKE_CODEX_SCENARIO: path }), FAKE_CODEX_RECORD: recordFile, ...env } };
}

export function codexRecords(recordFile: string): CodexRecord[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CodexRecord);
}

/** The params of every request of that method the fake received, in order. */
export const sent = (records: CodexRecord[], method: string): unknown[] => records.flatMap((record) => (record.in?.method === method ? [record.in.params] : []));
