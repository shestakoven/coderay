import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeView, RevertFile, RevertRecordView, RollbackPreview, StepStatus } from '@ide/protocol';
import type { Store } from '../store/store';
import { rollbackMessage } from '../watchdog/resume';
import type { Baselines } from './baselines';
import type { ChangeService } from './changes';
import type { Checkpoints } from './checkpoints';
import type { IdeWrites } from './ide-writes';
import type { ShadowRepo } from './shadow';

export class RevertError extends Error {}

export interface StepRollbackDeps {
  checkpoints: Checkpoints;
  plans: {
    plans(): { id: string; version: number; status: string; steps: { key: string }[] }[];
    stepStates(): Record<string, Record<string, StepStatus>>;
    resetStep(planId: string, key: string): void;
  };
  isIdle: () => boolean;
  watchdogPending: () => boolean;
  queueNote: (text: string) => void;
}

export interface RevertServiceOptions {
  steps?: StepRollbackDeps;
  root: string;
  shadow: ShadowRepo;
  baselines: Baselines;
  ideWrites: IdeWrites;
  changes: ChangeService;
  store: Store;
  sessionId: () => string | null;
  now?: () => number;
  restoreTimeoutMs?: number;
  beforeCommit?: (rel: string) => Promise<void>;
}

export interface RevertRequest {
  changeIds: string[];
  eventId: string | null;
  kind?: RevertRecordView['kind'];
  planId?: string | null;
  stepKey?: string | null;
}

export interface UndoResult { record: RevertRecordView; files: RevertFile[] }

const CHANGED_AGAIN = "changed again after the agent's change";
const DEFAULT_MODE = 0o644;
const SYMLINK_MODE = 0o120000;
const RESTORE_TIMEOUT_MS = 30_000;
const NOT_UNDOABLE = "the agent's version is not stored, so the revert could not be undone";

const isGitState = (rel: string): boolean => rel === '.git/HEAD' || rel === '.git/refs' || rel.startsWith('.git/refs/');
const conflict = (path: string, reason: string): RevertFile => ({ path, outcome: 'conflict', reason });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Current = { kind: 'absent' } | { kind: 'file'; hash: string } | { kind: 'blocked'; reason: string };

