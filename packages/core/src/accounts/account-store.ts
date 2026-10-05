import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ClaudeAccountView } from '@ide/protocol';
import { isRecord, parseJson } from '../json';
import { writeFileNoFollow } from '../mcp/config';

export interface AccountList {
  accounts: ClaudeAccountView[];
  activeId: string | null;
}

export interface AccountStoreOptions {
  home: string;
  claude: string;
}

export class AccountError extends Error {}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOGOUT_TIMEOUT_MS = 15_000;

export const isAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT_ID.test(value);

const isAccount = (value: unknown): value is ClaudeAccountView =>
  isRecord(value) && isAccountId(value.id) && typeof value.email === 'string' && typeof value.createdAt === 'number';

export function accountEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  // claude refuses to start inside another Claude Code session, which is where this core runs when an agent launches it.
  delete env.CLAUDECODE;
  return env;
}

export class AccountStore {
  private readonly options: AccountStoreOptions;
  private readonly base: string;
  private readonly path: string;

  constructor(options: AccountStoreOptions) {
    this.options = options;
    this.base = resolve(options.home, 'claude-accounts');
    this.path = join(options.home, 'accounts.json');
  }

  list(): AccountList {
    let value: unknown;
    try {
      value = parseJson(readFileSync(this.path, 'utf8'));
    } catch {
      return { accounts: [], activeId: null };
    }
    const accounts = isRecord(value) && Array.isArray(value.accounts) ? value.accounts.filter(isAccount) : [];
    const activeId = isRecord(value) ? accounts.find((account) => account.id === value.activeId)?.id ?? null : null;
    return { accounts, activeId };
  }

  activeId(): string | null {
    return this.list().activeId;
  }

  label(id: string | null): string {
    if (id === null) return 'System';
    return this.list().accounts.find((account) => account.id === id)?.email ?? 'a removed account';
  }

  configDir(id: string | null): string | null {
    return id === null ? null : this.dirOf(id);
  }

  claudeEnv(): Record<string, string> {
    const dir = this.configDir(this.activeId());
    return dir === null ? {} : { CLAUDE_CONFIG_DIR: dir };
  }

  setActive(id: string | null): void {
    const list = this.list();
    if (id !== null && !list.accounts.some((account) => account.id === id)) throw new AccountError('That account no longer exists.');
    this.write({ ...list, activeId: id });
  }

  add(account: ClaudeAccountView): void {
    const list = this.list();
    this.write({ accounts: [...list.accounts.filter((other) => other.id !== account.id), account], activeId: list.activeId });
  }

  // Logging out first drops the credentials claude keeps outside the directory, such as the macOS keychain item.
  async remove(id: string): Promise<void> {
    const dir = this.dirOf(id);
    if (!this.list().accounts.some((account) => account.id === id)) throw new AccountError('That account no longer exists.');
    await logout(this.options.claude, dir);
    rmSync(dir, { recursive: true, force: true });
    const list = this.list();
    this.write({ accounts: list.accounts.filter((account) => account.id !== id), activeId: list.activeId === id ? null : list.activeId });
  }

  createDir(id: string): string {
    const dir = this.dirOf(id);
    mkdirSync(this.base, { recursive: true, mode: DIR_MODE });
    chmodSync(this.base, DIR_MODE);
    mkdirSync(dir, { mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    return dir;
  }

  discardDir(id: string): void {
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  private dirOf(id: string): string {
    if (!isAccountId(id)) throw new AccountError('That is not a valid account id.');
    const dir = resolve(this.base, id);
    if (!dir.startsWith(this.base + sep)) throw new AccountError('That account directory is outside the IDE home.');
    return dir;
  }

  private write(list: AccountList): void {
    writeFileNoFollow(this.path, `${JSON.stringify(list, null, 2)}\n`, FILE_MODE);
  }
}

function logout(claude: string, dir: string): Promise<void> {
  return new Promise((done) => {
    const child = execFile(claude, ['auth', 'logout'], { env: accountEnv(dir), timeout: LOGOUT_TIMEOUT_MS }, () => done());
    child.stdin?.end();
  });
}
