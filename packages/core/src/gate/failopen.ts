import type { ToolEndInfo } from '../agent/tracker';
import type { ChangeService } from '../history/changes';
import type { ToolDecisionRecord } from '../store/store';
import type { ActivityLedger } from '../watchdog/activity';
import type { Watchdog } from '../watchdog/watchdog';
import type { HookGate } from './hook-gate';

export const NO_HOOK_TOOLS: ReadonlySet<string> = new Set<string>();

const KEPT_REPORTED = 10_000;

export interface FailOpenOptions {
  gate: Pick<HookGate, 'hasCall' | 'dropForTool'>;
  ledger: Pick<ActivityLedger, 'windowOf'>;
  changes: Pick<ChangeService, 'reattribute' | 'changes'>;
  watchdog: Pick<Watchdog, 'raiseFailOpen' | 'isPending'>;
  record: (record: ToolDecisionRecord) => void;
  exempt?: ReadonlySet<string>;
  now?: () => number;
}

export class FailOpenDetector {
  private readonly reported = new Set<string>();

  constructor(private readonly o: FailOpenOptions) {}

  toolEnded(e: ToolEndInfo): void {
    try {
      if (e.status !== 'ok' || (this.o.exempt ?? NO_HOOK_TOOLS).has(e.tool) || this.o.watchdog.isPending()) return;
      const seen = this.o.gate.hasCall(e.toolUseId);
      if (seen === 'decided' || this.reported.has(e.toolUseId)) return;
      this.reported.add(e.toolUseId);
      if (this.reported.size > KEPT_REPORTED) this.reported.delete(this.reported.values().next().value as string);
      this.step('record the decision', () => this.o.record({
        toolUseId: e.toolUseId, decision: seen === 'none' ? 'hook-missing' : 'hook-pending', planId: null, planVersion: null, stepKey: null, targets: [],
        reason: seen === 'none' ? 'the hook did not run for this call' : 'the hook was still waiting when the call ran',
        decidedAt: (this.o.now ?? Date.now)(),
      }));
      if (seen === 'pending') this.step('drop the prompt', () => this.o.gate.dropForTool(e.toolUseId));
      void this.raise(e).catch((error) => console.error('failopen: could not raise an event', error));
    } catch (error) {
      console.error('failopen: could not handle a tool result', error);
    }
  }

  private async raise(e: ToolEndInfo): Promise<void> {
    const from = this.o.ledger.windowOf(e.toolUseId)?.from ?? e.toolUseAt;
    let changed;
    try {
      changed = await this.o.changes.reattribute(e.toolUseId, from, e.endedAt);
    } catch (error) {
      console.error('failopen: could not re-attribute the changes', error);
      changed = this.o.changes.changes().filter((change) => change.toolUseIds.includes(e.toolUseId));
    }
    this.o.watchdog.raiseFailOpen(e.toolUseId, changed);
  }

  private step(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`failopen: could not ${what}`, error);
    }
  }
}
