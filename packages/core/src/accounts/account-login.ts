import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AccountLoginView } from '@ide/protocol';
import { isRecord, parseJson } from '../json';
import { killGroup } from '../models/claude-cli';
import { AccountError, accountEnv, type AccountStore } from './account-store';

export interface AccountLoginOptions {
  accounts: AccountStore;
  claude: string;
  onChange: () => void;
  timeoutMs?: number;
  now?: () => number;
}

interface Attempt {
  id: string;
  dir: string;
  child: ChildProcess;
  timer: NodeJS.Timeout | undefined;
  output: string;
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 64 * 1024;
// OSC sequences (claude prints the URL as an OSC 8 hyperlink) end with BEL or ST; CSI sequences are colours and cursor moves.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
// The URL must be followed by a separator, so one cut off at the end of a chunk is not taken.
const URL_PATTERN = /https:\/\/[^\s\x00-\x1f"'<>]+(?=[\s\x00-\x1f])/;

export function loginUrl(output: string): string | null {
  return URL_PATTERN.exec(output.replace(ESCAPES, ''))?.[0] ?? null;
}

// The URL, the pasted code and claude's output can carry sign-in secrets: none of them is logged or written anywhere.
export class AccountLogin {
  private readonly options: AccountLoginOptions;
  private attempt: Attempt | null = null;
  private current: AccountLoginView = { state: 'idle', url: null, error: null };

  constructor(options: AccountLoginOptions) {
    this.options = options;
  }

  view(): AccountLoginView {
    return this.current;
  }

  start(): void {
    if (this.attempt) throw new AccountError('A sign-in is already running; finish or cancel it first.');
    const id = randomUUID();
    const dir = this.options.accounts.createDir(id);
    let child: ChildProcess;
    try {
      // Detached so that cancelling stops claude's whole process group.
      child = spawn(this.options.claude, ['auth', 'login'], { env: accountEnv(dir), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      this.options.accounts.discardDir(id);
      throw error;
    }
    const attempt: Attempt = { id, dir, child, timer: undefined, output: '' };
    this.attempt = attempt;
    attempt.timer = setTimeout(() => this.fail(attempt, 'The sign-in timed out after 10 minutes.'), this.options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const read = (chunk: string): void => {
      if (this.attempt !== attempt || this.current.url !== null) return;
      attempt.output = (attempt.output + chunk).slice(0, MAX_OUTPUT_CHARS);
      const url = loginUrl(attempt.output);
      if (url !== null) this.set({ state: 'waiting', url, error: null });
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', read);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', read);
    child.stdin?.on('error', () => {});
    // A core that dies without its shutdown path must not leave a sign-in running that could still save credentials.
    const onCoreExit = (): void => killGroup(child);
    if (child.pid !== undefined) process.on('exit', onCoreExit);
    child.once('error', () => this.fail(attempt, `CodeRay could not run ${this.options.claude}.`));
    child.once('exit', (code) => {
      process.removeListener('exit', onCoreExit);
      if (code === 0) this.check(attempt);
      else this.fail(attempt, `The sign-in did not finish (claude exited with ${code === null ? 'a signal' : `code ${code}`}).`);
    });
    this.set({ state: 'waiting', url: null, error: null });
  }

  submitCode(code: string): void {
    const stdin = this.attempt?.child.stdin;
    if (this.current.state !== 'waiting' || !stdin?.writable) throw new AccountError('No sign-in is waiting for a code.');
    stdin.write(`${code}\n`);
  }

  cancel(): void {
    if (this.attempt) this.discard(this.attempt);
    if (this.current.state !== 'idle') this.set({ state: 'idle', url: null, error: null });
  }

  private check(attempt: Attempt): void {
    if (this.attempt !== attempt) return;
    clearTimeout(attempt.timer);
    this.set({ state: 'checking', url: null, error: null });
    const child = execFile(this.options.claude, ['auth', 'status', '--json'], { env: accountEnv(attempt.dir), timeout: STATUS_TIMEOUT_MS }, (_error, stdout) => {
      if (this.attempt !== attempt) return;
      // A signed-out claude exits with code 1 but still prints its status.
      const status = parseJson(String(stdout));
      if (!isRecord(status) || status.loggedIn !== true) {
        this.fail(attempt, 'claude finished, but the new account is not signed in.');
        return;
      }
      const email = typeof status.email === 'string' && status.email !== '' ? status.email : 'unknown email';
      try {
        this.options.accounts.add({ id: attempt.id, email, createdAt: (this.options.now ?? Date.now)() });
      } catch (error) {
        this.fail(attempt, `CodeRay could not save the account (${(error as Error).message}).`);
        return;
      }
      this.attempt = null;
      this.set({ state: 'idle', url: null, error: null });
    });
    child.stdin?.end();
  }

  private fail(attempt: Attempt, error: string): void {
    if (this.attempt !== attempt) return;
    this.discard(attempt);
    this.set({ state: 'error', url: null, error });
  }

  private discard(attempt: Attempt): void {
    this.attempt = null;
    clearTimeout(attempt.timer);
    if (attempt.child.exitCode === null && attempt.child.signalCode === null) killGroup(attempt.child);
    try {
      this.options.accounts.discardDir(attempt.id);
    } catch (error) {
      console.error('accounts: could not remove an unfinished sign-in directory', error);
    }
  }

  private set(view: AccountLoginView): void {
    this.current = view;
    this.options.onChange();
  }
}
