import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeOrigin, ChangeResolution, ChangeView, Policy } from '@ide/protocol';
import { classifyPaths } from '../gate/paths';
import type { PlanGate } from '../gate/scope-guard';
import type { BaselineRecord, Store } from '../store/store';
import type { ActivityLedger } from '../watchdog/activity';
import type { FsEvent } from '../watchdog/watcher';
import { hashCandidates, type Baselines, type Drift } from './baselines';
import type { Checkpoints } from './checkpoints';
import type { IdeWrites } from './ide-writes';
import type { ShadowRepo, StoredBlob } from './shadow';

const BATCH_MAX = 500;
const DIFF_CONCURRENCY = 8;
const HASH_CONCURRENCY = 8;
const GRACE_MS = 2_000;
const LINE_COUNT_MAX = 100;
const GIT_BUFFER = 64 * 1024 * 1024;

export interface ChangeServiceOptions {
  root: string;
  policy: Policy;
  shadow: ShadowRepo;
  baselines: Baselines;
  ideWrites: IdeWrites;
  ledger: ActivityLedger;
  plans: { gate(): PlanGate };
  store: Store;
  checkpoints: Checkpoints;
  sessionId: () => string | null;
  graceMs?: number;
}

type Stamp = { planId: string; planVersion: number; stepKey: string | null } | null;

