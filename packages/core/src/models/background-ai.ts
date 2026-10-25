import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKGROUND_ENGINE_ORDER, ENGINE_NAMES, ENGINE_PRODUCT_NAMES, isEngineId, parseModelId,
  type BackgroundAiChoice, type BackgroundAiStatus, type BackgroundAiView, type EngineId, type EngineStatus, type ModelInfo,
} from '@ide/protocol';
import { hideSecrets } from '../agent/codex/secrets';
import type { BackgroundModel, Engine } from '../agent/engines/registry';
import { isRecord, parseJson } from '../json';
import { writeFileNoFollow } from '../mcp/config';
import type { DefaultModelProvider } from './provider';
import type { EmbedModel, GenerateOptions, StructuredModel, StructuredRequest } from './types';

/** The background AI is off (by choice, or with no engine to run on): no process was started. */
export class BackgroundAiOff extends Error {}

export const FAILED_COOLDOWN_MS = 10 * 60_000;
export const OFF_RECHECK_MS = 10 * 60_000;
const INSTALL = 'No AI engine is installed. Install Claude Code, Codex or opencode and sign in; the map and chat work without one.';
const OFF_BY_CHOICE = 'Background AI is off. Turn it on in Settings → Background AI.';
const CHOOSE = 'Choose another engine in Settings → Background AI.';
const STATE_WORDS: Record<EngineStatus['state'], string> = { ready: 'ready', missing: 'not installed', old: 'too old', 'signed-out': 'signed out', error: 'not answering' };
const firstLine = (text: string): string => hideSecrets(text.split('\n')[0] ?? '').trim();
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
const cancelled = (): Error => new Error('cancelled');

/**
 * One engine for a person: its own hint when that already opens with the engine's name or "This <Engine> account", or names the product
 * before its first colon ("Install Claude Code: …"), else "<Engine> is <state>: <hint>".
 */
function engineLine(status: EngineStatus): string {
  const name = ENGINE_PRODUCT_NAMES[status.engine];
  const hint = status.hint === null ? null : firstLine(status.hint);
  const named = (engine: string): boolean => hint !== null && (hint.startsWith(engine) || hint.startsWith(`This ${engine} account`));
  const leads = hint !== null && hint.includes(':') && hint.slice(0, hint.indexOf(':')).includes(name);
  if (hint !== null && (leads || named(name) || named(ENGINE_NAMES[status.engine]))) return hint;
  return `${name} is ${STATE_WORDS[status.state]}${hint ? `: ${hint}` : ''}`;
}

/**
 * Why the background AI is off, in one line: `noModel` are engines with no model for the choice, `failed` the reasons of the failure memory,
 * `alone` that the chosen engine is the only one the core runs, so there is no other to choose.
 */
export function offHint(choice: BackgroundAiChoice, statuses: EngineStatus[], noModel: EngineId[], failed: ReadonlyMap<EngineId, string>, alone = false): string {
  if (choice.mode === 'off') return OFF_BY_CHOICE;
  const chosen = choice.mode === 'engine' && choice.model !== null ? parseModelId(choice.model)?.model ?? choice.model : null;
  const line = (engine: EngineId): string => {
    const reason = failed.get(engine);
    if (reason !== undefined) return `${ENGINE_PRODUCT_NAMES[engine]} failed: ${reason}`;
    if (noModel.includes(engine)) return `${ENGINE_PRODUCT_NAMES[engine]} ${chosen === null ? 'lists no model for this choice' : `no longer offers ${chosen}`}`;
    const status = statuses.find((candidate) => candidate.engine === engine);
    return status === undefined ? `${ENGINE_PRODUCT_NAMES[engine]} is not run by this CodeRay` : engineLine(status);
  };
  if (choice.mode === 'engine') return alone ? sentence(line(choice.engine)) : `${sentence(line(choice.engine))} ${CHOOSE}`;
  const found = BACKGROUND_ENGINE_ORDER.filter((engine) => failed.has(engine) || noModel.includes(engine) || statuses.some((status) => status.engine === engine && status.state !== 'missing'));
  if (found.length === 0) return INSTALL;
  return `${found.map((engine) => line(engine).replace(/\.$/, '')).join(' · ')}. The map and chat work without an AI engine.`;
}

