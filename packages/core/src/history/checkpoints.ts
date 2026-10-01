import type { ChangeView, CheckpointView } from '@ide/protocol';
import type { CheckpointRecord, Store } from '../store/store';

export class Checkpoints {
  private loadedFor: string | null | undefined = undefined;
  private records: CheckpointRecord[] = [];

  constructor(
    private readonly store: Store,
    private readonly sessionId: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  begin(planId: string, key: string): void {
    this.load();
    const cycle = Math.max((this.latest(planId, key)?.cycle ?? -1) + 1, this.storedCycle(planId, key));
    const record: CheckpointRecord = { planId, stepKey: key, cycle, before: {}, after: {}, startedAt: this.now(), sealedAt: null };
    this.records.push(record);
    this.save(record);
  }

  record(change: ChangeView): void {
    this.recordMany([change]);
  }

  recordMany(changes: ChangeView[]): void {
    this.load();
    const touched = new Set<CheckpointRecord>();
    for (const change of changes) {
      if (change.planId === null || change.stepKey === null) continue;
      const record = this.latest(change.planId, change.stepKey);
      if (!record || record.sealedAt !== null) continue;
      if (!(change.path in record.before)) record.before[change.path] = change.beforeHash;
      record.after[change.path] = change.afterHash;
      touched.add(record);
    }
    for (const record of touched) this.save(record);
  }

  seal(planId: string, key: string): void {
    this.load();
    const record = this.latest(planId, key);
    if (!record || record.sealedAt !== null) return;
    record.sealedAt = this.now();
    this.save(record);
  }

  manifests(planId: string, key: string): CheckpointRecord | undefined {
    this.load();
    return this.latest(planId, key);
  }

  views(): CheckpointView[] {
    this.load();
    return this.records.map((record) => ({
      planId: record.planId, stepKey: record.stepKey, cycle: record.cycle, before: Object.keys(record.before).length,
      after: record.sealedAt === null ? null : Object.keys(record.after).length, startedAt: record.startedAt, sealedAt: record.sealedAt,
    }));
  }

  private storedCycle(planId: string, key: string): number {
    try {
      return this.store.stepCycle(planId, key);
    } catch (error) {
      console.error('checkpoints: could not read the step cycle', error);
      return 0;
    }
  }

  private latest(planId: string, key: string): CheckpointRecord | undefined {
    return this.records.findLast((record) => record.planId === planId && record.stepKey === key);
  }

  private load(): void {
    const sessionId = this.sessionId();
    if (sessionId === this.loadedFor) return;
    this.loadedFor = sessionId;
    this.records = sessionId === null ? [] : this.store.checkpoints(sessionId);
  }

  private save(record: CheckpointRecord): void {
    const sessionId = this.sessionId();
    if (sessionId === null) return;
    try {
      this.store.saveCheckpoint(sessionId, record);
    } catch (error) {
      console.error('checkpoints: could not save a manifest', error);
    }
  }
}
