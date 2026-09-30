import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import type { ChangeView } from '@ide/protocol';
import type { AgentSession, SessionGate } from '../agent/agent-session';
import type { ToolEndInfo } from '../agent/tracker';
import { FailOpenDetector } from '../gate/failopen';
import { Hold } from '../gate/hold';
import { classifyPaths, guardedMatcher } from '../gate/paths';
import { createGateRuntime, type GateRuntime, type GateRuntimeOptions } from '../gate/runtime';
import { toolClass } from '../gate/tools';
import { Baselines, newScanCache, ScanError, scanTree } from '../history/baselines';
import { ChangeService } from '../history/changes';
import { Checkpoints } from '../history/checkpoints';
import { DiffService } from '../history/diff';
import { IdeWrites } from '../history/ide-writes';
import { RevertService } from '../history/revert';
import { ShadowRepo } from '../history/shadow';
import { Summarizer } from '../history/summarizer';
import type { IndexedFile } from '../model';
import type { ModelProvider } from '../models/types';
import { ActivityLedger } from '../watchdog/activity';
import { recoverBaselines } from '../watchdog/recovery';
import { Watchdog, type WatchdogSession } from '../watchdog/watchdog';
import { WatchdogWatcher, type FsEvent, type WatchdogWatcherOptions } from '../watchdog/watcher';

const RECONCILE_MS = 1_500;
const SUMMARY_DEBOUNCE_MS = 2_000;
const SLOW_RECONCILE_MS = 10_000;
const SCAN_COST_FACTOR = 3;

export interface ExecutionRuntimeOptions extends GateRuntimeOptions {
  shadowDir: string;
  watcherSettleMs?: number;
  watchdogSettleMs?: number;
  provider: Pick<ModelProvider, 'fast'>;
  files: () => IndexedFile[];
  reconcileMs?: number;
  slowReconcileMs?: number;
  ledgerGraceMs?: number;
  summaryDebounceMs?: number;
  watcherOptions?: Partial<Omit<WatchdogWatcherOptions, 'root' | 'settleMs'>>;
  notice?: (text: string) => void;
}

