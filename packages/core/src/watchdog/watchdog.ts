import { randomUUID } from 'node:crypto';
import type { ChangeView, ControlMode, EventResolution, FileAnswer, Policy, WatchdogAnswer, WatchdogEventView, WatchdogKind, WatchdogToolCall } from '@ide/protocol';
import type { Hold } from '../gate/hold';
import type { HookGate } from '../gate/hook-gate';
import type { PlanGate } from '../gate/scope-guard';
import { covers } from '../gate/scope';
import type { ChangeService } from '../history/changes';
import type { RevertService } from '../history/revert';
import type { ShadowRepo } from '../history/shadow';
import type { PlanService } from '../plans/plan-service';
import type { Store } from '../store/store';
import { resumeMessage, type ResumeInput } from './resume';

const SETTLE_MS = 1_000;
const DELIVER_WAIT_MS = 10_000;

export class WatchdogError extends Error {}

export interface WatchdogSession {
  hasOpenTurn(): boolean;
  runningSubagents(): number;
  runningSubagentNames(): string[];
  runningShell(): boolean;
  processAlive(): boolean;
  interrupt(): boolean;
  send(text: string): void;
  sendAbsorbed(text: string): void;
  queueNote(text: string): void;
  lastMessage(): string | null;
  onTurnClosed(listener: () => void): () => boolean;
}

export interface WatchdogOptions {
  store: Store;
  sessionId: () => string | null;
  session: WatchdogSession;
  hold: Hold;
  shadow: ShadowRepo;
  root: string;
  plans: Pick<PlanService, 'gate' | 'canExpand' | 'expand'>;
  changes: ChangeService;
  reverts: Pick<RevertService, 'revertChanges'>;
  gate: Pick<HookGate, 'withdrawPending'>;
  policy: () => Policy;
  toolInfo: (toolUseId: string) => { tool: string; summary: string; stepKey: string | null } | undefined;
  settleMs?: number;
  deliverWaitMs?: number;
  now?: () => number;
  newId?: () => string;
}

const FILE_ANSWERS: ReadonlySet<string> = new Set(['keep', 'revert', 'mine']);
const ANSWERS: ReadonlySet<string> = new Set([...FILE_ANSWERS, 'expand-plan']);
const RESOLUTION: Record<FileAnswer | 'expand-plan', EventResolution> = {
  keep: 'kept', revert: 'reverted', mine: 'relabeled-human', 'expand-plan': 'plan-expanded',
};
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isGitState = (rel: string): boolean => rel === '.git/HEAD' || rel === '.git/refs' || rel.startsWith('.git/refs/');
const insideProject = (rel: string): boolean => rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel);

export class Watchdog {
  private readonly listeners = new Set<(event: WatchdogEventView) => void>();
  private readonly all: WatchdogEventView[] = [];
  private open: WatchdogEventView | null = null;
  private readonly notes = new Map<string, string[]>();
  private flagged: { event: WatchdogEventView; at: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settling: Promise<void> | null = null;
  private readonly answering = new Set<string>();
  private readonly subagentNames = new Map<string, string[]>();
  private readonly killed = new Map<string, string[]>();
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: WatchdogOptions) {
    this.settleMs = o.settleMs ?? SETTLE_MS;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? randomUUID;
  }

