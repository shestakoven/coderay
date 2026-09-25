import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord, parseJson } from '../json';

export const REGROUP_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface RegroupNeed {
  hasAiMap: boolean;
  stale: boolean;
  groupable: boolean;
}

export type RegroupOutcome = 'done' | 'failed' | 'cancelled';

export interface RegroupSchedulerOptions {
  regroup: () => Promise<RegroupOutcome>;
  need: () => RegroupNeed;
  isAgentIdle: () => boolean;
  stateFile: string;
  cooldownMs?: number;
}

interface SchedulerState {
  lastEndedAt: number | null;
  startedAt: number | null;
  failures: number;
}

export class RegroupScheduler {
  private readonly options: RegroupSchedulerOptions;
  private readonly cooldownMs: number;
  private state: SchedulerState;
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: RegroupSchedulerOptions) {
    this.options = options;
    this.cooldownMs = options.cooldownMs ?? REGROUP_COOLDOWN_MS;
    const saved = readState(options.stateFile);
    this.state =
      saved.startedAt === null
        ? saved
        : { lastEndedAt: Math.max(saved.lastEndedAt ?? 0, saved.startedAt), startedAt: null, failures: saved.failures };
  }

  evaluate(): void {
    if (this.running || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const { hasAiMap, stale, groupable } = this.options.need();
    if (!groupable) return;
    if (!hasAiMap && this.state.lastEndedAt === null) {
      this.run();
      return;
    }
    if ((hasAiMap && !stale) || !this.options.isAgentIdle()) return;
    const now = Date.now();
    if ((this.state.lastEndedAt ?? 0) > now) this.save({ ...this.state, lastEndedAt: now });
    const wait = (this.state.lastEndedAt ?? 0) + this.delay() - now;
    if (wait <= 0) {
      this.run();
      return;
    }
    this.timer = setTimeout(() => this.evaluate(), wait);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private delay(): number {
    return Math.min(this.cooldownMs * 2 ** Math.max(0, this.state.failures - 1), MAX_BACKOFF_MS);
  }

  private run(): void {
    this.running = true;
    this.save({ ...this.state, startedAt: Date.now() });
    void this.options
      .regroup()
      .catch((error: unknown): RegroupOutcome => {
        console.error('map: regroup failed', error);
        return 'failed';
      })
      .then((outcome) => {
        this.running = false;
        if (outcome === 'cancelled' || this.stopped) return;
        this.save({ lastEndedAt: Date.now(), startedAt: null, failures: outcome === 'done' ? 0 : this.state.failures + 1 });
        this.evaluate();
      });
  }

  private save(state: SchedulerState): void {
    this.state = state;
    const temp = `${this.options.stateFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      mkdirSync(dirname(this.options.stateFile), { recursive: true });
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, this.options.stateFile);
    } catch (error) {
      rmSync(temp, { force: true });
      console.error('map: cannot save the regroup schedule', error);
    }
  }
}

function readState(file: string): SchedulerState {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { lastEndedAt: null, startedAt: null, failures: 0 };
  }
  const json = parseJson(text);
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return isRecord(json)
    ? { lastEndedAt: number(json.lastEndedAt), startedAt: number(json.startedAt), failures: number(json.failures) ?? 0 }
    : { lastEndedAt: null, startedAt: null, failures: 0 };
}
