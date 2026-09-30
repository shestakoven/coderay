export type HoldWait = 'released' | 'timeout' | 'aborted';

export class Hold {
  private reasonText: string | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<() => void>();

  hold(reason: string): void {
    this.reasonText = reason;
    this.emit();
  }

  release(): void {
    this.reasonText = null;
    for (const wake of [...this.waiters]) wake();
    this.emit();
  }

  isHeld(): boolean {
    return this.reasonText !== null;
  }

  reason(): string | null {
    return this.reasonText;
  }

  wait(signal: AbortSignal, deadlineMs: number): Promise<HoldWait> {
    if (signal.aborted) return Promise.resolve('aborted');
    if (!this.isHeld()) return Promise.resolve('released');
    return new Promise((resolve) => {
      const finish = (result: HoldWait): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(wake);
        resolve(result);
      };
      const wake = (): void => finish('released');
      const onAbort = (): void => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), deadlineMs);
      timer.unref();
      this.waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  onChange(listener: () => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('hold: a listener threw', error);
      }
    }
  }
}
