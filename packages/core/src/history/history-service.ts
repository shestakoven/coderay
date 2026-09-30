import type {
  ChangeView, FileDiff, GateEventView, HistoryClientMessage, HistoryPatch, HistoryServerMessage, HistoryView, RollbackPreview,
} from '@ide/protocol';
import type { HookGate } from '../gate/hook-gate';
import type { PlanService } from '../plans/plan-service';
import type { Store } from '../store/store';
import type { Watchdog } from '../watchdog/watchdog';
import type { ChangeService } from './changes';
import type { Checkpoints } from './checkpoints';
import type { DiffService } from './diff';
import type { RevertService } from './revert';
import type { Summarizer } from './summarizer';

const SNAPSHOT_CHANGES = 2_000;
const FLUSH_MS = 100;

type Reply = (message: HistoryServerMessage | { type: 'error'; message: string }) => void;

export interface HistoryServiceOptions {
  store: Store;
  sessionId: () => string | null;
  changes: Pick<ChangeService, 'changes'>;
  watchdog: Pick<Watchdog, 'events' | 'onChange' | 'answer' | 'stopAgent'>;
  reverts: Pick<RevertService, 'reverts' | 'onChange' | 'undo' | 'previewStepRollback' | 'rollbackStep'>;
  checkpoints: Pick<Checkpoints, 'views'>;
  summarizer: Pick<Summarizer, 'views' | 'onChange'>;
  diff: Pick<DiffService, 'diff'>;
  gate: Pick<HookGate, 'onChange'>;
  plans: Pick<PlanService, 'onStep'>;
  ready: () => Promise<void>;
  unavailable: () => string | null;
  flushMs?: number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HistoryService {
  private readonly listeners = new Set<(patch: HistoryPatch) => void>();
  private readonly resetListeners = new Set<() => void>();
  private readonly upserted = new Map<string, ChangeView>();
  private readonly sent = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private session: string | null | undefined;
  private closed = false;

  constructor(private readonly o: HistoryServiceOptions) {
    o.watchdog.onChange(() => this.poke());
    o.reverts.onChange(() => this.poke());
    o.summarizer.onChange(() => this.poke());
    o.gate.onChange(() => this.poke());
    o.plans.onStep(() => this.poke());
  }

  snapshot(): HistoryView {
    const sessionId = this.o.sessionId();
    return {
      changes: this.o.changes.changes().slice(-SNAPSHOT_CHANGES),
      events: this.o.watchdog.events(),
      reverts: this.o.reverts.reverts(),
      checkpoints: this.o.checkpoints.views(),
      gateEvents: this.gateEvents(sessionId),
      summaries: this.o.summarizer.views(),
    };
  }

  onPatch(listener: (patch: HistoryPatch) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onReset(listener: () => void): () => boolean {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  upsertChanges(changes: ChangeView[]): void {
    for (const change of changes) this.upserted.set(change.id, change);
    this.poke();
  }

  poke(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), this.o.flushMs ?? FLUSH_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async handle(message: HistoryClientMessage, reply: Reply): Promise<void> {
    if (message.type === 'watchdog.answer' || message.type === 'watchdog.stop-agent') {
      try {
        await this.available();
        if (message.type === 'watchdog.answer') await this.o.watchdog.answer(message.eventId, message.answer);
        else this.o.watchdog.stopAgent(message.eventId);
      } catch (error) {
        reply({ type: 'error', message: describe(error) });
      }
      this.touchEvent(message.eventId);
      return;
    }
    const requestId = message.requestId;
    let outcome: { diff?: FileDiff; preview?: RollbackPreview };
    let error: string | null = null;
    try {
      await this.available();
      outcome = await this.run(message);
    } catch (failure) {
      outcome = {};
      error = describe(failure);
    }
    reply({ type: 'history.result', requestId, error, ...outcome });
  }

  private async run(message: Exclude<HistoryClientMessage, { type: 'watchdog.answer' | 'watchdog.stop-agent' }>): Promise<{ diff?: FileDiff; preview?: RollbackPreview }> {
    switch (message.type) {
      case 'history.diff':
        return { diff: await this.o.diff.diff(message.path, message.before, message.after) };
      case 'step.rollback-preview':
        return { preview: await this.o.reverts.previewStepRollback(message.planId, message.stepKey) };
      case 'revert.undo': {
        const { record } = await this.o.reverts.undo(message.revertId);
        this.touchChanges(record.changeIds);
        return {};
      }
      case 'step.rollback': {
        const record = await this.o.reverts.rollbackStep(message.planId, message.stepKey, message.confirm);
        this.touchChanges(record.changeIds);
        return {};
      }
    }
  }

  private async available(): Promise<void> {
    await this.o.ready();
    const failure = this.o.unavailable();
    if (failure !== null) throw new Error(`the watchdog is unavailable (${failure})`);
  }

  private touchEvent(eventId: string): void {
    const event = this.o.watchdog.events().find((e) => e.id === eventId);
    if (event) this.touchChanges(event.changes.map((c) => c.id));
    else this.poke();
  }

  private touchChanges(ids: string[]): void {
    const wanted = new Set(ids);
    this.upsertChanges(this.o.changes.changes().filter((c) => wanted.has(c.id)));
  }

  private gateEvents(sessionId: string | null): GateEventView[] {
    if (sessionId === null) return [];
    return this.o.store.gateEvents(sessionId).map((e) => ({
      id: e.id, kind: e.kind, toolUseId: e.toolUseId, mode: e.mode, targets: e.targets, resolution: e.resolution, ts: e.ts, resolvedAt: e.resolvedAt,
    }));
  }

  private changed<T>(kind: string, views: T[], key: (view: T) => string): T[] {
    return views.filter((view) => {
      const id = `${kind}:${key(view)}`;
      const signature = JSON.stringify(view);
      if (this.sent.get(id) === signature) return false;
      this.sent.set(id, signature);
      return true;
    });
  }

  private flush(): void {
    this.timer = undefined;
    if (this.closed) return;
    try {
      const sessionId = this.o.sessionId();
      if (this.session === undefined) this.session = sessionId;
      if (sessionId !== this.session) {
        this.session = sessionId;
        this.sent.clear();
        this.upserted.clear();
        for (const listener of this.resetListeners) listener();
        return;
      }
      const patch: HistoryPatch = {};
      const changes = [...this.upserted.values()];
      this.upserted.clear();
      if (changes.length > 0) patch.changes = changes;
      const events = this.changed('event', this.o.watchdog.events(), (e) => e.id);
      if (events.length > 0) patch.events = events;
      const reverts = this.changed('revert', this.o.reverts.reverts(), (r) => r.id);
      if (reverts.length > 0) patch.reverts = reverts;
      const checkpoints = this.changed('checkpoint', this.o.checkpoints.views(), (c) => `${c.planId}\u0000${c.stepKey}\u0000${c.cycle}`);
      if (checkpoints.length > 0) patch.checkpoints = checkpoints;
      const gateEvents = this.changed('gate', this.gateEvents(sessionId), (e) => e.id);
      if (gateEvents.length > 0) patch.gateEvents = gateEvents;
      const summaries = this.changed('summary', this.o.summarizer.views(), (s) => s.key);
      if (summaries.length > 0) patch.summaries = summaries;
      if (Object.keys(patch).length === 0) return;
      for (const listener of this.listeners) {
        try {
          listener(patch);
        } catch (error) {
          console.error('history: a patch listener failed', error);
        }
      }
    } catch (error) {
      console.error('history: could not build a patch', error);
    }
  }
}