  onChange(listener: (event: WatchdogEventView) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(): WatchdogEventView[] {
    return this.all.map((event) => ({ ...event }));
  }

  isPending(): boolean {
    return this.all.some((event) => event.phase !== 'resolved');
  }

  close(eventId: string, resolution: EventResolution): void {
    const event = this.all.find((e) => e.id === eventId);
    if (!event || event.phase === 'resolved') return;
    if (this.open?.id === eventId) {
      this.open = null;
      this.clearTimer();
    }
    event.phase = 'resolved';
    event.resolution = resolution;
    event.resolvedAt = this.now();
    this.persist(event);
    this.emit(event);
  }

  stopAgent(eventId: string): void {
    const event = this.all.find((e) => e.id === eventId);
    if (!event || event.phase === 'resolved') throw new WatchdogError('That question is no longer open.');
    if (event.interrupted) return;
    this.step(event, 'interrupt the agent', () => { event.interrupted = this.interrupt(event); });
    if (!event.interrupted) return;
    this.persist(event);
    this.emit(event);
  }

  private interrupt(event: WatchdogEventView): boolean {
    let names = this.subagentNames.get(event.id) ?? [];
    try {
      names = this.o.session.runningSubagentNames();
    } catch (error) {
      console.error('watchdog: could not read the running subagents', error);
    }
    const interrupted = this.o.session.interrupt();
    if (interrupted) this.killed.set(event.id, names);
    return interrupted;
  }

  async answer(eventId: string, answer: WatchdogAnswer): Promise<void> {
    const event = this.all.find((e) => e.id === eventId);
    if (!event) throw new WatchdogError('That question does not exist.');
    if (this.answering.has(eventId)) throw new WatchdogError('That question is already being answered.');
    if (event.phase !== 'pending') throw new WatchdogError('That question is not waiting for an answer.');
    this.answering.add(eventId);
    try {
      await this.apply(event, answer);
    } finally {
      this.answering.delete(eventId);
    }
  }

  private decide(event: WatchdogEventView, answer: WatchdogAnswer): Map<string, FileAnswer | 'expand-plan'> {
    const paths = [...new Set(event.changes.map((c) => c.path))];
    const decisions = new Map<string, FileAnswer | 'expand-plan'>();
    if (answer.kind === 'all') {
      if (!ANSWERS.has(answer.answer)) throw new WatchdogError('That answer is not one of keep, revert, mine or expand-plan.');
      if (answer.answer === 'expand-plan' && !event.canExpand) throw new WatchdogError('The plan cannot be expanded for these files.');
      for (const path of paths) decisions.set(path, answer.answer);
    } else {
      for (const [path, value] of Object.entries(answer.files)) {
        if (!paths.includes(path)) throw new WatchdogError(`${path} is not one of the files in this question.`);
        if (!FILE_ANSWERS.has(value)) throw new WatchdogError(`${value} is not one of keep, revert or mine.`);
      }
      for (const path of paths) decisions.set(path, Object.hasOwn(answer.files, path) ? answer.files[path]! : 'keep');
    }
    for (const [path, value] of decisions) {
      if (isGitState(path) && value !== 'keep') throw new WatchdogError(`${path} can only be kept: the IDE does not roll back git state.`);
    }
    return decisions;
  }

  private async apply(event: WatchdogEventView, answer: WatchdogAnswer): Promise<void> {
    const decisions = this.decide(event, answer);
    const pathsOf = (what: FileAnswer | 'expand-plan'): string[] => [...decisions].filter(([, v]) => v === what).map(([path]) => path);
    const idsOf = (paths: string[]): string[] => event.changes.filter((c) => paths.includes(c.path)).map((c) => c.id);
    const input: ResumeInput = {
      kept: pathsOf('keep'), reverted: [], added: pathsOf('expand-plan'), mine: pathsOf('mine'), conflicts: [],
      interrupted: event.interrupted, killedSubagents: event.interrupted ? this.killed.get(event.id) ?? [] : [],
      backgroundShell: event.backgroundShell, unknownOrigin: event.unknownOrigin, failOpen: event.kind === 'fail-open',
    };
    const revertPaths = pathsOf('revert');
    if (revertPaths.length > 0) {
      const record = await this.o.reverts.revertChanges({ changeIds: idsOf(revertPaths), eventId: event.id });
      for (const file of record.files) {
        if (file.outcome === 'restored' || file.outcome === 'deleted' || file.outcome === 'recreated') input.reverted.push(file.path);
        else input.conflicts.push({ path: file.path, reason: file.reason ?? file.outcome });
      }
    }
    if (input.mine.length > 0) this.o.changes.relabelHuman(idsOf(input.mine));
    if (input.kept.length > 0) this.o.changes.setResolution(idsOf(input.kept), 'kept', event.id);
    if (input.added.length > 0) {
      try {
        this.o.plans.expand(input.added.map((path) => this.expandTarget(event, path)));
      } catch (error) {
        throw new WatchdogError(`Could not expand the plan: ${describe(error)}`);
      }
      this.o.changes.setResolution(idsOf(input.added), 'plan-expanded', event.id);
    }
    const unrestored = new Set(input.conflicts.map((c) => c.path));
    if (unrestored.size > 0) this.o.changes.setResolution(idsOf([...unrestored]), 'kept', event.id);
    const resolutions = new Set([...decisions].map(([path, v]) => (unrestored.has(path) ? RESOLUTION.keep : RESOLUTION[v])));
    const resolution: EventResolution = resolutions.size === 1 ? [...resolutions][0]! : resolutions.size === 0 ? (answer.kind === 'all' ? RESOLUTION[answer.answer] : 'kept') : 'mixed';
    this.step(event, 'refresh the changes', () => { event.changes = event.changes.map((c) => this.fresh(c)); });
    if (input.conflicts.length > 0) {
      event.reason = [event.reason, `Not restored: ${input.conflicts.map((c) => `${c.path} (${c.reason})`).join('; ')}`].filter(Boolean).join('\n');
    }
    this.close(event.id, resolution);
    try {
      await this.deliver(event, resumeMessage(input), input.reverted.length + input.added.length + input.mine.length + input.conflicts.length > 0);
    } catch (error) {
      console.error('watchdog: could not tell the agent', error);
      event.reason = [event.reason, `Could not tell the agent: ${describe(error)}`].filter(Boolean).join('\n');
      this.persist(event);
      this.emit(event);
    } finally {
      this.o.hold.release();
    }
  }

  private expandTarget(event: WatchdogEventView, path: string): { rel: string; exists: boolean; dir: boolean; deleted: boolean } {
    const own = event.changes.filter((c) => c.path === path);
    const deleted = own.at(-1)!.afterHash === null && !own.at(-1)!.unreadable;
    return { rel: path, exists: deleted || own[0]!.beforeHash !== null, dir: false, deleted };
  }

  private async deliver(event: WatchdogEventView, text: string, changed: boolean): Promise<void> {
    const { session } = this.o;
    if (!event.interrupted && !changed) return;
    if (!session.processAlive()) return session.queueNote(text);
    if (event.interrupted) {
      if (!(await this.turnClosed()) || !session.processAlive()) return session.queueNote(text);
      return this.orQueue(() => session.send(text), text);
    }
    if (session.hasOpenTurn()) return this.orQueue(() => session.sendAbsorbed(text), text);
    session.queueNote(text);
  }

  private orQueue(deliver: () => void, text: string): void {
    try {
      deliver();
    } catch (error) {
      this.o.session.queueNote(text);
      throw error;
    }
  }

  private turnClosed(): Promise<boolean> {
    const { session } = this.o;
    if (!session.hasOpenTurn()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const off = session.onTurnClosed(() => { clearTimeout(timer); off(); resolve(true); });
      const timer = setTimeout(() => { off(); resolve(false); }, this.o.deliverWaitMs ?? DELIVER_WAIT_MS);
      timer.unref?.();
    });
  }

