import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeOrigin, ChangeResolution, ChangeView, Policy } from '@ide/protocol';
import { classifyPaths } from '../gate/paths';
import { worktreeOf, type NestedRepo, type WorktreeHit } from '../gate/worktrees';
import type { PlanGate } from '../gate/scope-guard';
import type { BaselineRecord, Store } from '../store/store';
import { isGitState, type ActivityLedger } from '../watchdog/activity';
import type { FsEvent } from '../watchdog/watcher';
import { forgetGoneNested, hashCandidates, knownNested, seedNested, type Baselines, type Drift } from './baselines';
import type { Checkpoints } from './checkpoints';
import type { IdeWrites } from './ide-writes';
import type { ShadowRepo, StoredBlob } from './shadow';

const BATCH_MAX = 500;
const DIFF_CONCURRENCY = 8;
const HASH_CONCURRENCY = 8;
const GRACE_MS = 2_000;
const LINE_COUNT_MAX = 100;
const GIT_BUFFER = 64 * 1024 * 1024;
const KEPT_CHANGES = 10_000;
const SYMLINK_MODE = 0o120000;
const GIT_ENTRY = /^(\d+) (?:blob )?([0-9a-f]{40,64})(?: (\d+))?$/;
// "git add -N" puts the empty blob in the index for a file git does not have yet.
const EMPTY_BLOBS = new Set(['e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813']);
// The ".git" of a worktree below the project is git's link to its repository: reverting it would unhook the worktree.
const GIT_LINK = /\/\.git$/;
// Gitignored files, harness paths (.omc/), submodules and the rest of a worktree beyond the project are not history:
// they only bury the changes worth reviewing.
const UNTRACKED = new Set(['gitignored', 'a harness path', 'inside a submodule', 'outside the project in a nested worktree']);

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
  keptChanges?: number;
  toolStamp?: (toolUseId: string) => Stamp;
  // The files a history call that has ended left changed by git itself; undefined while it runs.
  gitMoved?: (toolUseId: string) => ReadonlySet<string> | undefined;
}

export type Stamp = { planId: string; planVersion: number; stepKey: string | null } | null;

