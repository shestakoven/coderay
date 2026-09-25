import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGROUP_COOLDOWN_MS, RegroupScheduler, type RegroupNeed, type RegroupOutcome } from '../../src/map/regroup-scheduler';
import { tempDir } from '../helpers';

const MINUTE = 60_000;
const schedulers: RegroupScheduler[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  vi.useRealTimers();
});

interface Setup {
  idle?: boolean;
  outcome?: RegroupOutcome | 'never';
  durationMs?: number;
  stateFile?: string;
}

function setup(need: RegroupNeed, options: Setup = {}) {
  const state = { need, idle: options.idle ?? true, runs: [] as number[] };
  const stateFile = options.stateFile ?? join(tempDir('ide-schedule-'), 'regroup-state.json');
  const scheduler = new RegroupScheduler({
    regroup: async () => {
      state.runs.push(Date.now());
      if (options.outcome === 'never') return new Promise<RegroupOutcome>(() => undefined);
      if (options.durationMs) await new Promise((resolve) => setTimeout(resolve, options.durationMs));
      return options.outcome ?? 'done';
    },
    need: () => state.need,
    isAgentIdle: () => state.idle,
    stateFile,
  });
  schedulers.push(scheduler);
  return { state, scheduler, stateFile };
}

const FIRST = { hasAiMap: false, stale: false, groupable: true };
const STALE = { hasAiMap: true, stale: true, groupable: true };

describe('RegroupScheduler', () => {
  it('starts the first grouping right away, even while the agent works', () => {
    const { state, scheduler } = setup(FIRST, { idle: false });
    scheduler.evaluate();
    expect(state.runs).toHaveLength(1);
  });

  it('leaves a fresh AI map alone', () => {
    const { state, scheduler } = setup({ hasAiMap: true, stale: false, groupable: true });
    scheduler.evaluate();
    expect(state.runs).toEqual([]);
  });

  it('regroups a stale map only once the agent is idle', () => {
    const { state, scheduler } = setup(STALE, { idle: false });
    scheduler.evaluate();
    expect(state.runs).toEqual([]);
    state.idle = true;
    scheduler.evaluate();
    expect(state.runs).toHaveLength(1);
  });

  it('waits a full cooldown after an attempt ends before regrouping a map that stays stale', async () => {
    const { state, scheduler } = setup(STALE, { durationMs: 5 * MINUTE });
    const start = Date.now();
    scheduler.evaluate();
    await vi.advanceTimersByTimeAsync(5 * MINUTE + REGROUP_COOLDOWN_MS - 1000);
    expect(state.runs).toEqual([start]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.runs).toEqual([start, start + 5 * MINUTE + REGROUP_COOLDOWN_MS]);
  });

  it('doubles the wait after each failed attempt', async () => {
    const { state, scheduler } = setup(STALE, { outcome: 'failed' });
    const start = Date.now();
    scheduler.evaluate();
    await vi.advanceTimersByTimeAsync(70 * MINUTE);
    expect(state.runs.map((at) => (at - start) / MINUTE)).toEqual([0, 10, 30, 70]);
  });

  it('remembers the last attempt across restarts', async () => {
    const first = setup(FIRST, { outcome: 'failed' });
    first.scheduler.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    first.scheduler.stop();

    const restarted = setup(FIRST, { stateFile: first.stateFile });
    restarted.scheduler.evaluate();
    expect(restarted.state.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(REGROUP_COOLDOWN_MS);
    expect(restarted.state.runs).toHaveLength(1);
  });

  it('counts an attempt that a restart interrupted as an attempt', async () => {
    const first = setup(FIRST, { outcome: 'never' });
    first.scheduler.evaluate();
    first.scheduler.stop();

    const restarted = setup(FIRST, { stateFile: first.stateFile });
    restarted.scheduler.evaluate();
    expect(restarted.state.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(REGROUP_COOLDOWN_MS);
    expect(restarted.state.runs).toHaveLength(1);
  });

  it('treats a last attempt recorded in the future as one that just ended', async () => {
    const stateFile = join(tempDir('ide-schedule-'), 'regroup-state.json');
    writeFileSync(stateFile, JSON.stringify({ lastEndedAt: Date.now() + 10 * 24 * 60 * MINUTE, startedAt: null, failures: 0 }));
    const { state, scheduler } = setup(STALE, { stateFile });
    scheduler.evaluate();
    await vi.advanceTimersByTimeAsync(REGROUP_COOLDOWN_MS - 1000);
    expect(state.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.runs).toHaveLength(1);
  });

  it('never regroups a project it cannot group', () => {
    const { state, scheduler } = setup({ hasAiMap: false, stale: true, groupable: false });
    scheduler.evaluate();
    expect(state.runs).toEqual([]);
  });
});
