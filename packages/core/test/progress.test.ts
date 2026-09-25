import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapProgress } from '@ide/protocol';
import { ProgressReporter } from '../src/progress';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProgressReporter', () => {
  it('sends the first change at once, coalesces changes within the interval, and sends the last state', () => {
    const sent: MapProgress[] = [];
    const progress = new ProgressReporter((current) => sent.push(current), 250);

    progress.set({ indexing: { indexed: 1 } });
    progress.set({ indexing: { indexed: 2 } });
    progress.set({ indexing: { indexed: 3 } });
    expect(sent).toEqual([{ indexing: { indexed: 1 }, embedding: null }]);

    vi.advanceTimersByTime(250);
    expect(sent).toEqual([
      { indexing: { indexed: 1 }, embedding: null },
      { indexing: { indexed: 3 }, embedding: null },
    ]);

    vi.advanceTimersByTime(1000);
    progress.set({ indexing: null });
    expect(sent.at(-1)).toEqual({ indexing: null, embedding: null });
    expect(sent).toHaveLength(3);
  });

  it('keeps the part a change does not mention', () => {
    const progress = new ProgressReporter(() => undefined, 250);
    progress.set({ indexing: { indexed: 5 } });
    progress.set({ embedding: { done: 0, total: 10 } });
    expect(progress.get()).toEqual({ indexing: { indexed: 5 }, embedding: { done: 0, total: 10 } });
  });

  it('sends nothing after stop', () => {
    const sent: MapProgress[] = [];
    const progress = new ProgressReporter((current) => sent.push(current), 250);
    progress.set({ indexing: { indexed: 1 } });
    progress.set({ indexing: { indexed: 2 } });
    progress.stop();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });
});
