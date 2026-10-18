import { randomUUID } from 'node:crypto';
import { ENGINE_NAMES, LOGIN_METHODS, type AccountLoginView, type EngineId, type LoginMethod } from '@ide/protocol';
import type { SignedHome } from './account-homes';
import { AccountError, type AccountStore } from './account-store';

export type FlowUpdate =
  | { kind: 'waiting'; url: string | null; userCode: string | null }
  | { kind: 'checking' }
  | { kind: 'done'; email: string; plan: string | null }
  | { kind: 'failed'; error: string };

export interface FlowRun {
  submitCode?(code: string): void;
  cancel(): void;
  /** Settles once the engine's process has stopped; until then it can write into the account's directory. */
  stopped?: Promise<unknown>;
}

/**
 * One engine's way of signing a new account's home in. A report made before `start` returns is heard once it has; it never logs the URL, the code or the key.
 * `secret` is the API key of the `api-key` way, the name of an opencode `profile`, and null otherwise.
 */
export interface LoginFlow {
  start(home: SignedHome, method: LoginMethod, secret: string | null, report: (update: FlowUpdate) => void): FlowRun;
}

export interface AccountLoginOptions {
  engines: Partial<Record<EngineId, { store: AccountStore; flow: LoginFlow }>>;
  onChange: () => void;
  timeoutMs?: number;
  now?: () => number;
}

interface Attempt {
  id: string;
  engine: EngineId;
  method: LoginMethod;
  store: AccountStore;
  run: FlowRun | null;
  timer: NodeJS.Timeout | undefined;
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const IDLE: AccountLoginView = { state: 'idle', engine: null, method: null, url: null, userCode: null, error: null };

// The URL, the pasted code, a key and the engine's output can carry sign-in secrets: none of them is logged or written anywhere.
export class AccountLogin {
  private readonly options: AccountLoginOptions;
  private attempt: Attempt | null = null;
  private current: AccountLoginView = IDLE;

  constructor(options: AccountLoginOptions) {
    this.options = options;
  }

  view(): AccountLoginView {
    return this.current;
  }

  start(engine: EngineId, method: LoginMethod, secret: string | null = null): void {
    if (this.attempt) throw new AccountError('A sign-in is already running; finish or cancel it first.');
    const target = this.options.engines[engine];
    if (!target || !LOGIN_METHODS[engine].includes(method)) throw new AccountError(`CodeRay cannot sign ${ENGINE_NAMES[engine]} in that way.`);
    const id = randomUUID();
    const dir = target.store.createDir(id);
    const attempt: Attempt = { id, engine, method, store: target.store, run: null, timer: undefined };
    this.attempt = attempt;
    // Flows report only after `start` returns; one that reports sooner is heard once its run, timer and view are in place, so none leaks.
    const early: FlowUpdate[] = [];
    const report = (update: FlowUpdate): void => {
      if (attempt.run === null) early.push(update);
      else this.report(attempt, update);
    };
    try {
      attempt.run = target.flow.start({ ...target.store.home(id), dir }, method, secret, report);
    } catch (error) {
      this.attempt = null;
      target.store.discardDir(id);
      throw error;
    }
    this.arm(attempt);
    this.set({ state: 'waiting', engine, method, url: null, userCode: null, error: null });
    for (const update of early) this.report(attempt, update);
  }

  submitCode(code: string): void {
    const run = this.attempt?.run;
    if (this.current.state !== 'waiting' || !run?.submitCode) throw new AccountError('No sign-in is waiting for a code.');
    run.submitCode(code);
  }

  cancel(): void {
    if (this.attempt) this.discard(this.attempt);
    if (this.current.state !== 'idle') this.set(IDLE);
  }

  private report(attempt: Attempt, update: FlowUpdate): void {
    if (this.attempt !== attempt) return;
    if (update.kind === 'waiting') {
      // A flow that waits for the user again after a check gets its full time once more.
      if (attempt.timer === undefined) this.arm(attempt);
      this.set({ ...this.current, state: 'waiting', url: update.url, userCode: update.userCode, error: null });
    } else if (update.kind === 'checking') {
      clearTimeout(attempt.timer);
      attempt.timer = undefined;
      this.set({ ...this.current, state: 'checking', url: null, userCode: null, error: null });
    } else if (update.kind === 'failed') {
      this.fail(attempt, update.error);
    } else {
      try {
        attempt.store.add({ id: attempt.id, email: update.email, ...(update.plan === null ? {} : { plan: update.plan }), createdAt: (this.options.now ?? Date.now)() });
      } catch (error) {
        this.fail(attempt, `CodeRay could not save the account (${(error as Error).message}).`);
        return;
      }
      clearTimeout(attempt.timer);
      this.attempt = null;
      this.set(IDLE);
    }
  }

  private arm(attempt: Attempt): void {
    attempt.timer = setTimeout(() => this.fail(attempt, 'The sign-in timed out after 10 minutes.'), this.options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  }

  private fail(attempt: Attempt, error: string): void {
    if (this.attempt !== attempt) return;
    this.discard(attempt);
    this.set({ ...IDLE, state: 'error', engine: attempt.engine, method: attempt.method, error });
  }

  private discard(attempt: Attempt): void {
    this.attempt = null;
    clearTimeout(attempt.timer);
    attempt.run?.cancel();
    this.removeDir(attempt);
    // codex writes its state into its home until it stops, even into one removed under it: what it left goes then.
    const again = (): void => this.removeDir(attempt);
    void attempt.run?.stopped?.then(again, again);
  }

  // Only a directory under the engine's accounts that no saved account owns.
  private removeDir(attempt: Attempt): void {
    try {
      if (attempt.store.list().accounts.some((account) => account.id === attempt.id)) return;
      attempt.store.discardDir(attempt.id);
    } catch (error) {
      console.error('accounts: could not remove an unfinished sign-in directory', error);
    }
  }

  private set(view: AccountLoginView): void {
    this.current = view;
    this.options.onChange();
  }
}
