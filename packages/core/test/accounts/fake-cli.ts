import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { isAlive } from '../../src/os-process';
import { tempDir } from '../helpers';

const SCRIPT = fileURLToPath(new URL('./fake-claude-cli.mjs', import.meta.url));

export interface FakeCliConfig {
  url?: string;
  email?: string;
  codes?: Record<string, 'ok' | 'signed-out'>;
  splitAt?: 'target' | 'text';
  exitAtStart?: number;
  statusEmail?: string;
}

export interface CliRecord {
  command?: string;
  args?: string[];
  configDir?: string | null;
  configDirExists?: boolean;
  claudecode?: string | null;
  pid?: number;
  helperPid?: number;
}

export interface FakeCli {
  command: string;
  records: () => CliRecord[];
  invocations: (command: string) => CliRecord[];
  stdin: () => Buffer | null;
  dir: string;
}

export function fakeCli(config: FakeCliConfig = {}): FakeCli {
  const dir = tempDir('ide-fake-cli-');
  const record = join(dir, 'record.jsonl');
  const stdinFile = join(dir, 'stdin.bin');
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...config, record, stdinFile }));
  const command = join(dir, 'claude');
  writeFileSync(command, `#!/bin/sh\nFAKE_CLI_CONFIG='${configFile}' exec '${process.execPath}' '${SCRIPT}' "$@"\n`);
  chmodSync(command, 0o755);
  const records = (): CliRecord[] =>
    existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliRecord) : [];
  onTestFinished(() => {
    for (const entry of records()) {
      for (const pid of [entry.pid, entry.helperPid]) if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  return {
    command,
    records,
    invocations: (name) => records().filter((entry) => entry.command === name),
    stdin: () => (existsSync(stdinFile) ? readFileSync(stdinFile) : null),
    dir,
  };
}

export const accountsDir = (home: string): string => join(home, 'claude-accounts');
export const accountsFile = (home: string): string => join(home, 'accounts.json');

export interface SeededAccount {
  id: string;
  email: string;
  createdAt: number;
}

export function seedAccounts(home: string, emails: string[], active: number | null = null): SeededAccount[] {
  const accounts = emails.map((email, at) => ({ id: randomUUID(), email, createdAt: 1000 + at }));
  for (const account of accounts) {
    mkdirSync(join(accountsDir(home), account.id), { recursive: true, mode: 0o700 });
    writeFileSync(join(accountsDir(home), account.id, 'fake-credentials.json'), JSON.stringify({ email: account.email }));
  }
  writeFileSync(accountsFile(home), JSON.stringify({ accounts, activeId: active === null ? null : accounts[active]!.id }), { mode: 0o600 });
  return accounts;
}

export const mode = (path: string): number => statSync(path).mode & 0o777;

export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

export function withEnv(name: string, value: string | undefined): void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  onTestFinished(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}