interface Queued {
  event: FsEvent;
  stamp: Stamp;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const git = (root: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: GIT_BUFFER, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const gitBytes = (root: string, args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: GIT_BUFFER, encoding: 'buffer' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const gitWithInput = (root: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, ...args], { maxBuffer: GIT_BUFFER, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

interface GitEntry { sha: string; mode: number }

const entryMode = (mode: string): number => (mode === '100755' ? 0o755 : mode === '120000' ? SYMLINK_MODE : 0o644);

// "<mode> <sha> <stage>\t<path>" (ls-files -s) or "<mode> blob <sha>\t<path>" (ls-tree), NUL-separated.
// Of the index only a merged entry counts: a conflicted file has none, and an intent-to-add one has no content yet.
function parseEntries(out: string, index: boolean): Map<string, GitEntry> {
  const entries = new Map<string, GitEntry>();
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    const head = GIT_ENTRY.exec(record.slice(0, tab));
    if (tab < 0 || !head || head[1] === '160000') continue;
    if (index && ((head[3] ?? '0') !== '0' || EMPTY_BLOBS.has(head[2]!))) continue;
    entries.set(record.slice(tab + 1), { sha: head[2]!, mode: entryMode(head[1]!) });
  }
  return entries;
}

function byRepo(nested: ReadonlyMap<string, WorktreeHit>, rels: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const rel of rels) {
    const repo = nested.get(rel)!.worktreeRoot;
    const group = groups.get(repo);
    if (group) group.push(rel);
    else groups.set(repo, [rel]);
  }
  return groups;
}

// Each nested worktree's own git, asked once for all of its paths in the batch.
async function perRepo(nested: ReadonlyMap<string, WorktreeHit>, rels: string[], args: string[]): Promise<Map<string, GitEntry>> {
  const out = new Map<string, GitEntry>();
  await Promise.all([...byRepo(nested, rels)].map(async ([repo, group]) => {
    const byInner = new Map(group.map((rel) => [nested.get(rel)!.inner, rel]));
    try {
      for (const [inner, entry] of parseEntries(await git(repo, ['--literal-pathspecs', ...args, '--', ...byInner.keys()]), args[0] === 'ls-files')) {
        const rel = byInner.get(inner);
        if (rel !== undefined) out.set(rel, entry);
      }
    } catch {
      // No index or no HEAD yet: the file has no committed version to start from.
    }
  }));
  return out;
}

// The hash git gives each file after its clean filters, as the index has it; none for a repository where that fails.
async function cleanHashes(nested: ReadonlyMap<string, WorktreeHit>, rels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all([...byRepo(nested, rels.filter((rel) => !rel.includes('\n')))].map(async ([repo, group]) => {
    try {
      const hashes = (await gitWithInput(repo, ['hash-object', '--stdin-paths'], `${group.map((rel) => nested.get(rel)!.inner).join('\n')}\n`)).split('\n');
      group.forEach((rel, i) => { if (hashes[i]) out.set(rel, hashes[i]!); });
    } catch {
      // A file gone meanwhile, or a filter that cannot run here: compared by content as it is.
    }
  }));
  return out;
}

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
  // Files of a nested worktree that were there when the IDE first saw it but were not taken as baselines then.
  private readonly unsighted = new Set<string>();
  // HEAD of each nested worktree when the IDE first saw it: its tree is the checkout the IDE found, as git made it.
  private readonly seedHeads = new Map<string, string>();
  private readonly stamps = new Map<string, number>();
  private readonly graceMs: number;
  private draining: Promise<void> | null = null;
  private batching: Promise<void> = Promise.resolve();
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

  // Files of a nested worktree a scan saw for the first time without taking them as baselines.
  markUnsighted(rels: string[]): void {
    for (const rel of rels) if (!this.o.baselines.get(rel)) this.unsighted.add(rel);
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
    // A batch in flight may have attributed its changes before this call's window existed.
    await this.batching;
    this.sync();
    const stamp = this.o.toolStamp?.(toolUseId) ?? this.stampFor();
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
        const processing = this.processBatch(batch);
        this.batching = processing.then(() => undefined, () => undefined);
        try {
          await processing;
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
    const { root, policy, shadow, baselines } = this.o;
    const seen = [...latest.keys()];
    const classified = await classifyPaths(seen.map((rel) => join(root, rel)), { root, policy });
    const gone = forgetGoneNested(root, baselines, (dir) => seen.some((rel) => rel.startsWith(`${dir}/`)));
    const watched = classified.map((info, i) => !UNTRACKED.has(info.why) && !GIT_LINK.test(seen[i]!) && !gone.some((prefix) => seen[i]!.startsWith(prefix)));
    const rels = seen.filter((_, i) => watched[i]);
    const infos = classified.filter((_, i) => watched[i]);
    const enforcedRels = rels.filter((_, i) => infos[i]!.cls === 'enforced');
    const recordedRels = rels.filter((_, i) => infos[i]!.cls !== 'enforced');
    const nested = new Map<string, WorktreeHit>();
    rels.forEach((rel, i) => {
      const hit = infos[i]!.cls === 'enforced' && infos[i]!.scopeRel !== undefined ? worktreeOf(root, rel) : null;
      if (hit) nested.set(rel, hit);
    });
    await this.firstSight(nested);
    const real = await this.gitPaths(rels.filter((rel) => rel.startsWith('.git/')));
    const [enforcedBlobs, recordedBlobs, outerTracked, index] = await Promise.all([
      hashCandidates(root, shadow, enforcedRels, real),
      this.hashOnly(recordedRels, real),
      this.trackedAmong(enforcedRels.filter((rel) => !nested.has(rel))),
      perRepo(nested, [...nested.keys()], ['ls-files', '-c', '-s', '-z']),
    ]);
    const tracked = new Set([...outerTracked, ...index.keys()]);
    const blobs = new Map([...enforcedBlobs.blobs, ...recordedBlobs.blobs]);
    const unreadable = new Set([...enforcedBlobs.unreadable, ...recordedBlobs.unreadable]);
    const unbased = [...nested.keys()].filter((rel) => !baselines.get(rel));
    const inCheckout = await this.inCheckout(unbased.filter((rel) => !this.unsighted.has(rel)), nested);
    const fromGit = await this.gitBefore(unbased.filter((rel) => this.unsighted.has(rel) || inCheckout.has(rel)), nested, index, blobs);
    const seeds: BaselineRecord[] = [];

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
      const base = enforced ? baselines.get(rel) ?? fromGit.get(rel) : undefined;
      // A file that was there before the IDE first saw it, with no version anywhere: whatever it held is not known.
      const existedUnseen = enforced && base === undefined && this.unsighted.has(rel) && blob !== null;
      const beforeHash = enforced ? base?.hash ?? null : this.lastRecorded.get(rel) ?? null;
      const isUnreadable = unreadable.has(rel);
      let afterHash: string | null;
      if (isUnreadable) {
        if (this.unreadableSeen.has(rel)) continue;
        becameUnreadable.push(rel);
        afterHash = beforeHash;
      } else {
        afterHash = blob?.hash ?? null;
        if (afterHash === beforeHash) {
          if (base && fromGit.get(rel) === base) seeds.push(base);
          continue;
        }
      }
      let origin: ChangeOrigin = 'ide';
      let toolUseIds: string[] = [];
      const claimed = !isUnreadable && this.o.ideWrites.claim(rel, afterHash);
      if (claimed) claims.push({ rel, hash: afterHash });
      if (!claimed) {
        const attribution = this.o.ledger.attribute(rel, event.at, { tracked: tracked.has(rel), enforced, deleted: blob === null });
        origin = attribution.origin === 'git' && !this.gitMade(rel, attribution.toolUseIds) ? 'agent-tool' : attribution.origin;
        toolUseIds = attribution.toolUseIds;
      }
      const byAgent = origin === 'agent' || origin === 'agent-tool';
      const flagged = isGitState(rel) && byAgent;
      made.push(this.build({
        path: rel, beforeHash, afterHash, at: event.wall, origin, enforcement: enforced ? 'enforced' : 'recorded', toolUseIds,
        stamp: byAgent ? this.toolStampOf(toolUseIds) ?? stamp : null, resolution: flagged ? 'flagged' : null, stored: enforced && !isUnreadable && (blob?.stored ?? false), unreadable: isUnreadable,
        beforeMode: base?.mode ?? (existedUnseen ? blob.mode : null),
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
    // A nested worktree's file first seen unchanged from its git version is its baseline, not a change.
    if (seeds.length > 0) baselines.setMany(seeds);
    for (const rel of rels) this.unsighted.delete(rel);
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
    this.emit(made);
  }

  private emit(changes: ChangeView[]): void {
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch (error) {
        console.error('changes: a listener failed', error);
      }
    }
  }

  // A file written while a history call ran is git's, unless the call has ended and git did not write it.
  private gitMade(rel: string, toolUseIds: string[]): boolean {
    return isGitState(rel) || toolUseIds.some((id) => this.o.gitMoved?.(id)?.has(rel) ?? true);
  }

  // The changes recorded as git's while the call ran that git turned out not to have written become the agent's.
  async settleGit(toolUseId: string): Promise<void> {
    await this.batching;
    this.sync();
    const stamp = this.o.toolStamp?.(toolUseId) ?? this.stampFor();
    const updated = this.all
      .filter((change) => change.origin === 'git' && change.toolUseIds.includes(toolUseId) && !this.gitMade(change.path, change.toolUseIds))
      .map((change): ChangeView => ({ ...change, origin: 'agent-tool', planId: stamp?.planId ?? null, planVersion: stamp?.planVersion ?? null, stepKey: stamp?.stepKey ?? null }));
    if (updated.length === 0) return;
    this.persistStrict(updated);
    for (const change of updated) this.replace(change);
    this.o.checkpoints.recordMany(updated);
    this.emit(updated);
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

  private toolStampOf(toolUseIds: string[]): Stamp {
    for (const id of toolUseIds) {
      const stamp = this.o.toolStamp?.(id);
      if (stamp) return stamp;
    }
    return null;
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

  // The before-image of a nested worktree's file the IDE has no baseline for: its index version, else its HEAD version.
  private async gitBefore(
    missing: string[], nested: ReadonlyMap<string, WorktreeHit>, index: ReadonlyMap<string, GitEntry>, blobs: ReadonlyMap<string, StoredBlob>,
  ): Promise<Map<string, BaselineRecord>> {
    const out = new Map<string, BaselineRecord>();
    if (missing.length === 0) return out;
    const entries = new Map(missing.flatMap((rel): [string, GitEntry][] => (index.has(rel) ? [[rel, index.get(rel)!]] : [])));
    const unindexed = missing.filter((rel) => !entries.has(rel));
    if (unindexed.length > 0) for (const [rel, entry] of await perRepo(nested, unindexed, ['ls-tree', '-r', '-z', 'HEAD'])) entries.set(rel, entry);
    const regular = [...entries].filter(([rel, entry]) => entry.mode !== SYMLINK_MODE && blobs.has(rel) && blobs.get(rel)!.mode !== SYMLINK_MODE);
    const clean = await cleanHashes(nested, regular.map(([rel]) => rel));
    await mapLimit([...entries], HASH_CONCURRENCY, async ([rel, entry]) => {
      const current = blobs.get(rel);
      // Unchanged since git put it there, judged as git judges it (through its eol, ident and LFS filters).
      if (current && (current.hash === entry.sha || clean.get(rel) === entry.sha)) return void out.set(rel, { path: rel, ...current });
      const hit = nested.get(rel)!;
      const args = entry.mode === SYMLINK_MODE ? ['cat-file', 'blob', entry.sha] : ['cat-file', '--filters', `--path=${hit.inner}`, entry.sha];
      const content = await gitBytes(hit.worktreeRoot, args).catch(() => null);
      const blob = content === null ? null : await this.o.shadow.putContent(content, entry.mode).catch(() => null);
      out.set(rel, blob ? { path: rel, ...blob } : { path: rel, hash: entry.sha, stored: false, size: 0, mode: entry.mode });
    });
    return out;
  }

  // A nested worktree no scan has seen yet: its files are taken as they are now, apart from the ones in this batch.
  private async firstSight(nested: ReadonlyMap<string, WorktreeHit>): Promise<void> {
    const repos = new Map<string, { repo: NestedRepo; pending: Set<string> }>();
    for (const [rel, hit] of nested) {
      const entry = repos.get(hit.dir) ?? { repo: { dir: hit.dir, abs: hit.worktreeRoot }, pending: new Set<string>() };
      entry.pending.add(rel);
      repos.set(hit.dir, entry);
    }
    for (const { repo, pending } of repos.values()) {
      if (knownNested(this.o.baselines, repo)) continue;
      const left = await seedNested(this.o.root, this.o.policy, this.o.shadow, this.o.baselines, repo, pending);
      for (const rel of left) this.unsighted.add(rel);
      const head = await git(repo.abs, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((out) => out.trim(), () => '');
      if (head === '') this.seedHeads.delete(repo.dir);
      else this.seedHeads.set(repo.dir, head);
    }
  }

  // Of files with no baseline, the ones that belong to the checkout the IDE first saw. Any other was written since, and
  // what git holds of it now (a branch checked out, a file staged) is that write, not a version to start from.
  private async inCheckout(rels: string[], nested: ReadonlyMap<string, WorktreeHit>): Promise<Set<string>> {
    const found = new Set<string>();
    const byDir = new Map<string, string[]>();
    for (const rel of rels) {
      const dir = nested.get(rel)!.dir;
      if (this.seedHeads.has(dir)) byDir.set(dir, [...(byDir.get(dir) ?? []), rel]);
    }
    await Promise.all([...byDir].map(async ([dir, group]) => {
      for (const rel of (await perRepo(nested, group, ['ls-tree', '-r', '-z', this.seedHeads.get(dir)!])).keys()) found.add(rel);
    }));
    return found;
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
    const kept = this.o.keptChanges ?? KEPT_CHANGES;
    if (this.all.length <= kept) return;
    let excess = this.all.length - kept;
    this.all = this.all.filter((change) => {
      if (excess === 0 || (change.eventId !== null && change.resolution === null)) return true;
      excess -= 1;
      this.stamps.delete(change.id);
      return false;
    });
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
