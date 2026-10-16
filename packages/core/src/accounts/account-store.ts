import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AccountView } from '@ide/protocol';
import { isRecord, parseJson } from '../json';
import { writeFileNoFollow } from '../mcp/config';
import { ACCOUNT_DIRS, accountHome, SYSTEM_HOME, type AccountEngine, type AccountHome, type SignedHome } from './account-homes';

export interface AccountList {
  accounts: AccountView[];
  activeId: string | null;
}

export interface AccountStoreOptions {
  home: string;
  engine: AccountEngine;
  /** Signs the account out of what lives outside its directory (claude's keychain item, a Codex session) before the directory goes. */
  logout: (home: SignedHome) => Promise<void>;
}

export class AccountError extends Error {}

export const REMOVED_ACCOUNT = 'a removed account';

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOGOUT_TIMEOUT_MS = 15_000;

export const isAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT_ID.test(value);

const isAccount = (value: unknown): value is AccountView =>
  isRecord(value) && isAccountId(value.id) && typeof value.email === 'string' && typeof value.createdAt === 'number'
  && (value.plan === undefined || typeof value.plan === 'string');

/** The account as an engine's header and the chat's notices name it. */
export const accountName = (account: AccountView): string => (account.plan ? `${account.email} · ${account.plan}` : account.email);

export function accountEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  // claude refuses to start inside another Claude Code session, which is where this core runs when an agent launches it.
  delete env.CLAUDECODE;
  return env;
}

// accounts.json keeps Claude's list at the top level, where CodeRay wrote it before engines, and each other engine's under its id.
export class AccountStore {
  readonly engine: AccountEngine;
  private readonly options: AccountStoreOptions;
  private readonly base: string;
  private readonly path: string;

  constructor(options: AccountStoreOptions) {
    this.options = options;
    this.engine = options.engine;
    this.base = resolve(options.home, ACCOUNT_DIRS[options.engine]);
    this.path = join(options.home, 'accounts.json');
  }

  list(): AccountList {
    const file = this.read();
    const section = this.engine === 'claude' ? file : file?.[this.engine];
    const accounts = isRecord(section) && Array.isArray(section.accounts) ? section.accounts.filter(isAccount) : [];
    const activeId = isRecord(section) ? accounts.find((account) => account.id === section.activeId)?.id ?? null : null;
    return { accounts, activeId };
  }

  activeId(): string | null {
    return this.list().activeId;
  }

  label(id: string | null): string {
    if (id === null) return 'System';
    const account = this.list().accounts.find((candidate) => candidate.id === id);
    return account ? accountName(account) : REMOVED_ACCOUNT;
  }

  /** The active account's name for the engine's header; null while the engine has no account of CodeRay's. */
  activeLabel(): string | null {
    const { accounts, activeId } = this.list();
    if (accounts.length === 0) return null;
    const active = accounts.find((account) => account.id === activeId);
    return active ? accountName(active) : 'System';
  }

  homeDir(id: string | null): string | null {
    return id === null ? null : this.dirOf(id);
  }

  home(id: string | null): AccountHome {
    return id === null ? SYSTEM_HOME : accountHome(this.engine, this.dirOf(id));
  }

  /** What points the engine at the active account, for the background models, which keep the core's credentials. */
  activeEnv(): Readonly<Record<string, string>> {
    return this.home(this.activeId()).env;
  }

  setActive(id: string | null): void {
    const list = this.list();
    if (id !== null && !list.accounts.some((account) => account.id === id)) throw new AccountError('That account no longer exists.');
    this.write({ ...list, activeId: id });
  }

  add(account: AccountView): void {
    const list = this.list();
    this.write({ accounts: [...list.accounts.filter((other) => other.id !== account.id), account], activeId: list.activeId });
  }

  async remove(id: string): Promise<void> {
    const dir = this.dirOf(id);
    if (!this.list().accounts.some((account) => account.id === id)) throw new AccountError('That account no longer exists.');
    await this.options.logout(accountHome(this.engine, dir));
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
    if (!dir.startsWith(this.base + sep)) throw new AccountError('That account directory is outside CodeRay home.');
    return dir;
  }

  // A list reads a file it cannot read as no accounts; a write (`strict`) refuses it, or the other engines' lists would go.
  private read(strict = false): Record<string, unknown> | null {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A dangling link reads as ENOENT, but the rename would replace the link.
      if (!strict || (code === 'ENOENT' && !lstatSync(this.path, { throwIfNoEntry: false }))) return null;
      throw new AccountError(`CodeRay could not read ${this.path} (${code ?? 'unknown error'}) and left the accounts as they were.`);
    }
    const value = parseJson(text);
    return isRecord(value) ? value : null;
  }

  // Replaces only this engine's part, so the other engines' lists and keys a later CodeRay wrote survive.
  // A temp file and a rename: the hub runs a core per project over this one file, and none may read it half-written.
  private write(list: AccountList): void {
    const file = this.read(true) ?? {};
    const next = this.engine === 'claude' ? { ...file, accounts: list.accounts, activeId: list.activeId } : { ...file, [this.engine]: list };
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileNoFollow(temp, `${JSON.stringify(next, null, 2)}\n`, FILE_MODE);
      renameSync(temp, this.path);
    } catch (error) {
      // rmSync leaves a dangling link at the temp path in place; unlink removes it.
      try {
        unlinkSync(temp);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;
      }
      throw error;
    }
  }
}

export function claudeAccounts(home: string, claude: string): AccountStore {
  return new AccountStore({ home, engine: 'claude', logout: (account) => claudeLogout(claude, account.dir) });
}

// Logging out first drops the credentials claude keeps outside the directory, such as the macOS keychain item.
function claudeLogout(claude: string, dir: string): Promise<void> {
  return new Promise((done) => {
    const child = execFile(claude, ['auth', 'logout'], { env: accountEnv(dir), timeout: LOGOUT_TIMEOUT_MS }, () => done());
    child.stdin?.end();
  });
}