interface Queued {
  event: FsEvent;
  stamp: Stamp;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const isGitState = (rel: string): boolean => rel === '.git/HEAD' || rel === '.git/refs' || rel.startsWith('.git/refs/');

const git = (root: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: GIT_BUFFER, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

export class ChangeService {
  private readonly listeners = new Set<(changes: ChangeView[]) => void>();
  private readonly queue: Queued[] = [];
  private readonly lastRecorded = new Map<string, string | null>();
  private readonly unreadableSeen = new Set<string>();
  private readonly stamps = new Map<string, number>();
  private readonly graceMs: number;
  private draining: Promise<void> | null = null;
  private loadedFor: string | null | undefined = undefined;
  private all: ChangeView[] = [];

  constructor(private readonly o: ChangeServiceOptions) {
    this.graceMs = o.graceMs ?? GRACE_MS;
  }

  onChange(listener: (changes: ChangeView[]) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handle(event: FsEvent): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ event, stamp: this.stampFor(), resolve, reject });
      this.draining ??= this.drain();
    });
  }

  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  changes(): ChangeView[] {
    this.sync();
    return [...this.all];
  }

  humanIn(from: number, to: number): ChangeView[] {
    this.sync();
    return this.all.filter((change) => {
      const at = this.stamps.get(change.id);
      return change.origin === 'human' && at !== undefined && at >= from && at <= to + this.graceMs;
    });
  }

  async reattribute(toolUseId: string, from: number, to: number): Promise<ChangeView[]> {
    this.sync();
    const stamp = this.stampFor();
    const updated: ChangeView[] = [];
    for (const change of this.all) {
      const at = this.stamps.get(change.id);
      if (change.origin !== 'human' || at === undefined || at < from || at > to + this.graceMs) continue;
      updated.push({ ...change, origin: 'agent-tool', toolUseIds: [toolUseId], planId: stamp?.planId ?? null, planVersion: stamp?.planVersion ?? null, stepKey: stamp?.stepKey ?? null });
    }
    this.persistStrict(updated);
    for (const change of updated) this.replace(change);
    this.o.checkpoints.recordMany(updated);
    return updated;
  }

  async recordDrift(drift: Drift[], origin: 'unknown' | 'human'): Promise<ChangeView[]> {
    this.sync();
    const made: ChangeView[] = [];
    const rows: BaselineRecord[] = [];
    const removed: string[] = [];
    for (const d of drift) {
      const change = this.build({
        path: d.path, beforeHash: d.before?.hash ?? null, afterHash: d.after?.hash ?? null, at: Date.now(), origin, enforcement: 'enforced',
        toolUseIds: [], stamp: null, resolution: null, stored: d.after?.stored ?? false, unreadable: false, beforeMode: d.before?.mode ?? null,
      });
      made.push(change);
      if (d.after) rows.push({ path: d.path, hash: d.after.hash, stored: d.after.stored, size: d.after.size, mode: d.after.mode });
      else removed.push(d.path);
    }
    await this.countLines(made, new Map(drift.map((d) => [d.path, { before: d.before?.stored ?? true }])));
    this.persistStrict(made, { rows, removed });
    this.remember(made);
    this.o.baselines.remember(rows, removed);
    return made;
  }

  setResolution(ids: string[], resolution: ChangeResolution, eventId: string | null): void {
    this.sync();
    const wanted = new Set(ids);
    const updated = this.all.filter((c) => wanted.has(c.id)).map((c) => this.replace({ ...c, resolution, eventId }));
    this.persistLoose(updated);
  }

  markOutOfPlan(ids: string[], eventId: string): ChangeView[] {
    this.sync();
    const wanted = new Set(ids);
    const updated = this.all.filter((c) => wanted.has(c.id)).map((c) => this.replace({ ...c, outOfPlan: true, eventId }));
    this.persistLoose(updated);
    return updated;
  }

  relabelHuman(ids: string[]): void {
    this.sync();
    const wanted = new Set(ids);
    const updated = this.all.filter((c) => wanted.has(c.id)).map((c) =>
      this.replace({ ...c, origin: 'human', outOfPlan: false, resolution: 'relabeled-human', toolUseIds: [], planId: null, planVersion: null, stepKey: null }));
    this.persistLoose(updated);
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_MAX);
        try {
          await this.processBatch(batch);
          for (const q of batch) q.resolve();
        } catch (error) {
          for (const q of batch) q.reject(error);
        }
      }
    } finally {
      this.draining = null;
    }
  }

  private async processBatch(queued: Queued[]): Promise<void> {
    this.sync();
    const latest = new Map<string, Queued>();
    for (const q of queued) latest.set(q.event.rel, q);
    const rels = [...latest.keys()];
    const { root, policy, shadow, baselines } = this.o;
    const infos = await classifyPaths(rels.map((rel) => join(root, rel)), { root, policy });
    const enforcedRels = rels.filter((_, i) => infos[i]!.cls === 'enforced');
    const recordedRels = rels.filter((_, i) => infos[i]!.cls !== 'enforced');
    const real = await this.gitPaths(rels.filter((rel) => rel.startsWith('.git/')));
    const [enforcedBlobs, recordedBlobs, tracked] = await Promise.all([
      hashCandidates(root, shadow, enforcedRels, real),
      this.hashOnly(recordedRels, real),
      this.trackedAmong(enforcedRels),
    ]);
    const blobs = new Map([...enforcedBlobs.blobs, ...recordedBlobs.blobs]);
    const unreadable = new Set([...enforcedBlobs.unreadable, ...recordedBlobs.unreadable]);

    const made: ChangeView[] = [];
    const checks = new Map<string, { before: boolean }>();
    const rows: BaselineRecord[] = [];
    const removed: string[] = [];
    const claims: { rel: string; hash: string | null }[] = [];
    const recorded = new Map<string, string | null>();
    const becameUnreadable: string[] = [];
    const newStamps = new Map<string, number>();
    for (const rel of rels) {
      const { event, stamp } = latest.get(rel)!;
      const enforced = enforcedRels.includes(rel);
      const blob = blobs.get(rel) ?? null;
      const base = enforced ? baselines.get(rel) : undefined;
      const beforeHash = enforced ? base?.hash ?? null : this.lastRecorded.get(rel) ?? null;
      const isUnreadable = unreadable.has(rel);
      let afterHash: string | null;
      if (isUnreadable) {
        if (this.unreadableSeen.has(rel)) continue;
        becameUnreadable.push(rel);
        afterHash = beforeHash;
      } else {
        afterHash = blob?.hash ?? null;
        if (afterHash === beforeHash) continue;
      }
      let origin: ChangeOrigin = 'ide';
      let toolUseIds: string[] = [];
      const claimed = !isUnreadable && this.o.ideWrites.claim(rel, afterHash);
      if (claimed) claims.push({ rel, hash: afterHash });
      if (!claimed) {
        const attribution = this.o.ledger.attribute(rel, event.at, { tracked: tracked.has(rel), enforced });
        origin = attribution.origin;
        toolUseIds = attribution.toolUseIds;
      }
      const byAgent = origin === 'agent' || origin === 'agent-tool';
      const flagged = isGitState(rel) && byAgent;
      made.push(this.build({
        path: rel, beforeHash, afterHash, at: event.wall, origin, enforcement: enforced ? 'enforced' : 'recorded', toolUseIds,
        stamp: byAgent ? stamp : null, resolution: flagged ? 'flagged' : null, stored: enforced && !isUnreadable && (blob?.stored ?? false), unreadable: isUnreadable, beforeMode: base?.mode ?? null,
      }));
      newStamps.set(made.at(-1)!.id, event.at);
      if (isUnreadable) continue;
      if (!enforced) {
        recorded.set(rel, afterHash);
        continue;
      }
      checks.set(rel, { before: base?.stored ?? true });
      if (blob) rows.push({ path: rel, hash: blob.hash, stored: blob.stored, size: blob.size, mode: blob.mode });
      else removed.push(rel);
    }
    if (made.length === 0) return;
    try {
      await this.countLines(made, checks);
      this.persistStrict(made, { rows, removed });
    } catch (error) {
      for (const claim of claims) this.o.ideWrites.expect(claim.rel, claim.hash);
      throw error;
    }
    this.remember(made);
    for (const [id, at] of newStamps) this.stamps.set(id, at);
    for (const [rel, hash] of recorded) this.lastRecorded.set(rel, hash);
    for (const rel of becameUnreadable) this.unreadableSeen.add(rel);
    for (const rel of rels) if (!unreadable.has(rel)) this.unreadableSeen.delete(rel);
    baselines.remember(rows, removed);
    this.o.checkpoints.recordMany(made);
    for (const listener of this.listeners) {
      try {
        listener(made);
      } catch (error) {
        console.error('changes: a listener failed', error);
      }
    }
  }

  private build(o: {
    path: string; beforeHash: string | null; afterHash: string | null; at: number; origin: ChangeOrigin; enforcement: 'enforced' | 'recorded';
    toolUseIds: string[]; stamp: Stamp; resolution: ChangeResolution | null;
    stored: boolean; unreadable: boolean; beforeMode: number | null;
  }): ChangeView {
    return {
      id: randomUUID(), path: o.path, beforeHash: o.beforeHash, afterHash: o.afterHash, at: o.at, origin: o.origin, enforcement: o.enforcement,
      outOfPlan: false, toolUseIds: o.toolUseIds, planId: o.stamp?.planId ?? null, planVersion: o.stamp?.planVersion ?? null,
      stepKey: o.stamp?.stepKey ?? null, eventId: null, resolution: o.resolution, added: null, removed: null, stored: o.stored, unreadable: o.unreadable, beforeMode: o.beforeMode,
    };
  }

  private stampFor(): Stamp {
    const gate = this.o.plans.gate();
    return gate.state === 'approved' ? { planId: gate.planId, planVersion: gate.version, stepKey: gate.activeStep } : null;
  }

  private async countLines(changes: ChangeView[], checks: Map<string, { before: boolean }>): Promise<void> {
    if (changes.filter((c) => c.enforcement === 'enforced').length > LINE_COUNT_MAX) return;
    const todo = changes.filter((c) => c.enforcement === 'enforced' && !c.unreadable && (c.afterHash === null || c.stored) && checks.get(c.path)?.before !== false);
    await mapLimit(todo, DIFF_CONCURRENCY, async (change) => {
      const diff = await this.o.shadow.diff(change.beforeHash, change.afterHash);
      if (diff.binary || diff.missing) return;
      change.added = diff.added;
      change.removed = diff.removed;
    });
  }

  private async hashOnly(rels: string[], real: ReadonlyMap<string, string>): Promise<{ blobs: Map<string, StoredBlob>; unreadable: string[] }> {
    const blobs = new Map<string, StoredBlob>();
    const unreadable: string[] = [];
    await mapLimit(rels, HASH_CONCURRENCY, async (rel) => {
      const abs = real.get(rel) ?? join(this.o.root, rel);
      const blob = await this.o.shadow.hash(abs);
      if (blob) {
        blobs.set(rel, blob);
        return;
      }
      const stat = await lstat(abs).catch(() => null);
      if (stat && (stat.isFile() || stat.isSymbolicLink())) unreadable.push(rel);
    });
    return { blobs, unreadable };
  }

  private async trackedAmong(rels: string[]): Promise<Set<string>> {
    if (rels.length === 0) return new Set();
    try {
      const out = await git(this.o.root, ['--literal-pathspecs', 'ls-files', '-c', '-z', '--', ...rels]);
      return new Set(out.split('\0').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private async gitPaths(rels: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (rels.length === 0) return out;
    const dotgit = await lstat(join(this.o.root, '.git')).catch(() => null);
    if (!dotgit || dotgit.isDirectory()) return out;
    for (const rel of rels) {
      try {
        out.set(rel, (await git(this.o.root, ['rev-parse', '--path-format=absolute', '--git-path', rel.slice('.git/'.length)])).trim());
      } catch {
        continue;
      }
    }
    return out;
  }

  private sync(): void {
    const sessionId = this.o.sessionId();
    if (sessionId === this.loadedFor) return;
    this.loadedFor = sessionId;
    this.all = sessionId === null ? [] : this.o.store.changes(sessionId);
    this.stamps.clear();
  }

  private remember(made: ChangeView[]): void {
    this.all.push(...made);
  }

  private replace(next: ChangeView): ChangeView {
    const i = this.all.findIndex((c) => c.id === next.id);
    if (i >= 0) this.all[i] = next;
    return next;
  }

  private persistStrict(changes: ChangeView[], baselines?: { rows: BaselineRecord[]; removed: string[] }): void {
    const sessionId = this.o.sessionId();
    if (sessionId === null) throw new Error('changes: no session to record into');
    if (changes.length > 0) this.o.store.saveChanges(sessionId, changes, baselines);
  }

  private persistLoose(changes: ChangeView[]): void {
    try {
      const sessionId = this.o.sessionId();
      if (sessionId !== null && changes.length > 0) this.o.store.saveChanges(sessionId, changes);
    } catch (error) {
      console.error('changes: could not save changes', error);
    }
  }
}