export interface ExecutionRuntime {
  gate: GateRuntime;
  sessionGate: SessionGate;
  changes: ChangeService;
  watchdog: Watchdog;
  reverts: RevertService;
  summarizer: Summarizer;
  ideWrites: IdeWrites;
  ledger: ActivityLedger;
  hold: Hold;
  checkpoints: Checkpoints;
  diff: DiffService;
  baselines: Baselines;
  start(): Promise<void>;
  attach(session: AgentSession): void;
  close(): Promise<void>;
  unavailable(): string | null;
  onChangesUpserted(listener: (changes: ChangeView[]) => void): () => boolean;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createExecutionRuntime(o: ExecutionRuntimeOptions): ExecutionRuntime {
  let session: AgentSession | null = null;
  let opened: ShadowRepo | null = null;
  // The graph is built synchronously, but the shadow repository opens asynchronously in start().
  const shadow = new Proxy({} as ShadowRepo, {
    get(_, key) {
      if (!opened) throw new Error('the shadow repository is not open yet');
      const value: unknown = Reflect.get(opened, key);
      return typeof value === 'function' ? value.bind(opened) : value;
    },
  });
  const sessionId = (): string | null => session?.sessionId() ?? null;
  const attached = (): AgentSession => {
    if (!session) throw new Error('no agent session is attached');
    return session;
  };
  const notice = o.notice ?? ((text: string) => console.warn(text));

  const hold = new Hold();
  const gate = createGateRuntime({ ...o, hold });
  const baselines = new Baselines(o.store);
  const ideWrites = new IdeWrites();
  const ledger = new ActivityLedger({ graceMs: o.ledgerGraceMs });
  const checkpoints = new Checkpoints(o.store, sessionId);
  const changes = new ChangeService({
    root: o.root,
    get policy() {
      return o.policy();
    },
    shadow, baselines, ideWrites, ledger, plans: gate.plans, store: o.store, checkpoints, sessionId,
    toolStamp: (toolUseId) => session?.toolStamp(toolUseId) ?? null,
  });
  const agent: WatchdogSession = {
    hasOpenTurn: () => session?.hasOpenTurn() ?? false,
    runningSubagents: () => session?.runningSubagents() ?? 0,
    runningSubagentNames: () => session?.runningSubagentNames() ?? [],
    runningShell: () => session?.runningShell() ?? false,
    processAlive: () => session?.processAlive() ?? false,
    interrupt: () => session?.interrupt() ?? false,
    send: (text) => attached().send(text),
    sendAbsorbed: (text) => attached().sendAbsorbed(text),
    queueNote: (text) => attached().queueNote(text),
    lastMessage: () => session?.lastMessage() ?? null,
    onTurnClosed: (listener) => (session ? session.onTurnClosed(listener) : () => false),
  };
  let watchdog!: Watchdog;
  const reverts = new RevertService({
    root: o.root, shadow, baselines, ideWrites, changes, store: o.store, sessionId,
    steps: { checkpoints, plans: gate.plans, isIdle: () => session?.isIdle() ?? true, watchdogPending: () => watchdog.isPending(), queueNote: (text) => attached().queueNote(text) },
  });
  watchdog = new Watchdog({
    store: o.store, sessionId, session: agent, hold, shadow, root: o.root, plans: gate.plans, changes, reverts, gate: gate.gate, policy: o.policy,
    toolInfo: (toolUseId) => session?.toolInfo(toolUseId), settleMs: o.watchdogSettleMs,
  });
  const upserted = new Set<(changes: ChangeView[]) => void>();
  const publish = (list: ChangeView[]): void => {
    if (list.length === 0) return;
    for (const listener of upserted) {
      try {
        listener(list);
      } catch (error) {
        console.error('execution: a change listener failed', error);
      }
    }
  };
  const detector = new FailOpenDetector({
    gate: gate.gate,
    ledger,
    changes: {
      humanIn: (from, to) => changes.humanIn(from, to),
      reattribute: async (toolUseId, from, to) => {
        const updated = await changes.reattribute(toolUseId, from, to);
        publish(updated);
        return updated;
      },
    },
    watchdog,
    record: (record) => session?.recordDecision(record),
  });

  let policyKey = '';
  let matchers = { guarded: guardedMatcher(o.policy()), harness: ignore().add(o.policy().harness) };
  const isProtected = (rel: string): boolean => {
    try {
      const policy = o.policy();
      const key = `${policy.guarded.join('\n')}\u0000${policy.harness.join('\n')}`;
      if (key !== policyKey) {
        policyKey = key;
        matchers = { guarded: guardedMatcher(policy), harness: ignore().add(policy.harness) };
      }
      return matchers.guarded.ignores(rel) || matchers.harness.ignores(rel);
    } catch {
      return true;
    }
  };
  const summarizer = new Summarizer({
    store: o.store, provider: o.provider, changes: () => changes.changes(), plans: () => gate.plans.plans(), files: o.files,
    components: () => o.components(), isProtected, debounceMs: o.summaryDebounceMs,
  });
  const diff = new DiffService({ shadow, changes: () => changes.changes(), baselines, checkpoints });
  const watcher = new WatchdogWatcher({ ...o.watcherOptions, root: o.root, settleMs: o.watcherSettleMs });

  let closing = false;
  let ready = false;
  let failure: string | null = null;
  let starting: Promise<void> | null = null;
  let closed: Promise<void> | null = null;
  let scanning: Promise<void> | null = null;
  let scanTimer: NodeJS.Timeout | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let lastScanWall = Date.now();
  let lastScanMs = 0;
  let scanFailing = false;
  const scanCache = newScanCache();
  const touched = new Set<string>();

  const syncHold = (): void => {
    if (watchdog.isPending() && !hold.isHeld()) hold.hold('the watchdog is waiting for the user');
  };

  const record = (event: FsEvent): Promise<void> =>
    changes.handle(event).catch((error) => console.error('execution: could not record a change', error));

  const scan = async (refresh: boolean): Promise<void> => {
    const startedWall = Date.now();
    const started = performance.now();
    const policy = o.policy();
    const { seeded, drift } = await scanTree(o.root, policy, shadow, baselines, scanCache, { refresh });
    let failed = false;
    if (!seeded && drift.length > 0) {
      const infos = await classifyPaths(drift.map((d) => join(o.root, d.path)), { root: o.root, policy });
      const mtimes = await Promise.all(drift.map((d) => (d.after ? lstat(join(o.root, d.path)).then((stat) => stat.mtimeMs, () => null) : null)));
      const nowWall = Date.now();
      const nowMono = performance.now();
      await Promise.all(drift.map((d, i) => {
        const wall = Math.min(Math.max(mtimes[i] ?? nowWall, lastScanWall + 1), nowWall);
        return changes.handle({ rel: d.path, exists: d.after !== null, at: nowMono - (nowWall - wall), wall }).catch((error) => {
          failed = true;
          console.error('execution: could not record a change', error);
        });
      }));
      if (!failed) {
        const rows = drift.flatMap((d, i) => (infos[i]!.cls !== 'enforced' && d.after ? [{ path: d.path, hash: d.after.hash, stored: d.after.stored, size: d.after.size, mode: d.after.mode }] : []));
        const removed = drift.filter((d, i) => infos[i]!.cls !== 'enforced' && d.after === null).map((d) => d.path);
        if (rows.length > 0 || removed.length > 0) baselines.setMany(rows, removed);
      }
    }
    if (!failed) lastScanWall = startedWall;
    lastScanMs = performance.now() - started;
  };

  const reconcile = (full = false): Promise<void> => {
    if (!ready || closing || sessionId() === null) return Promise.resolve();
    scanning ??= scan(full)
      .then(() => { scanFailing = false; })
      .catch((error) => {
        if (scanFailing) return;
        scanFailing = true;
        console.error('execution: the periodic scan failed', error);
        if (error instanceof ScanError) notice(`The IDE could not check the project files for changes (${error.message}).`);
      })
      .finally(() => { scanning = null; });
    return scanning;
  };

  const reconcileFresh = async (): Promise<void> => {
    await scanning;
    await reconcile();
  };

  const tick = async (): Promise<void> => {
    scanTimer = undefined;
    let delay = o.reconcileMs ?? RECONCILE_MS;
    const current = session;
    if (current && !current.isIdle()) {
      await reconcile();
      delay = Math.max(current.hasOpenTurn() ? delay : o.slowReconcileMs ?? SLOW_RECONCILE_MS, SCAN_COST_FACTOR * lastScanMs);
    }
    schedule(delay);
  };
  const schedule = (delayMs: number): void => {
    if (closing) return;
    scanTimer = setTimeout(() => void tick(), delayMs);
    scanTimer.unref();
  };

  const flushSummaries = (): void => {
    summaryTimer = undefined;
    const ids = [...touched];
    touched.clear();
    for (const id of ids) {
      try {
        summarizer.request('component', id);
      } catch (error) {
        console.error('execution: could not ask for a component summary', error);
      }
    }
  };
  const touch = (batch: ChangeView[]): void => {
    const counted = new Set(batch.filter((c) => c.enforcement === 'enforced' && !isProtected(c.path)).map((c) => c.path));
    if (counted.size === 0) return;
    for (const component of o.components()) if (component.files.some((file) => counted.has(file))) touched.add(component.id);
    if (touched.size > 0 && summaryTimer === undefined) {
      summaryTimer = setTimeout(flushSummaries, o.summaryDebounceMs ?? SUMMARY_DEBOUNCE_MS);
      summaryTimer.unref();
    }
  };

  changes.onChange((batch) => {
    publish(batch);
    if (closing) return;
    for (const change of batch) watchdog.consider(change);
    touch(batch);
  });
  watchdog.onChange((event) => publish(event.changes));
  reverts.onChange((revertRecord) => {
    const ids = new Set(revertRecord.changeIds);
    publish(changes.changes().filter((change) => ids.has(change.id)));
  });
  gate.gate.onAllowed((call) => ledger.allowed(call));
  gate.plans.onStep((event) => {
    if (closing) return;
    try {
      if (event.phase === 'start') return checkpoints.begin(event.planId, event.key);
      if (event.phase === 'reset') return;
      const cycle = checkpoints.manifests(event.planId, event.key)?.cycle;
      void (async () => {
        await changes.idle();
        await reconcileFresh();
        await changes.idle();
        if (checkpoints.manifests(event.planId, event.key)?.cycle !== cycle) return;
        checkpoints.seal(event.planId, event.key);
        summarizer.request('step', `${event.planId}/${event.key}`);
      })().catch((error) => console.error('execution: could not seal a step checkpoint', error));
    } catch (error) {
      console.error('execution: could not handle a step event', error);
    }
  });

  const sessionGate: SessionGate = {
    ...gate.sessionGate,
    write(id) {
      if (failure !== null) throw new Error(`the watchdog is unavailable (${failure}), so the agent was not started`);
      if (!ready) throw new Error('the watchdog is not ready yet, so the agent was not started');
      syncHold();
      return gate.sessionGate.write(id);
    },
  };
  const exposedGate: GateRuntime = { ...gate, sessionGate };

  const run = async (): Promise<void> => {
    const current = attached();
    try {
      if (closing) return;
      lastScanWall = Date.now();
      opened = await ShadowRepo.open(o.shadowDir);
      if (closing) return;
      await recoverBaselines({ root: o.root, shadow, baselines, policy: o.policy(), changes, watchdog, crashed: current.startedFromCrash(), notice, cache: scanCache });
      if (closing) return;
      watchdog.restore();
      syncHold();
      publish(changes.changes());
      watcher.onEvent((event) => {
        // With no session there is nowhere to record into; the scan at the first user message finds the change.
        if (sessionId() !== null) void record(event);
      });
      await watcher.start();
    } catch (error) {
      await watcher.stop();
      if (closing) return;
      failure = describe(error);
      console.error('execution: the watchdog could not start', error);
      notice(`The IDE could not start watching the project files (${failure}), so the agent will not start.`);
      return;
    }
    if (closing) {
      await watcher.stop();
      return;
    }
    ready = true;
    schedule(o.reconcileMs ?? RECONCILE_MS);
  };

  return {
    gate: exposedGate,
    sessionGate,
    changes,
    watchdog,
    reverts,
    summarizer,
    ideWrites,
    ledger,
    hold,
    checkpoints,
    diff,
    baselines,
    unavailable: () => failure,
    onChangesUpserted(listener) {
      upserted.add(listener);
      return () => upserted.delete(listener);
    },
    attach(next) {
      if (session) throw new Error('an agent session is already attached');
      session = next;
      gate.attach(next);
      next.onToolResult((info: ToolEndInfo) => {
        if (info.status === 'ok' && gate.gate.hasCall(info.toolUseId) !== 'decided' && ledger.windowOf(info.toolUseId) === undefined) {
          ledger.unjudged({
            toolUseId: info.toolUseId, parentToolUseId: info.parentToolUseId, tool: info.tool, toolClass: toolClass(info.tool),
            targets: [], allTracked: false, cwdRel: null, background: false, allowedOnce: false,
          }, info.toolUseAt, info.endedAt);
        }
        ledger.ended(info.toolUseId);
        if (toolClass(info.tool) === 'subagent' && !next.hasLiveTask(info.toolUseId)) ledger.taskEnded(info.toolUseId);
        detector.toolEnded(info);
      });
      next.onTaskEnd((toolUseId) => ledger.taskEnded(toolUseId));
      next.onInterrupt(() => ledger.interrupted());
      next.onProcessExit(() => {
        ledger.clear();
        if (!watchdog.isPending()) hold.release();
      });
      next.onNewSession(() => {
        watchdog.dropPending();
        if (!watchdog.isPending()) hold.release();
      });
      next.onUserMessage(() => void reconcile());
      next.onTurnClosed(() => void reconcile(true));
    },
    async start() {
      if (!attached().hasStarted()) throw new Error('await AgentSession.start() before the execution runtime start()');
      return (starting ??= run());
    },
    close() {
      return (closed ??= (async () => {
        closing = true;
        await starting;
        clearTimeout(scanTimer);
        clearTimeout(summaryTimer);
        await watcher.stop();
        await summarizer.close();
        await watchdog.quiesce();
        await scanning;
        await changes.idle();
        await gate.close();
      })());
    },
  };
}
