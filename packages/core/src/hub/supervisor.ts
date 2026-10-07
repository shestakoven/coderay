import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { HubProject, HubProjectState } from '@ide/protocol';
import { busyMessage } from '../project/switch';

export const MAX_OPEN_PROJECTS = 10;
export const START_TIMEOUT_MS = 180_000;
export const STOP_TIMEOUT_MS = 5_000;
export const POLL_MS = 200;
const STDERR_TAIL_CHARS = 2048;
const MAX_ERROR_CHARS = 300;
const SHUTTING_DOWN = 'CodeRay hub is shutting down.';
const CLOSED_EARLY = 'The project was closed before its core started.';

export function projectId(root: string): string {
  return `p${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}

// A spawn failure has no exit code: it carries the error instead.
export type CoreExit = { code: number | null; signal: string | null } | { error: Error };

export interface CoreChild {
  onStderr(listener: (text: string) => void): void;
  // Called once, when the process exits or could not be spawned.
  onExit(listener: (exit: CoreExit) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface SupervisorDeps {
  spawn(request: { root: string; port: number; token: string }): CoreChild;
  freePort(): Promise<number>;
  listens(port: number): Promise<boolean>;
  // The reason another core holds the project, or null when it is free.
  busy(root: string): string | null;
  newToken(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SupervisorLimits {
  maxProjects: number;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  pollMs: number;
}

interface Run {
  child: CoreChild;
  exited: Promise<CoreExit>;
  done: boolean;
  stderr: string;
}

interface Entry {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  state: HubProjectState;
  port: number | null;
  token: string | null;
  error: string | null;
  run: Run | null;
  // Bumped whenever the current child stops mattering (close, restart, timeout, shutdown), so its exit is not reported as a failure.
  generation: number;
  launching: Promise<void>;
  closing: Promise<string | null> | null;
}

export function describeExit(exit: CoreExit, stderr: string): string {
  if ('error' in exit) return `Could not start CodeRay core: ${exit.error.message}`;
  if (exit.code === null) return `CodeRay core stopped unexpectedly (${exit.signal ?? 'unknown signal'}).`;
  const holder = /another CodeRay core \(pid (\d+)\)/.exec(stderr);
  if (holder) return busyMessage(holder[1] ?? '?');
  const reason = stderr
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => line !== '' && !line.startsWith('at ') && /error|fatal|failed/i.test(line))
    .at(-1);
  return reason ? reason.slice(0, MAX_ERROR_CHARS) : `CodeRay core exited (code ${exit.code}).`;
}

export class Supervisor {
  private entries: Entry[] = [];
  private active: string | null = null;
  private shuttingDown = false;
  private readonly listeners: (() => void)[] = [];
  private readonly limits: SupervisorLimits;

  constructor(private readonly deps: SupervisorDeps, limits: Partial<SupervisorLimits> = {}) {
    this.limits = { maxProjects: MAX_OPEN_PROJECTS, startTimeoutMs: START_TIMEOUT_MS, stopTimeoutMs: STOP_TIMEOUT_MS, pollMs: POLL_MS, ...limits };
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  list(): HubProject[] {
    return this.entries.map(({ id, root, name, state, port, token, error }) => ({ id, root, name, state, port, token, error }));
  }

  activeId(): string | null {
    return this.active;
  }

  // `root` must already be a real, absolute folder path. Resolves once the core listens, or with the reason it did not start.
  // `keepIfBusy` keeps a project another core holds as a failed tab (used when reopening the last session) instead of refusing it.
  async open(root: string, { keepIfBusy = false } = {}): Promise<{ id: string; error: string | null }> {
    const id = projectId(root);
    if (this.shuttingDown) return { id, error: SHUTTING_DOWN };
    const existing = this.entries.find((entry) => entry.root === root);
    if (existing?.closing) {
      await existing.closing;
      return this.open(root, { keepIfBusy });
    }
    if (existing) {
      this.activate(existing.id);
      if (existing.state === 'failed') return { id, error: await this.restart(existing.id) };
      await existing.launching;
      return { id, error: this.outcome(existing) };
    }
    if (this.entries.length >= this.limits.maxProjects) {
      return { id, error: `At most ${this.limits.maxProjects} projects can be open at once. Close one first.` };
    }
    const busy = this.deps.busy(root);
    if (busy !== null && !keepIfBusy) return { id, error: busy };
    const entry: Entry = {
      id, root, name: basename(root), state: 'starting', port: null, token: null, error: null, run: null, generation: 0, launching: Promise.resolve(), closing: null,
    };
    this.entries.push(entry);
    this.active = id;
    if (busy !== null) {
      this.fail(entry, busy);
      return { id, error: busy };
    }
    entry.launching = this.launch(entry);
    await entry.launching;
    return { id, error: this.outcome(entry) };
  }

  async restart(id: string): Promise<string | null> {
    const entry = this.find(id);
    if (!entry) return unknownProject(id);
    if (this.shuttingDown) return SHUTTING_DOWN;
    if (entry.closing) return 'That project is closing.';
    if (entry.state !== 'failed') return 'Only a project whose core failed can be restarted.';
    const busy = this.deps.busy(entry.root);
    if (busy !== null) {
      this.fail(entry, busy);
      return busy;
    }
    entry.launching = this.launch(entry);
    await entry.launching;
    return this.outcome(entry);
  }

  close(id: string): Promise<string | null> {
    const entry = this.find(id);
    if (!entry) return Promise.resolve(unknownProject(id));
    entry.closing ??= (async () => {
      entry.generation += 1;
      if (entry.run) await this.stop(entry.run);
      const index = this.entries.indexOf(entry);
      this.entries.splice(index, 1);
      if (this.active === id) this.active = (this.entries[index] ?? this.entries[index - 1])?.id ?? null;
      this.emit();
      return null;
    })();
    return entry.closing;
  }

  activate(id: string): boolean {
    if (!this.find(id)) return false;
    if (this.active !== id) {
      this.active = id;
      this.emit();
    }
    return true;
  }

  // Unknown ids are ignored and projects missing from `ids` keep their relative order after the listed ones.
  setOrder(ids: string[]): void {
    const listed = [...new Set(ids)].flatMap((id) => this.find(id) ?? []);
    const next = [...listed, ...this.entries.filter((entry) => !listed.includes(entry))];
    if (next.every((entry, index) => entry === this.entries[index])) return;
    this.entries = next;
    this.emit();
  }

  // Stops every core but keeps the list, so the hub can reopen the same projects next time.
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.entries.map(async (entry) => {
      entry.generation += 1;
      if (entry.run) await this.stop(entry.run);
      await entry.closing;
    }));
  }

  private find(id: string): Entry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private outcome(entry: Entry): string | null {
    if (!this.entries.includes(entry)) return CLOSED_EARLY;
    if (this.shuttingDown) return SHUTTING_DOWN;
    return entry.state === 'failed' ? entry.error : null;
  }

  private async launch(entry: Entry): Promise<void> {
    entry.generation += 1;
    const generation = entry.generation;
    Object.assign(entry, { state: 'starting', port: null, token: null, error: null });
    this.emit();
    let port: number;
    try {
      port = await this.deps.freePort();
    } catch (error) {
      if (entry.generation === generation) this.fail(entry, `Could not find a free port for CodeRay core: ${(error as Error).message}`);
      return;
    }
    if (entry.generation !== generation) return;
    const token = this.deps.newToken();
    let child: CoreChild;
    try {
      child = this.deps.spawn({ root: entry.root, port, token });
    } catch (error) {
      this.fail(entry, describeExit({ error: error as Error }, ''));
      return;
    }
    const run: Run = { child, done: false, stderr: '', exited: new Promise((resolve) => child.onExit(resolve)) };
    entry.run = run;
    child.onStderr((text) => {
      run.stderr = (run.stderr + text).slice(-STDERR_TAIL_CHARS);
    });
    void run.exited.then((exit) => {
      run.done = true;
      if (entry.run === run) entry.run = null;
      if (entry.generation === generation && !this.shuttingDown) this.fail(entry, describeExit(exit, run.stderr));
    });

    const deadline = this.deps.now() + this.limits.startTimeoutMs;
    while (entry.run === run && entry.generation === generation) {
      if (await this.deps.listens(port)) {
        if (entry.run === run && entry.generation === generation) {
          Object.assign(entry, { state: 'running', port, token });
          this.emit();
        }
        return;
      }
      if (this.deps.now() >= deadline) {
        entry.generation += 1;
        // Stopped before the failure shows, so a restart cannot race the old core for the project lock.
        await this.stop(run);
        if (entry.generation === generation + 1) this.fail(entry, `CodeRay core did not start listening within ${Math.round(this.limits.startTimeoutMs / 1000)} s.`);
        return;
      }
      await Promise.race([this.deps.sleep(this.limits.pollMs), run.exited]);
    }
  }

  private async stop(run: Run): Promise<void> {
    if (run.done) return;
    const exited = run.exited.then(() => true);
    run.child.kill('SIGTERM');
    if (await Promise.race([exited, this.deps.sleep(this.limits.stopTimeoutMs).then(() => false)])) return;
    run.child.kill('SIGKILL');
    await Promise.race([exited, this.deps.sleep(this.limits.stopTimeoutMs)]);
  }

  private fail(entry: Entry, error: string): void {
    Object.assign(entry, { state: 'failed', port: null, token: null, error });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('hub: change listener failed', error);
      }
    }
  }
}

function unknownProject(id: string): string {
  return `There is no open project with id "${id}".`;
}