/**
 * The background AI now runs where it did not: on after off, or on another model, and so another engine, since a model id names its
 * engine. What waited or failed did so on `before`, the last status that was not `checking`.
 */
export function movedOn(before: BackgroundAiStatus | null, after: BackgroundAiStatus): boolean {
  if (after.state !== 'ready' || before === null) return false;
  return before.state === 'off' || (before.state === 'ready' && before.modelId !== after.modelId);
}

interface Stored { choice: BackgroundAiChoice; onboarded: boolean }
const DEFAULT: Stored = { choice: { mode: 'auto' }, onboarded: false };

function readChoice(value: unknown): BackgroundAiChoice {
  if (!isRecord(value)) return { mode: 'auto' };
  if (value.mode === 'off') return { mode: 'off' };
  if (value.mode === 'engine' && isEngineId(value.engine)) {
    const model = typeof value.model === 'string' && parseModelId(value.model)?.engine === value.engine ? value.model : null;
    return { mode: 'engine', engine: value.engine, model };
  }
  return { mode: 'auto' };
}

/** `<home>/background-ai.json`: the choice and whether the first-run screen was answered, shared by every core on the home. */
export class BackgroundAiStore {
  readonly path: string;
  constructor(private readonly home: string) { this.path = join(home, 'background-ai.json'); }
  /** Changes when any core rewrites the file; null while there is none. */
  stamp(): string | null {
    try {
      const stat = statSync(this.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }
  read(): Stored {
    try {
      const value = parseJson(readFileSync(this.path, 'utf8'));
      return isRecord(value) ? { choice: readChoice(value.choice), onboarded: value.onboarded === true } : DEFAULT;
    } catch {
      return DEFAULT;
    }
  }
  write(next: Stored): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileNoFollow(temp, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    renameSync(temp, this.path);
  }
}

interface Pick { engine: EngineId; background: BackgroundModel }
interface Resolved { pick: Pick | null; status: BackgroundAiStatus; seen: Map<EngineId, EngineStatus['state']> }

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export interface BackgroundAiOptions {
  engines: () => Engine[];
  embed: EmbedModel & { close(): Promise<void> };
  store: BackgroundAiStore;
  /** The latest engines probe's answer for an engine, shared with the engines list the UI gets; defaults to asking the engine. */
  status?: (engine: Engine) => Promise<EngineStatus>;
  /** Probes every engine again (main: refreshEngines, which ends in refresh()); defaults to refresh(). */
  recheck?: () => void;
  now?: () => number;
}

/**
 * The background AI: every `reasoning`/`fast` call goes to the chosen engine, or by default the first ready one in
 * `BACKGROUND_ENGINE_ORDER` that has not failed in the last `FAILED_COOLDOWN_MS`; with none, or Off, a call fails at once with `BackgroundAiOff`.
 */
export class BackgroundAi implements DefaultModelProvider {
  readonly reasoning: StructuredModel;
  readonly fast: StructuredModel;
  readonly embed: EmbedModel;
  private current: BackgroundAiStatus = { state: 'checking' };
  private picking: Promise<Pick | null> | null = null;
  private picked: Pick | null = null;
  private generation = 0;
  private stored: Stored;
  private stamp: string | null;
  private seen = new Map<EngineId, EngineStatus['state']>();
  private readonly failed = new Map<EngineId, { at: number; reason: string }>();
  private recheckTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(status: BackgroundAiStatus) => void>();

  constructor(private readonly options: BackgroundAiOptions) {
    this.embed = options.embed;
    this.stored = options.store.read();
    this.stamp = options.store.stamp();
    const model: StructuredModel = { generate: (request, generateOptions) => this.generate(request, generateOptions) };
    this.reasoning = model;
    this.fast = model;
  }

  status(): BackgroundAiStatus { return this.current; }
  choice(): BackgroundAiChoice { this.syncStore(); return this.stored.choice; }
  onboarded(): boolean { this.syncStore(); return this.stored.onboarded; }
  setChoice(choice: BackgroundAiChoice): void { this.save({ ...this.stored, choice }); this.refresh(); }
  setOnboarded(onboarded: boolean): void { this.save({ ...this.stored, onboarded }); }

  onChange(listener: (status: BackgroundAiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The background AI as Settings and the first-run screen show it: every engine the core runs, with its latest state and models. */
  view(statuses: EngineStatus[], models: ModelInfo[]): BackgroundAiView {
    this.syncStore();
    const ids = this.options.engines().map((engine) => engine.id);
    const failed = this.activeFailures();
    return {
      choice: this.stored.choice, onboarded: this.stored.onboarded, status: this.current,
      options: BACKGROUND_ENGINE_ORDER.filter((id) => ids.includes(id)).map((engine) => {
        const status = statuses.find((candidate) => candidate.engine === engine) ?? null;
        const reason = failed.get(engine);
        // The probe answers for chats; a parked engine runs no background call.
        const shown = status?.state === 'ready' && reason !== undefined ? { ...status, state: 'error' as const, hint: `${ENGINE_PRODUCT_NAMES[engine]} failed: ${reason}` } : status;
        return { engine, status: shown, models: models.filter((model) => model.engine === engine) };
      }),
    };
  }

  /** A later engines probe answered: a state the pick saw that has changed picks again. */
  enginesChanged(statuses: EngineStatus[]): void {
    if (statuses.some((status) => this.seen.has(status.engine) && this.seen.get(status.engine) !== status.state)) this.refresh();
  }

  /** Forgets the pick and the failures (an account change, a save, a new probe) and picks again. */
  refresh(): void {
    this.failed.clear();
    this.repick();
  }

  async close(): Promise<void> {
    clearTimeout(this.recheckTimer);
    this.generation += 1;
    await this.options.embed.close();
  }

  private repick(): void {
    this.generation += 1;
    this.picking = null;
    this.picked = null;
    this.publish({ state: 'checking' });
    void this.pick();
  }

  private pick(): Promise<Pick | null> {
    // A choice another core saved picks again, before the pick of the old choice is reused.
    this.syncStore();
    if (this.picking !== null) return this.picking;
    const generation = this.generation;
    const picking = this.resolve()
      .catch((error: unknown): Resolved => ({ pick: null, status: { state: 'off', reason: 'none', engine: null, hint: firstLine((error as Error).message) }, seen: new Map() }))
      .then(({ pick, status, seen }) => {
        if (generation === this.generation) {
          this.seen = seen;
          this.picked = pick;
          this.publish(status);
          this.scheduleRecheck(status);
        }
        return pick;
      });
    this.picking = picking;
    return picking;
  }

  /** The pick of the current generation: a call that waited on a pick a refresh replaced waits for the new one. */
  private async currentPick(signal: AbortSignal | undefined): Promise<Pick | null> {
    for (;;) {
      const generation = this.generation;
      const pick = await abortable(this.pick(), signal);
      if (generation === this.generation) return pick;
    }
  }

  private activeFailures(): Map<EngineId, string> {
    const now = (this.options.now ?? Date.now)();
    for (const [engine, { at }] of this.failed) if (now - at >= FAILED_COOLDOWN_MS) this.failed.delete(engine);
    return new Map([...this.failed].map(([engine, { reason }]) => [engine, reason]));
  }

  private async resolve(): Promise<Resolved> {
    const choice = this.stored.choice;
    const seen = new Map<EngineId, EngineStatus['state']>();
    if (choice.mode === 'off') return { pick: null, status: { state: 'off', reason: 'choice', engine: null, hint: OFF_BY_CHOICE }, seen };
    const engines = new Map(this.options.engines().map((engine) => [engine.id, engine]));
    const order = choice.mode === 'auto' ? BACKGROUND_ENGINE_ORDER : [choice.engine];
    const why = this.activeFailures();
    const skipped = [...why.keys()];
    const statuses: EngineStatus[] = [];
    const noModel: EngineId[] = [];
    const unverified = new Map<EngineId, string>();
    const probe = this.options.status ?? ((engine: Engine) => engine.status());
    for (const id of order) {
      const engine = engines.get(id);
      if (engine === undefined || why.has(id)) continue;
      const status = await probe(engine).catch((error: unknown): EngineStatus => ({ engine: id, state: 'error', hint: firstLine((error as Error).message) }));
      statuses.push(status);
      seen.set(id, status.state);
      if (status.state !== 'ready') continue;
      const background = await engine.background(choice.mode === 'auto' ? null : choice.model).catch((error: unknown) => {
        why.set(id, firstLine((error as Error).message));
        return undefined;
      });
      if (background === undefined) continue;
      if (background === null) { noModel.push(id); continue; }
      // Not a failure: no call was made, so nothing is parked; the engine's sentence stands as its line.
      if (typeof background === 'string') {
        unverified.set(id, background);
        statuses[statuses.length - 1] = { ...status, hint: background };
        continue;
      }
      const passed = order.slice(0, order.indexOf(id)).flatMap((other) => {
        if (skipped.includes(other)) return [`${ENGINE_PRODUCT_NAMES[other]} failed: ${why.get(other)}`];
        const reason = unverified.get(other);
        return reason === undefined ? [] : [firstLine(reason)];
      });
      const note = passed.length === 0 ? null : passed.join(' · ');
      return { pick: { engine: id, background }, status: { state: 'ready', engine: id, modelId: background.modelId, note }, seen };
    }
    const reason = choice.mode === 'auto' ? 'none' : 'unavailable';
    const alone = choice.mode === 'engine' && [...engines.keys()].every((id) => id === choice.engine);
    return { pick: null, status: { state: 'off', reason, engine: choice.mode === 'engine' ? choice.engine : null, hint: offHint(choice, statuses, noModel, why, alone) }, seen };
  }

  private async generate(request: StructuredRequest, options: GenerateOptions = {}): Promise<unknown> {
    const pick = await this.currentPick(options.signal);
    if (pick === null) throw new BackgroundAiOff(this.current.state === 'off' ? this.current.hint : 'The background AI is not ready.');
    try {
      return await pick.background.model.generate(request, options);
    } catch (error) {
      if (options.signal?.aborted || error instanceof BackgroundAiOff) throw error;
      const reason = firstLine((error as Error).message);
      if (this.failed.get(pick.engine)?.reason !== reason) console.error(`background AI: ${ENGINE_PRODUCT_NAMES[pick.engine]} failed: ${reason}`);
      this.failed.set(pick.engine, { at: (this.options.now ?? Date.now)(), reason });
      // Another call may have re-picked already; only the pick this call used is dropped.
      if (this.picked === pick) this.repick();
      // The reason reaches the map's status and the overview, where no key may show.
      throw new Error(hideSecrets(error instanceof Error ? error.message : String(error)));
    }
  }

  private scheduleRecheck(status: BackgroundAiStatus): void {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    if (status.state !== 'off' || status.reason === 'choice') return;
    this.recheckTimer = setTimeout(() => (this.options.recheck ?? (() => this.refresh()))(), OFF_RECHECK_MS);
    this.recheckTimer.unref();
  }

  /** Another core rewrote the file: a changed choice picks again; the flag is read as it is. */
  private syncStore(): void {
    const stamp = this.options.store.stamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const next = this.options.store.read();
    const changed = JSON.stringify(next.choice) !== JSON.stringify(this.stored.choice);
    this.stored = next;
    if (changed) this.refresh();
  }

  private save(next: Stored): void {
    this.options.store.write(next);
    this.stored = next;
    this.stamp = this.options.store.stamp();
  }

  private publish(status: BackgroundAiStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status;
    for (const listener of this.listeners) {
      // A listener that throws must not reject the pick, which nothing may be awaiting.
      try {
        listener(status);
      } catch (error) {
        console.error('background AI: a status listener failed', error);
      }
    }
  }
}