  consider(change: ChangeView): void {
    try {
      const byAgent = change.origin === 'agent' || change.origin === 'agent-tool';
      if (byAgent && isGitState(change.path)) return this.flag(change, false);
      if (change.origin !== 'agent-tool' || change.enforcement !== 'enforced') return;
      let note: string | null = null;
      let outOfPlan = true;
      try {
        outOfPlan = this.isOutOfPlan(change);
      } catch (error) {
        note = `Could not check the plan: ${describe(error)}`;
        console.error('watchdog: could not check the plan', error);
      }
      if (!outOfPlan) return;
      if (this.mode() === 'C') return this.flag(change, true, note);
      const event = this.open ?? this.begin();
      if (note) this.note(event, note);
      this.join(event, change);
    } catch (error) {
      console.error('watchdog: could not handle a change', error);
    }
  }

  raiseFailOpen(toolUseId: string, changes: ChangeView[], failure?: string): void {
    try {
      const notes: string[] = failure ? [failure] : [];
      const out = changes.filter((change) => {
        if (change.enforcement !== 'enforced' || isGitState(change.path)) return false;
        try {
          return this.isOutOfPlan(change);
        } catch (error) {
          notes.push(`Could not check the plan: ${describe(error)}`);
          console.error('watchdog: could not check the plan', error);
          return true;
        }
      });
      if (out.length === 0 || this.mode() === 'C') return this.flagFailOpen(toolUseId, changes, out.length > 0, notes);
      const event = this.open ?? this.begin('fail-open');
      event.kind = 'fail-open';
      this.note(event, `The hook did not judge call ${toolUseId}.`);
      for (const note of notes) this.note(event, note);
      for (const change of out) this.join(event, change);
    } catch (error) {
      console.error('watchdog: could not raise a fail-open event', error);
    }
  }

