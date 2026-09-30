import { randomUUID } from 'node:crypto';
import type { ChangeView, Policy, WatchdogEventView, WatchdogToolCall } from '@ide/protocol';
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

const isGitState = (rel: string): boolean => rel === '.git/HEAD' || rel === '.git/refs' || rel.startsWith('.git/refs/');
const insideProject = (rel: string): boolean => rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel);

export class Watchdog {
  private readonly listeners = new Set<(event: WatchdogEventView) => void>();
  private readonly all: WatchdogEventView[] = [];
  private open: WatchdogEventView | null = null;
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

  consider(change: ChangeView): void {
    try {
      const byAgent = change.origin === 'agent' || change.origin === 'agent-tool';
      if (byAgent && isGitState(change.path)) return this.flag(change, false);
      if (change.origin !== 'agent-tool' || change.enforcement !== 'enforced' || !this.isOutOfPlan(change)) return;
      if (this.o.policy().mode === 'C') return this.flag(change, true);
      if (this.open) this.join(this.open, change);
      else this.begin(change);
    } catch (error) {
      console.error('watchdog: could not handle a change', error);
    }
  }

  private isOutOfPlan(change: ChangeView): boolean {
    const gate: PlanGate = this.o.plans.gate();
    if (gate.state !== 'approved') return true;
    return !covers(gate.scope, { rel: change.path, dir: false, mkdir: false, deleting: change.afterHash === null });
  }

  private begin(change: ChangeView): void {
    const { hold, session } = this.o;
    hold.hold('the watchdog is waiting for the user');
    const id = this.newId();
    const subagents = session.runningSubagents();
    const interrupt = session.hasOpenTurn() && subagents === 0;
    const event: WatchdogEventView = {
      id, kind: 'watchdog', mode: this.o.policy().mode, phase: 'collecting', resolution: 'pending', changes: [], toolCalls: [],
      interrupted: false, paused: subagents > 0, runningSubagents: subagents, backgroundShell: false, unknownOrigin: false,
      snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: this.now(), resolvedAt: null,
    };
    this.open = event;
    this.all.push(event);
    this.join(event, change, false);
    try {
      this.o.gate.withdrawPending('the watchdog opened an event');
    } catch (error) {
      console.error('watchdog: could not withdraw the open prompts', error);
    }
    if (interrupt) event.interrupted = session.interrupt();
    this.emit(event);
    this.arm(event);
  }

  private join(event: WatchdogEventView, change: ChangeView, rearm = true): void {
    if (!event.changes.some((c) => c.id === change.id)) {
      this.o.changes.markOutOfPlan([change.id], event.id);
      event.changes = [...event.changes, this.fresh(change)];
    }
    if (!rearm) return;
    if (event.phase === 'collecting') {
      this.arm(event);
    } else {
      this.fill(event);
      this.persist(event);
    }
    this.emit(event);
  }

  private arm(event: WatchdogEventView): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settling = this.settle(event).finally(() => { this.settling = null; });
    }, this.settleMs);
    this.timer.unref?.();
  }

  private async settle(event: WatchdogEventView): Promise<void> {
    let snapshotError: string | null = null;
    try {
      event.snapshotSha = await this.o.shadow.snapshot(event.id, event.changes.map((c) => ({ path: c.path, hash: c.afterHash })));
    } catch (error) {
      snapshotError = `Could not snapshot the files: ${error instanceof Error ? error.message : String(error)}`;
    }
    event.changes = event.changes.map((c) => this.fresh(c));
    event.phase = 'pending';
    this.fill(event);
    if (snapshotError) event.reason = [event.reason, snapshotError].filter(Boolean).join('\n');
    this.persist(event);
    this.emit(event);
  }

  private fill(event: WatchdogEventView): void {
    const { session, plans, toolInfo } = this.o;
    const calls = new Map<string, WatchdogToolCall>();
    for (const change of event.changes) {
      for (const toolUseId of change.toolUseIds) {
        const info = toolInfo(toolUseId);
        if (info && !calls.has(toolUseId)) calls.set(toolUseId, { toolUseId, ...info });
      }
    }
    event.toolCalls = [...calls.values()];
    event.backgroundShell = session.runningShell();
    event.canExpand = plans.canExpand() && event.changes.every((c) => insideProject(c.path) && !isGitState(c.path));
    event.defaultAction = event.mode === 'A' ? 'revert' : null;
    const snapshotNote = event.reason?.includes('Could not snapshot the files') ? event.reason.slice(event.reason.indexOf('Could not snapshot the files')) : null;
    event.reason = [session.lastMessage(), snapshotNote].filter(Boolean).join('\n') || null;
  }

  private flag(change: ChangeView, outOfPlan: boolean): void {
    const at = this.now();
    let flagged = this.flagged;
    if (!flagged || at - flagged.at > this.settleMs) {
      const event: WatchdogEventView = {
        id: this.newId(), kind: 'watchdog', mode: this.o.policy().mode, phase: 'resolved', resolution: 'flagged', changes: [], toolCalls: [],
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
    if (outOfPlan) this.o.changes.markOutOfPlan([change.id], event.id);
    this.o.changes.setResolution([change.id], 'flagged', event.id);
    event.changes = [...event.changes, this.fresh(change)];
    this.fill(event);
    event.canExpand = false;
    event.defaultAction = null;
    this.persist(event);
    this.emit(event);
  }

  private fresh(change: ChangeView): ChangeView {
    return this.o.changes.changes().find((c) => c.id === change.id) ?? change;
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
