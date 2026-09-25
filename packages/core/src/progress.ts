import type { MapProgress } from '@ide/protocol';

const INTERVAL_MS = 250;

// The first change goes out at once and later ones at most once per interval, so a scan of thousands of files cannot flood the socket.
export class ProgressReporter {
  private readonly publish: (progress: MapProgress) => void;
  private readonly intervalMs: number;
  private current: MapProgress = { indexing: null, embedding: null };
  private sentAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(publish: (progress: MapProgress) => void, intervalMs = INTERVAL_MS) {
    this.publish = publish;
    this.intervalMs = intervalMs;
  }

  get(): MapProgress {
    return this.current;
  }

  set(change: Partial<MapProgress>): void {
    this.current = { ...this.current, ...change };
    if (this.stopped || this.timer) return;
    const wait = this.sentAt + this.intervalMs - Date.now();
    if (wait <= 0) this.send();
    else this.timer = setTimeout(() => this.send(), wait);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private send(): void {
    this.timer = undefined;
    this.sentAt = Date.now();
    this.publish(this.current);
  }
}