  raiseUnknown(changes: ChangeView[]): void {
    try {
      if (changes.length === 0) return;
      const event: WatchdogEventView = {
        id: this.newId(), kind: 'watchdog', mode: this.mode(), phase: 'pending', resolution: 'pending', changes: [], toolCalls: [],
        interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: true,
        snapshotSha: null, canExpand: false, defaultAction: null,
        reason: 'These files changed while the IDE was not running; it does not know who changed them.', ts: this.now(), resolvedAt: null,
      };
      this.all.push(event);
      this.step(event, 'store the decision', () => { this.o.changes.markOutOfPlan(changes.map((c) => c.id), event.id); });
      event.changes = changes.map((change) => this.fresh(change));
      this.persist(event);
      this.emit(event);
    } catch (error) {
      console.error('watchdog: could not raise an unknown-origin event', error);
    }
  }

  restore(): void {
    let stored: WatchdogEventView[] = [];
    try {
      const sessionId = this.o.sessionId();
      if (sessionId !== null) stored = this.o.store.watchdogEvents(sessionId);
    } catch (error) {
      console.error('watchdog: could not load the stored events', error);
      return;
    }
    for (const event of stored) {
      if (this.all.some((e) => e.id === event.id)) continue;
      this.all.push(event);
      if (event.phase === 'resolved') continue;
      event.phase = 'pending';
      event.paused = false;
      this.persist(event);
      this.emit(event);
    }
  }

  private flagFailOpen(toolUseId: string, changes: ChangeView[], outOfPlan: boolean, notes: string[]): void {
    const at = this.now();
    const event: WatchdogEventView = {
      id: this.newId(), kind: 'fail-open', mode: this.mode(), phase: 'resolved', resolution: 'flagged', changes: [], toolCalls: [],
      interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: false,
      snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: at, resolvedAt: at,
    };
    this.all.push(event);
    this.note(event, `The hook did not judge call ${toolUseId}.`);
    for (const note of notes) this.note(event, note);
    const ids = changes.map((change) => change.id);
    if (ids.length > 0) {
      if (outOfPlan) this.step(event, 'store the decision', () => this.o.changes.markOutOfPlan(ids, event.id));
      this.step(event, 'store the resolution', () => this.o.changes.setResolution(ids, 'flagged', event.id));
    }
    event.changes = changes.map((change) => this.fresh(change));
    this.fill(event);
    event.canExpand = false;
    event.defaultAction = null;
    this.persist(event);
    this.emit(event);
  }

  private mode(): ControlMode {
    try {
      return this.o.policy().mode;
    } catch (error) {
      console.error('watchdog: could not read the policy', error);
      return 'B';
    }
  }

  private isOutOfPlan(change: ChangeView): boolean {
    const gate: PlanGate = this.o.plans.gate();
    if (gate.state !== 'approved') return true;
    return !covers(gate.scope, { rel: change.path, dir: false, mkdir: false, deleting: change.afterHash === null && !change.unreadable });
  }

  private begin(kind: WatchdogKind = 'watchdog'): WatchdogEventView {
    const { hold, session } = this.o;
    hold.hold('the watchdog is waiting for the user');
    const event: WatchdogEventView = {
      id: this.newId(), kind, mode: this.mode(), phase: 'collecting', resolution: 'pending', changes: [], toolCalls: [],
      interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: false,
      snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: this.now(), resolvedAt: null,
    };
    this.open = event;
    this.all.push(event);
    this.arm(event);
    this.step(event, 'read the running subagents', () => {
      event.runningSubagents = session.runningSubagents();
      event.paused = event.runningSubagents > 0;
      this.subagentNames.set(event.id, session.runningSubagentNames());
    });
    this.step(event, 'withdraw the open prompts', () => this.o.gate.withdrawPending('the watchdog opened an event'));
    this.step(event, 'interrupt the agent', () => {
      if (session.hasOpenTurn() && !event.paused) event.interrupted = this.interrupt(event);
    });
    return event;
  }

  private join(event: WatchdogEventView, change: ChangeView): void {
    if (!event.changes.some((c) => c.id === change.id)) {
      this.step(event, 'store the decision', () => { this.o.changes.markOutOfPlan([change.id], event.id); });
      event.changes = [...event.changes, this.fresh(change)];
    }
    if (event.phase === 'collecting') {
      this.arm(event);
    } else if (event.phase === 'pending') {
      this.fill(event);
      this.persist(event);
    }
    this.emit(event);
  }

