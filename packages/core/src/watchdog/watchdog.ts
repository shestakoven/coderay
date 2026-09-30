import { randomUUID } from 'node:crypto';
import type { ChangeView, ControlMode, EventResolution, Policy, WatchdogEventView, WatchdogToolCall } from '@ide/protocol';
import type { Hold } from '../gate/hold';
import type { HookGate } from '../gate/hook-gate';
import type { PlanGate } from '../gate/scope-guard';
import { covers } from '../gate/scope';
import type { ChangeService } from '../history/changes';
import type { ShadowRepo } from '../history/shadow';
import type { PlanService } from '../plans/plan-service';
import type { Store } from '../store/store';

const SETTLE_MS = 1_000;

export interface WatchdogSession {
  hasOpenTurn(): boolean;
  runningSubagents(): number;
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
  gate: Pick<HookGate, 'withdrawPending'>;
  policy: () => Policy;
  toolInfo: (toolUseId: string) => { tool: string; summary: string; stepKey: string | null } | undefined;
  settleMs?: number;
  now?: () => number;
  newId?: () => string;
}

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

  private begin(): WatchdogEventView {
    const { hold, session } = this.o;
    hold.hold('the watchdog is waiting for the user');
    const event: WatchdogEventView = {
      id: this.newId(), kind: 'watchdog', mode: this.mode(), phase: 'collecting', resolution: 'pending', changes: [], toolCalls: [],
      interrupted: false, paused: false, runningSubagents: 0, backgroundShell: false, unknownOrigin: false,
      snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: this.now(), resolvedAt: null,
    };
    this.open = event;
    this.all.push(event);
    this.arm(event);
    this.step(event, 'read the running subagents', () => {
      event.runningSubagents = session.runningSubagents();
      event.paused = event.runningSubagents > 0;
    });
    this.step(event, 'withdraw the open prompts', () => this.o.gate.withdrawPending('the watchdog opened an event'));
    this.step(event, 'interrupt the agent', () => {
      if (session.hasOpenTurn() && !event.paused) event.interrupted = session.interrupt();
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