export class RevertService {
  private readonly listeners = new Set<(record: RevertRecordView) => void>();
  private readonly priorModes = new Map<string, Map<string, number>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: RevertServiceOptions) {}

  onChange(listener: (record: RevertRecordView) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reverts(): RevertRecordView[] {
    const sessionId = this.o.sessionId();
    return sessionId === null ? [] : this.o.store.reverts(sessionId);
  }

  revertChanges(request: RevertRequest): Promise<RevertRecordView> {
    return this.serialized(() => this.doRevert(request));
  }

  undo(revertId: string): Promise<UndoResult> {
    return this.serialized(() => this.doUndo(revertId));
  }

  previewStepRollback(planId: string, stepKey: string): Promise<RollbackPreview> {
    return this.serialized(async () => (await this.plan(planId, stepKey)).preview);
  }

  rollbackStep(planId: string, stepKey: string, confirm: string[]): Promise<RevertRecordView> {
    return this.serialized(() => this.doRollback(planId, stepKey, confirm));
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doRevert(request: RevertRequest): Promise<RevertRecordView> {
    const sessionId = this.requireSession();
    const all = this.o.changes.changes();
    const wanted = new Set(request.changeIds);
    const groups = new Map<string, ChangeView[]>();
    for (const change of all) {
      if (!wanted.has(change.id)) continue;
      const group = groups.get(change.path) ?? [];
      group.push(change);
      groups.set(change.path, group);
    }
    const files: RevertFile[] = [];
    const succeeded: string[] = [];
    const modes = new Map<string, number>();
    for (const [rel, group] of groups) {
      let file: RevertFile;
      try {
        file = await this.revertPath(rel, group, all, modes);
      } catch (error) {
        file = conflict(rel, message(error));
      }
      files.push(file);
      if (file.outcome === 'restored' || file.outcome === 'deleted' || file.outcome === 'recreated') succeeded.push(...group.map((c) => c.id));
    }
    const record: RevertRecordView = {
      id: randomUUID(), kind: request.kind ?? 'watchdog', eventId: request.eventId, planId: request.planId ?? null, stepKey: request.stepKey ?? null,
      changeIds: request.changeIds.filter((id) => all.some((c) => c.id === id)), files, ts: (this.o.now ?? Date.now)(), undoneAt: null,
    };
    if (modes.size > 0) this.priorModes.set(record.id, modes);
    this.o.store.saveRevert(sessionId, record);
    if (succeeded.length > 0) this.o.changes.setResolution(succeeded, 'reverted', request.eventId);
    this.emit(record);
    return record;
  }

  private async revertPath(rel: string, group: ChangeView[], all: ChangeView[], modes: Map<string, number>): Promise<RevertFile> {
    const first = group[0]!;
    const last = group.at(-1)!;
    if (isGitState(rel)) return { path: rel, outcome: 'not-rolled-back', reason: 'git state is never rolled back' };
    if (first.unreadable || last.unreadable) return conflict(rel, 'the content could not be read');
    if (first.beforeMode === SYMLINK_MODE) return conflict(rel, 'cannot restore a symlink');
    const firstIndex = all.indexOf(first);
    const lastIndex = all.indexOf(last);
    const selected = new Set(group);
    if (all.some((c, i) => c.path === rel && i >= firstIndex && (i > lastIndex || !selected.has(c)))) return conflict(rel, CHANGED_AGAIN);
    const expected = last.afterHash;
    const target = first.beforeHash;
    const mode = first.beforeMode ?? this.o.baselines.get(rel)?.mode ?? DEFAULT_MODE;
    return this.restoreTo(rel, target, expected, mode, modes);
  }

  private async inspect(rel: string, target: string | null, expected: string | null): Promise<{ reason: string | null; abs: string; current: Current }> {
    const abs = await this.absolute(rel);
    const current = await this.current(abs);
    const blocked = this.mismatch(current, expected);
    if (blocked) return { reason: blocked, abs, current };
    if (target !== null && (await this.o.shadow.read(target)) === null) return { reason: 'content not stored', abs, current };
    if (target !== null && expected !== null && (await this.o.shadow.read(expected)) === null) return { reason: NOT_UNDOABLE, abs, current };
    return { reason: null, abs, current };
  }

  private async restoreTo(rel: string, target: string | null, expected: string | null, mode: number, modes: Map<string, number>): Promise<RevertFile> {
    const seen = await this.inspect(rel, target, expected);
    if (seen.reason) return conflict(rel, seen.reason);
    const outcome = target === null ? 'deleted' : expected === null ? 'recreated' : 'restored';
    const refused = await this.write(rel, seen.abs, target, seen.current, mode & 0o777, modes, expected);
    return refused ? conflict(rel, refused) : { path: rel, outcome, reason: null };
  }

  private async doUndo(revertId: string): Promise<UndoResult> {
    const sessionId = this.requireSession();
    const record = this.o.store.reverts(sessionId).find((r) => r.id === revertId);
    if (!record) throw new RevertError('unknown revert');
    if (record.undoneAt !== null) throw new RevertError('already undone');
    const all = this.o.changes.changes();
    const prior = this.priorModes.get(revertId);
    const files: RevertFile[] = [];
    let undone = 0;
    for (const done of record.files) {
      if (done.outcome === 'conflict' || done.outcome === 'not-rolled-back') {
        files.push(done);
        continue;
      }
      const group = all.filter((c) => c.path === done.path && record.changeIds.includes(c.id));
      let file: RevertFile;
      try {
        file = await this.undoPath(done, group, prior);
      } catch (error) {
        file = conflict(done.path, message(error));
      }
      files.push(file);
      if (file.outcome !== 'conflict') undone++;
    }
    const restoredCount = record.files.filter((f) => f.outcome !== 'conflict' && f.outcome !== 'not-rolled-back').length;
    const next: RevertRecordView = restoredCount === 0 || undone > 0 ? { ...record, undoneAt: (this.o.now ?? Date.now)() } : record;
    if (next !== record) {
      this.o.store.saveRevert(sessionId, next);
      this.emit(next);
    }
    return { record: next, files };
  }

  private async undoPath(done: RevertFile, group: ChangeView[], prior: Map<string, number> | undefined): Promise<RevertFile> {
    const rel = done.path;
    if (group.length === 0) return conflict(rel, CHANGED_AGAIN);
    const first = group[0]!;
    const last = group.at(-1)!;
    const abs = await this.absolute(rel);
    const current = await this.current(abs);
    const blocked = this.mismatch(current, first.beforeHash);
    if (blocked) return conflict(rel, blocked);
    const target = last.afterHash;
    if (target !== null && (await this.o.shadow.read(target)) === null) return conflict(rel, 'content not stored');
    const mode = prior?.get(rel) ?? this.o.baselines.get(rel)?.mode ?? DEFAULT_MODE;
    const refused = await this.write(rel, abs, target, current, mode, new Map(), first.beforeHash);
    if (refused) return conflict(rel, refused);
    return { path: rel, outcome: target === null ? 'deleted' : first.beforeHash === null ? 'recreated' : 'restored', reason: null };
  }

  private mismatch(current: Current, expected: string | null): string | null {
    if (current.kind === 'blocked') return current.reason;
    if (expected === null) return current.kind === 'absent' ? null : CHANGED_AGAIN;
    if (current.kind === 'absent') return 'the file was deleted by someone else';
    return current.hash === expected ? null : CHANGED_AGAIN;
  }

  private async write(rel: string, abs: string, target: string | null, current: Current, mode: number, modes: Map<string, number>, expected: string | null): Promise<string | null> {
    if (current.kind === 'file') {
      const stat = await lstat(abs).catch(() => null);
      if (stat) modes.set(rel, stat.mode & 0o111 ? 0o755 : DEFAULT_MODE);
    }
    if (current.kind === 'absent' && target === null) return null;
    if (current.kind === 'file' && current.hash === target) return null;
    let abandoned = false;
    const guard = async (): Promise<boolean> => {
      if (abandoned) return false;
      await this.o.beforeCommit?.(rel);
      return this.mismatch(await this.current(abs), expected) === null;
    };
    this.o.ideWrites.expect(rel, target);
    const limit = this.o.restoreTimeoutMs ?? RESTORE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), limit); });
    try {
      const result = await Promise.race([this.o.shadow.restore(target, abs, mode, guard), timeout]);
      if (result === 'timeout') {
        abandoned = true;
        return 'timed out';
      }
      if (result === 'missing-blob') return 'content not stored';
      return result === 'changed' ? CHANGED_AGAIN : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async current(abs: string): Promise<Current> {
    const stat = await lstat(abs).catch(() => null);
    if (!stat) return { kind: 'absent' };
    if (stat.isDirectory()) return { kind: 'blocked', reason: 'a directory took its place' };
    if (stat.isSymbolicLink()) return { kind: 'blocked', reason: 'cannot restore a symlink' };
    const blob = await this.o.shadow.hash(abs);
    if (!blob) return { kind: 'blocked', reason: 'the content could not be read' };
    return { kind: 'file', hash: blob.hash };
  }

  private async absolute(rel: string): Promise<string> {
    const plain = join(this.o.root, rel);
    if (!rel.startsWith('.git/')) return plain;
    const dotgit = await lstat(join(this.o.root, '.git')).catch(() => null);
    if (!dotgit || dotgit.isDirectory()) return plain;
    return new Promise((resolve) => {
      execFile('git', ['-C', this.o.root, 'rev-parse', '--path-format=absolute', '--git-path', rel.slice('.git/'.length)], { encoding: 'utf8' }, (error, stdout) => resolve(error ? plain : stdout.trim()));
    });
  }

  private requireSession(): string {
    const sessionId = this.o.sessionId();
    if (sessionId === null) throw new RevertError('no session to record into');
    return sessionId;
  }

  private emit(record: RevertRecordView): void {
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.error('revert: a listener failed', error);
      }
    }
  }

  private async plan(planId: string, stepKey: string): Promise<StepPlan> {
    const deps = this.o.steps;
    if (!deps) throw new RevertError('step rollback is not available');
    const blank = (reason: string | null): StepPlan => ({
      preview: { planId, stepKey, allowed: reason === null, reason, autoFiles: [], confirmFiles: [], notRolledBack: [], conflicts: [] },
      restores: new Map(),
    });
    const plans = deps.plans.plans();
    const versions = plans.filter((plan) => plan.id === planId);
    if (!versions.some((plan) => plan.steps.some((step) => step.key === stepKey))) throw new RevertError('unknown step');
    if (!deps.isIdle()) return blank('the agent is still working');
    if (deps.watchdogPending()) return blank('a watchdog question is open');
    if (plans.at(-1)?.id !== planId || !versions.at(-1)!.steps.some((step) => step.key === stepKey)) return blank('this step belongs to an older version of the plan');
    if (!versions.some((plan) => plan.status === 'approved' || plan.status === 'done')) return blank('the plan is not active');
    if ((deps.plans.stepStates()[planId]?.[stepKey] ?? 'pending') === 'pending') return blank('this step has not run');
    const result = blank(null);
    const cp = deps.checkpoints.manifests(planId, stepKey);
    if (!cp) return result;
    const all = this.o.changes.changes();
    for (const [rel, beforeHash] of Object.entries(cp.before)) {
      const afterHash = cp.after[rel] ?? null;
      const own = all.filter((c) => c.path === rel && c.planId === planId && c.stepKey === stepKey && c.at >= cp.startedAt);
      const first = own[0];
      if (!first) continue;
      if (isGitState(rel)) { result.preview.notRolledBack.push({ path: rel, why: 'git state is never rolled back' }); continue; }
      if (own.some((c) => c.enforcement === 'recorded')) { result.preview.notRolledBack.push({ path: rel, why: 'the IDE only records this file, it cannot restore it' }); continue; }
      if (beforeHash === afterHash) continue;
      const firstAt = all.indexOf(first);
      const ownSet = new Set(own);
      if (all.some((c, i) => c.path === rel && i > firstAt && !ownSet.has(c))) { result.preview.conflicts.push({ path: rel, reason: CHANGED_AGAIN }); continue; }
      if (own.some((c) => c.unreadable)) { result.preview.conflicts.push({ path: rel, reason: 'the content could not be read' }); continue; }
      if (first.beforeMode === SYMLINK_MODE) { result.preview.conflicts.push({ path: rel, reason: 'cannot restore a symlink' }); continue; }
      const seen = await this.inspect(rel, beforeHash, afterHash);
      if (seen.reason) { result.preview.conflicts.push({ path: rel, reason: seen.reason }); continue; }
      const mode = first.beforeMode ?? this.o.baselines.get(rel)?.mode ?? DEFAULT_MODE;
      result.restores.set(rel, { target: beforeHash, expected: afterHash, mode, changeIds: own.map((c) => c.id) });
      (own.every((c) => c.origin === 'agent') ? result.preview.autoFiles : result.preview.confirmFiles).push(rel);
    }
    return result;
  }

  private async doRollback(planId: string, stepKey: string, confirm: string[]): Promise<RevertRecordView> {
    const sessionId = this.requireSession();
    const deps = this.o.steps!;
    const { preview, restores } = await this.plan(planId, stepKey);
    if (!preview.allowed) throw new RevertError(preview.reason ?? 'the step cannot be rolled back');
    const confirmed = new Set(confirm);
    const files: RevertFile[] = [];
    const succeeded: string[] = [];
    const modes = new Map<string, number>();
    for (const rel of [...preview.autoFiles, ...preview.confirmFiles]) {
      if (preview.confirmFiles.includes(rel) && !confirmed.has(rel)) {
        files.push({ path: rel, outcome: 'not-rolled-back', reason: 'not confirmed' });
        continue;
      }
      const plan = restores.get(rel)!;
      let file: RevertFile;
      try {
        file = await this.restoreTo(rel, plan.target, plan.expected, plan.mode, modes);
      } catch (error) {
        file = conflict(rel, message(error));
      }
      files.push(file);
      if (file.outcome === 'restored' || file.outcome === 'deleted' || file.outcome === 'recreated') succeeded.push(...plan.changeIds);
    }
    for (const c of preview.conflicts) files.push(conflict(c.path, c.reason));
    for (const n of preview.notRolledBack) files.push({ path: n.path, outcome: 'not-rolled-back', reason: n.why });
    const record: RevertRecordView = {
      id: randomUUID(), kind: 'step', eventId: null, planId, stepKey, changeIds: succeeded, files, ts: (this.o.now ?? Date.now)(), undoneAt: null,
    };
    if (modes.size > 0) this.priorModes.set(record.id, modes);
    this.o.store.saveRevert(sessionId, record);
    if (succeeded.length > 0) this.o.changes.setResolution(succeeded, 'reverted', null);
    this.emit(record);
    deps.plans.resetStep(planId, stepKey);
    const done = files.filter((f) => f.outcome === 'restored' || f.outcome === 'deleted' || f.outcome === 'recreated').map((f) => f.path);
    const notRestored = files.filter((f) => !done.includes(f.path)).map((f) => ({ path: f.path, reason: f.reason ?? 'not restored' }));
    deps.queueNote(rollbackMessage({ stepKey, restored: done, notRestored }));
    return record;
  }
}

interface StepPlan {
  preview: RollbackPreview;
  restores: Map<string, { target: string | null; expected: string | null; mode: number; changeIds: string[] }>;
}