  private step(event: WatchdogEventView, what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`watchdog: could not ${what}`, error);
      this.note(event, `Could not ${what}: ${describe(error)}`);
    }
  }

  private note(event: WatchdogEventView, text: string): void {
    this.notes.set(event.id, [...(this.notes.get(event.id) ?? []), text]);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(event: WatchdogEventView): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = (): Promise<void> => this.settle(event).catch((error) => console.error('watchdog: settle failed', error));
      this.settling = (this.settling ?? Promise.resolve()).then(run);
    }, this.settleMs);
    this.timer.unref?.();
  }

  private async settle(event: WatchdogEventView): Promise<void> {
    if (event.phase === 'resolved') return;
    let sha: string | null = null;
    try {
      sha = await this.o.shadow.snapshot(event.id, event.changes.map((c) => ({ path: c.path, hash: c.afterHash })));
    } catch (error) {
      this.note(event, `Could not snapshot the files: ${describe(error)}`);
    }
    if (this.all.find((e) => e.id === event.id)?.phase === 'resolved') return;
    if (sha !== null) event.snapshotSha = sha;
    this.step(event, 'refresh the changes', () => { event.changes = event.changes.map((c) => this.fresh(c)); });
    event.phase = 'pending';
    this.fill(event);
    this.persist(event);
    this.emit(event);
  }

  private fill(event: WatchdogEventView): void {
    const { session, plans, toolInfo } = this.o;
    const calls = new Map<string, WatchdogToolCall>();
    this.step(event, 'read the tool calls', () => {
      for (const change of event.changes) {
        for (const toolUseId of change.toolUseIds) {
          const info = toolInfo(toolUseId);
          if (info && !calls.has(toolUseId)) calls.set(toolUseId, { toolUseId, ...info });
        }
      }
    });
    event.toolCalls = [...calls.values()];
    event.backgroundShell = false;
    this.step(event, 'read the background shell', () => { event.backgroundShell = session.runningShell(); });
    event.canExpand = false;
    this.step(event, 'check whether the plan can expand', () => {
      event.canExpand = plans.canExpand() && event.changes.every((c) => insideProject(c.path) && !isGitState(c.path));
    });
    event.defaultAction = event.mode === 'A' ? 'revert' : null;
    let last: string | null = null;
    this.step(event, 'read the last message', () => { last = session.lastMessage(); });
    event.reason = [last, ...(this.notes.get(event.id) ?? [])].filter(Boolean).join('\n') || null;
  }

  private flag(change: ChangeView, outOfPlan: boolean, note: string | null = null): void {
    const at = this.now();
    let flagged = this.flagged;
    if (!flagged || at - flagged.at > this.settleMs) {
      const event: WatchdogEventView = {
        id: this.newId(), kind: 'watchdog', mode: this.mode(), phase: 'resolved', resolution: 'flagged', changes: [], toolCalls: [],
        interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: false,
        snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: at, resolvedAt: at,
      };
      flagged = { event, at };
      this.flagged = flagged;
      this.all.push(event);
    }
    flagged.at = at;
    const { event } = flagged;
    if (event.changes.some((c) => c.id === change.id)) return;
    if (note) this.note(event, note);
    if (outOfPlan) this.step(event, 'store the decision', () => { this.o.changes.markOutOfPlan([change.id], event.id); });
    this.step(event, 'store the resolution', () => this.o.changes.setResolution([change.id], 'flagged', event.id));
    event.changes = [...event.changes, this.fresh(change)];
    this.fill(event);
    event.canExpand = false;
    event.defaultAction = null;
    this.persist(event);
    this.emit(event);
  }

  private fresh(change: ChangeView): ChangeView {
    try {
      return this.o.changes.changes().find((c) => c.id === change.id) ?? change;
    } catch {
      return change;
    }
  }

  private persist(event: WatchdogEventView): void {
    try {
      const sessionId = this.o.sessionId();
      if (sessionId === null) throw new Error('no session to record the event into');
      this.o.store.saveWatchdogEvent(sessionId, event);
    } catch (error) {
      console.error('watchdog: could not save an event', error);
    }
  }

  private emit(event: WatchdogEventView): void {
    const view = { ...event };
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (error) {
        console.error('watchdog: a listener failed', error);
      }
    }
  }
}
