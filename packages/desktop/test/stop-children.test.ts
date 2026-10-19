import { describe, expect, it } from 'vitest';
import { createStopper } from '../stop-children.mjs';

const START = 5_000;
const STUBBORN = Number.POSITIVE_INFINITY;
const GONE = -1;
const MAX_SLEEPS = 1_000;

interface Call {
  target: number;
  signal: string | number;
  at: number;
}

// groups/ports map pid -> ms the process keeps running after SIGTERM (STUBBORN ignores it, GONE has already exited).
function setup({
  groups = {},
  ports = {},
  deadlineMs = 10_000,
  pollMs = 100,
}: { groups?: Record<number, number>; ports?: Record<number, number>; deadlineMs?: number; pollMs?: number } = {}) {
  let clock = START;
  let sleeps = 0;
  const linger = new Map<number, number>();
  for (const [pid, ms] of Object.entries(groups)) linger.set(-Number(pid), ms);
  for (const [pid, ms] of Object.entries(ports)) linger.set(Number(pid), ms);
  const live = new Set([...linger].filter(([, ms]) => ms !== GONE).map(([target]) => target));
  const termedAt = new Map<number, number>();
  const calls: Call[] = [];

  const reap = () => {
    for (const target of live) {
      const at = termedAt.get(target);
      if (at !== undefined && clock >= at + (linger.get(target) as number)) live.delete(target);
    }
  };
  const kill = (target: number, signal: string | number) => {
    reap();
    calls.push({ target, signal, at: clock });
    if (!live.has(target)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (signal === 'SIGKILL') live.delete(target);
    else if (signal === 'SIGTERM' && !termedAt.has(target)) termedAt.set(target, clock);
  };
  const sleep = (ms: number) => {
    if (++sleeps > MAX_SLEEPS) throw new Error('runaway poll loop');
    return Promise.resolve().then(() => {
      clock += ms;
    });
  };

  const stopper = createStopper({
    pids: () => Object.keys(groups).map(Number),
    portOwners: () => Object.keys(ports).map(Number),
    sleep,
    kill,
    now: () => clock,
    deadlineMs,
    pollMs,
  });
  return {
    stopper,
    calls,
    sent: (signal: string | number) => calls.filter((call) => call.signal === signal),
    alive: () => {
      reap();
      return [...live];
    },
    elapsed: () => clock - START,
    sleeps: () => sleeps,
  };
}

const targets = (calls: Call[]) => calls.map((call) => call.target);

describe('createStopper', () => {
  it('sends SIGTERM by default, to groups as negative pids and to port owners as positive pids', () => {
    const { stopper, sent } = setup({ groups: { 100: STUBBORN, 200: STUBBORN }, ports: { 300: STUBBORN } });

    expect(stopper.signal()).toEqual([-100, -200, 300]);
    expect(targets(sent('SIGTERM'))).toEqual([-100, -200, 300]);
  });

  it('sends the requested signal and reports only the targets that accepted it', () => {
    const { stopper, calls } = setup({ groups: { 100: STUBBORN, 200: GONE }, ports: { 300: STUBBORN } });

    expect(stopper.signal('SIGHUP')).toEqual([-100, 300]);
    expect(calls.map(({ target, signal }) => [target, signal])).toEqual([
      [-100, 'SIGHUP'],
      [-200, 'SIGHUP'],
      [300, 'SIGHUP'],
    ]);
  });

  it('resolves once the last target has exited, neither earlier nor at the deadline, and never SIGKILLs', async () => {
    const { stopper, sent, alive, elapsed } = setup({ groups: { 100: 150 }, ports: { 300: 250 }, pollMs: 100 });

    await stopper.stop();

    expect(elapsed()).toBe(300);
    expect(alive()).toEqual([]);
    expect(targets(sent('SIGTERM'))).toEqual([-100, 300]);
    expect(sent('SIGKILL')).toEqual([]);
  });

  it('SIGKILLs only the survivors, exactly at the deadline, and spares the ones that exited', async () => {
    const { stopper, sent, alive } = setup({
      groups: { 100: 150, 200: STUBBORN },
      ports: { 300: STUBBORN },
      deadlineMs: 1_000,
      pollMs: 100,
    });

    await stopper.stop();

    const kills = sent('SIGKILL');
    expect(targets(kills)).toEqual([-200, 300]);
    expect(kills.map((call) => call.at - START)).toEqual([1_000, 1_000]);
    expect(alive()).toEqual([]);
  });

  it('returns at once, without polling, when every target is already gone', async () => {
    const { stopper, calls, sleeps, elapsed } = setup({ groups: { 100: GONE }, ports: { 200: GONE } });

    await stopper.stop();

    expect(calls.map(({ target, signal }) => [target, signal])).toEqual([
      [-100, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
    expect(sleeps()).toBe(0);
    expect(elapsed()).toBe(0);
  });

  it('is idempotent: a second stop() returns the same promise and signals nothing new', async () => {
    const { stopper, calls, sent } = setup({ groups: { 100: 150 }, ports: { 300: 150 } });

    const first = stopper.stop();
    expect(stopper.stop()).toBe(first);
    await first;
    const callsAfterFirst = calls.length;
    await stopper.stop();

    expect(calls).toHaveLength(callsAfterFirst);
    expect(targets(sent('SIGTERM'))).toEqual([-100, 300]);
  });
});
