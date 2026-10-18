import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpencodeCommand } from '../../src/agent/opencode/command';

export const FAKE_OPENCODE = fileURLToPath(new URL('./fake-opencode.mjs', import.meta.url));

export interface OpencodeRecord {
  pid?: number;
  argv?: string[];
  xdg?: Record<string, string | null>;
  credentials?: string[];
  env?: string[];
  opencodeVars?: string[];
  configContent?: unknown;
  passwordHash?: string | null;
  req?: { method: string; path: string; body: unknown; directory: string | null };
  session?: { id: string; permission: unknown };
  prompt?: { session: string; kind: string; body: unknown };
  reply?: { id: string; reply: string; message: string | null; cascaded?: boolean };
  questionReply?: { id: string; kind: string; answers: unknown };
  sleeperPid?: number;
}

export function fakeOpencode(scenario: string | null, recordFile: string, env: Record<string, string> = {}): OpencodeCommand {
  return { command: process.execPath, args: [FAKE_OPENCODE], env: { ...(scenario === null ? {} : { FAKE_OPENCODE_SCENARIO: scenario }), FAKE_OPENCODE_RECORD: recordFile, ...env } };
}

export function opencodeRecords(recordFile: string): OpencodeRecord[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as OpencodeRecord);
}

/** The requests of that method and path the fake received, in order. */
export const requests = (records: OpencodeRecord[], method: string, path: RegExp | string): NonNullable<OpencodeRecord['req']>[] =>
  records.flatMap((record) => (record.req && record.req.method === method && (typeof path === 'string' ? record.req.path === path : path.test(record.req.path)) ? [record.req] : []));
