import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackgroundAiStatus, EmbeddingPlacement, FileEdge, GroupingPayload, MapComponent, MapStatus } from '@ide/protocol';
import { isRecord, parseJson } from '../json';
import type { ExpectWrite } from '../history/ide-writes';
import type { IndexedFile } from '../model';
import { BackgroundAiOff } from '../models/background-ai';
import type { EmbedModel, StructuredModel } from '../models/types';
import { aiCentroids, assignFiles, EMBEDDING_RULE } from './assign';
import { manualGlobOwner as globOwnerOf, matchManual, ownedGlobs, projectComponents } from './component-map';
import { checkRule, residualSamples, type EmbeddingRule, type RuleCheck } from './embedding-check';
import { EmbeddingIndex } from './embedding-index';
import { groupFiles, MAX_AI_FILES } from './grouping';
import { emptyMapFile, MAP_FILE, readMapFile, watchMapFile, writeMapFile, type AiComponent, type MapFileData, type MapFileWatch } from './map-file';
import { RegroupScheduler, type RegroupOutcome } from './regroup-scheduler';
import { changedFiles, componentEdges, mapKey, staleness, type GroupingBaseline, type Staleness } from './staleness';
import { importTargets } from './test-files';
import { dot } from './vectors';

export interface MapServiceOptions {
  root: string;
  projectName: string;
  stateDir: string;
  reasoning: StructuredModel;
  embed: EmbedModel;
  isAgentIdle: () => boolean;
  onChange: () => void;
  /** The background AI's status: while it is off no grouping runs, and none counts as failed. */
  backgroundAi: () => BackgroundAiStatus;
  embeddingRule?: EmbeddingRule | null;
  cooldownMs?: number;
  mapPollMs?: number;
  onEmbeddingProgress?: (progress: { done: number; total: number } | null) => void;
  expectWrite?: ExpectWrite;
}

export type SearchOutcome =
  | { ok: true; hits: { path: string; similarity: number }[]; indexed: number; total: number }
  | { ok: false; error: string };

export interface MapView {
  components: MapComponent[];
  manualFiles: ReadonlySet<string>;
  status: MapStatus;
}

interface Unsaved {
  ai: AiComponent[];
  raw: AiComponent[];
  groupedAt: string;
  basedOn: string | null;
  inputPaths: string[];
}

interface Placement {
  key: string;
  rule: EmbeddingRule | null;
  check: RuleCheck | null;
  complete: boolean;
}

const WRITE_ATTEMPTS = 3;
const FRESH: Staleness = { reasons: [], driftedComponents: [] };

export class MapService {
  private readonly options: MapServiceOptions;
  private readonly rule: EmbeddingRule | null;
  private readonly embeddings: EmbeddingIndex;
  private readonly scheduler: RegroupScheduler;
  private readonly baselineFile: string;
  private readonly unsubscribe: () => void;
  private readonly stopping = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private files: IndexedFile[] = [];
  private edges: FileEdge[] = [];
  private map: MapFileData = emptyMapFile();
  private unsaved: Unsaved | null = null;
  private writeWarning: string | null = null;
  private baseline: GroupingBaseline | null = null;
  private rebuildBaseline = false;
  private placement: Placement = { key: '', rule: null, check: null, complete: false };
  private components: MapComponent[] = [];
  private manualFiles = new Set<string>();
  private aiOwner = new Map<string, string>();
  private dangling: string[] = [];
  private pending: string[] = [];
  private unassigned: string[] = [];
  private stale: Staleness = FRESH;
  private grouping: 'idle' | 'running' | 'failed' = 'idle';
  private groupingError: string | null = null;
  private sending: GroupingPayload | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running: Promise<RegroupOutcome> | undefined;
  private watch: MapFileWatch | undefined;
  private started = false;
  private stopped = false;
  private published = '';
  private manualGlobMemoHash: string | null | undefined = undefined;
  private readonly manualGlobMemo = new Map<string, string | undefined>();

  constructor(options: MapServiceOptions) {
    this.options = options;
    this.rule = options.embeddingRule === undefined ? EMBEDDING_RULE : options.embeddingRule;
    this.baselineFile = join(options.stateDir, 'grouping-baseline.json');
    this.embeddings = new EmbeddingIndex({
      root: options.root,
      cacheFile: join(options.stateDir, 'embeddings.json'),
      model: options.embed,
      onProgress: options.onEmbeddingProgress,
    });
    this.scheduler = new RegroupScheduler({
      regroup: () => this.regroup(),
      need: () => {
        const groupable = this.files.length - this.manualFiles.size;
        return {
          hasAiMap: this.effectiveAi() !== null,
          stale: this.stale.reasons.length > 0,
          // Off, a grouping would only be skipped: each map change would rewrite the schedule for nothing.
          groupable: groupable > 0 && groupable <= MAX_AI_FILES && this.options.backgroundAi().state !== 'off',
        };
      },
      isAgentIdle: options.isAgentIdle,
      stateFile: join(options.stateDir, 'regroup-state.json'),
      cooldownMs: options.cooldownMs,
    });
    this.unsubscribe = options.embed.onStatus(() => {
      this.publishIfChanged();
      this.refresh();
    });
  }

  async start(files: IndexedFile[], edges: FileEdge[]): Promise<void> {
    this.files = files;
    this.edges = edges;
    this.map = await readMapFile(this.options.root);
    this.baseline = await readBaseline(this.baselineFile);
    await this.embeddings.load();
    if (this.stopped) return;
    this.started = true;
    this.watch = watchMapFile(this.options.root, () => void this.enqueue(() => this.reload()), this.options.mapPollMs);
    this.recompute();
    this.refresh();
  }

  update(files: IndexedFile[], edges: FileEdge[]): void {
    this.files = files;
    this.edges = edges;
    if (!this.started || this.stopped) return;
    this.recompute();
    this.refresh();
  }

  view(): MapView {
    const status = this.status();
    this.published = this.signature(status);
    const drifted = new Set(this.stale.driftedComponents);
    return {
      components: this.components.map((component) => (drifted.has(component.id) ? { ...component, stale: true } : component)),
      manualFiles: this.manualFiles,
      status,
    };
  }

  async search(query: string, limit: number): Promise<SearchOutcome> {
    const status = this.options.embed.status();
    if (status.state === 'unavailable') return { ok: false, error: `The embedding model is unavailable: ${status.reason}` };
    const [target] = await this.options.embed.embed([query]);
    if (!target) return { ok: false, error: 'The embedding model returned no vector for the query.' };
    const scored: { path: string; similarity: number }[] = [];
    for (const file of this.files) {
      const vector = this.embeddings.vector(file.path);
      if (!vector) continue;
      const norm = Math.sqrt(dot(vector, vector) * dot(target, target));
      scored.push({ path: file.path, similarity: norm === 0 ? 0 : dot(vector, target) / norm });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return { ok: true, hits: scored.slice(0, limit), indexed: scored.length, total: this.files.length };
  }

  regroup(): Promise<RegroupOutcome> {
    this.running ??= this.runGrouping().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  onAgentIdle(): void {
    this.scheduler.evaluate();
  }

  /** The background AI is back: grouping starts again, as if it had never failed. */
  resumeGrouping(): void {
    this.scheduler.resume();
  }

  /** Something outside the map changed its status (the background AI): the windows get it. */
  publishNow(): void {
    this.publishIfChanged();
  }

  async idle(): Promise<void> {
    for (;;) {
      const queue = this.queue;
      const running = this.running;
      await Promise.all([queue, running, ...this.work]);
      if (queue === this.queue && running === this.running && this.work.size === 0) return;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    this.scheduler.stop();
    this.watch?.stop();
    this.unsubscribe();
    await this.idle();
    await this.embeddings.flush();
  }

  private refresh(): void {
    if (!this.started || this.stopped) return;
    const work = this.embeddings
      .update(this.files, this.stopping.signal)
      .catch(() => undefined)
      .then(() => this.enqueue(() => this.settle()));
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
  }

  private async runGrouping(): Promise<RegroupOutcome> {
    if (this.stopped) return 'cancelled';
    if (this.options.backgroundAi().state === 'off') return 'skipped';
    const signal = this.stopping.signal;
    this.grouping = 'running';
    this.groupingError = null;
    this.publishIfChanged();
    try {
      await this.embeddings.update(this.files, signal).catch(() => undefined);
      if (this.stopped) return 'cancelled';
      const basedOn = this.map.groupedAt;
      const inputPaths = this.files.map((file) => file.path);
      const manual = this.manualEvidence(this.map, this.effectiveAi());
      const files = this.files.filter((file) => !manual.owner.has(file.path));
      if (files.length > 0) {
        const result = await groupFiles(
          {
            projectName: this.options.projectName,
            files: files.map((file) => ({ path: file.path, symbols: file.symbols.filter((s) => s.exported).map((s) => s.name) })),
            vectors: new Map(
              files.flatMap((file) => {
                const vector = this.embeddings.vector(file.path);
                return vector ? [[file.path, vector] as const] : [];
              }),
            ),
            edges: this.edges,
            previous: this.aiComponents(),
            reservedIds: [...this.map.assignments.values()],
          },
          this.options.reasoning,
          {
            signal,
            onSend: (payload) => {
              this.sending = payload;
              this.publishIfChanged();
            },
          },
        );
        if (this.stopped) return 'cancelled';
        await this.enqueue(() => this.apply(result, basedOn, inputPaths));
      }
      this.grouping = 'idle';
      return 'done';
    } catch (error) {
      if (this.stopped) return 'cancelled';
      // The pick a grouping waited for at core start turned out off.
      if (error instanceof BackgroundAiOff) {
        this.grouping = 'idle';
        return 'skipped';
      }
      this.grouping = 'failed';
      this.groupingError = (error as Error).message;
      return 'failed';
    } finally {
      this.sending = null;
      if (!this.stopped) {
        this.recompute();
        this.stale = this.computeStaleness();
        this.publishIfChanged();
      }
    }
  }

  private async apply(ai: AiComponent[], basedOn: string | null, inputPaths: string[]): Promise<void> {
    if (this.stopped || ai.length === 0) return;
    const finalized = this.finalize(ai, this.map, inputPaths);
    this.rebuildBaseline = true;
    if (!sameGrouping(finalized, this.effectiveAi())) {
      this.unsaved = { ai: finalized, raw: ai, groupedAt: new Date().toISOString(), basedOn, inputPaths };
      await this.persist();
    }
    await this.settle();
  }

  private async persist(): Promise<void> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      if (this.stopped || !this.unsaved) return;
      const fresh = await readMapFile(this.options.root);
      if (!fresh.writable) {
        this.adopt(fresh);
        this.writeWarning = `the new grouping is kept in memory until ${MAP_FILE} can be read again`;
        return;
      }
      if (fresh.groupedAt !== this.unsaved.basedOn) {
        this.map = fresh;
        this.unsaved = null;
        this.writeWarning = null;
        return;
      }
      const ai = this.finalize(this.unsaved.raw, fresh, this.unsaved.inputPaths);
      if (this.stopped) return;
      let written: MapFileData | 'conflict';
      try {
        written = await writeMapFile(this.options.root, { ai, groupedAt: this.unsaved.groupedAt, raw: fresh.raw }, fresh.hash, this.options.expectWrite);
      } catch (error) {
        this.map = fresh;
        this.writeWarning = `cannot write ${MAP_FILE} (${(error as Error).message}); the new grouping is kept in memory`;
        return;
      }
      if (written === 'conflict') continue;
      this.map = written;
      this.unsaved = null;
      this.writeWarning = null;
      return;
    }
    this.writeWarning = `${MAP_FILE} kept changing while the new grouping was saved; it is kept in memory`;
  }

  private async reload(): Promise<void> {
    if (!this.started || this.stopped) return;
    const fresh = await readMapFile(this.options.root);
    if (fresh.hash === this.map.hash && fresh.writable === this.map.writable) return;
    this.adopt(fresh);
    if (this.unsaved && fresh.writable) {
      if (fresh.groupedAt === this.unsaved.basedOn) {
        await this.persist();
      } else {
        this.unsaved = null;
        this.writeWarning = null;
      }
    }
    await this.settle();
  }

  private async settle(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.recompute();
    await this.ensureBaseline();
    if (this.checkPlacement()) this.recompute();
    this.stale = this.computeStaleness();
    this.publishIfChanged();
    this.scheduler.evaluate();
  }

  private recompute(): void {
    const paths = this.files.map((file) => file.path).sort();
    const ai = this.effectiveAi();
    const manual = this.manualEvidence(this.map, ai);
    this.manualFiles = new Set(manual.owner.keys());
    this.dangling = manual.dangling;
    if (!ai) {
      this.components = projectComponents({ paths, manual: this.map.manual, ai: null, owner: manual.owner });
      this.aiOwner = new Map();
      this.pending = [];
      this.unassigned = [];
      return;
    }
    const result = assignFiles({
      paths,
      ai,
      manualOwner: manual.owner,
      imports: importTargets(this.edges),
      vector: (path) => this.embeddings.vector(path),
      rule: this.options.embed.status().state === 'unavailable' ? null : this.activeRule(),
    });
    const aiIds = new Set(ai.map((component) => component.id));
    this.aiOwner = new Map([...result.owner].filter(([, id]) => aiIds.has(id)));
    this.components = projectComponents({ paths, manual: this.map.manual, ai, owner: result.owner });
    this.pending = result.pending;
    this.unassigned = result.unassigned;
  }

  private checkPlacement(): boolean {
    const before = this.activeRule();
    const ai = this.effectiveAi();
    if (!this.rule || !ai || this.options.embed.status().state === 'unavailable') {
      this.placement = { key: '', rule: this.rule, check: null, complete: true };
      return before !== this.activeRule();
    }
    const components = this.aiComponents();
    const complete = components.every((component) => component.files.every((path) => this.embeddings.vector(path)));
    const key = `${mapKey(ai, this.groupedAt())}|${JSON.stringify(this.rule)}`;
    if (this.placement.key === key && (this.placement.complete || !complete)) return false;
    const check = complete
      ? checkRule(
          this.rule,
          residualSamples(
            components,
            this.files.map((file) => file.path),
            (path) => this.embeddings.vector(path),
            importTargets(this.edges),
          ),
        )
      : null;
    this.placement = { key, rule: this.rule, check, complete };
    return before !== this.activeRule();
  }

  private activeRule(): EmbeddingRule | null {
    return this.placement.check?.passes ? this.placement.rule : null;
  }

  private computeStaleness(): Staleness {
    const failed = this.grouping === 'failed' ? [`the last grouping failed: ${this.groupingError}`] : [];
    const ai = this.effectiveAi();
    if (!ai) return { reasons: failed, driftedComponents: [] };
    const hashes = new Map(this.files.map((file) => [file.path, file.contentHash]));
    const result = staleness({
      totalFiles: this.files.length - this.manualFiles.size,
      unassigned: this.unassigned.length,
      centroids: aiCentroids(this.aiComponents(), (path) => this.embeddings.vector(path)),
      changedFiles: this.baseline ? changedFiles(this.baseline.members, this.aiOwner, hashes) : new Map(),
      baseline: this.baseline,
      componentEdges: componentEdges(this.edges, this.aiOwner),
    });
    return { reasons: [...result.reasons, ...failed], driftedComponents: result.driftedComponents };
  }

  private async ensureBaseline(): Promise<void> {
    const ai = this.effectiveAi();
    if (!ai) return;
    const key = mapKey(ai, this.groupedAt());
    const centroids = aiCentroids(this.aiComponents(), (path) => this.embeddings.vector(path));
    const complete = this.aiComponents().every((component) => centroids.has(component.id));
    const current = this.baseline?.mapKey === key && (this.baseline.complete || !complete);
    if (current && !this.rebuildBaseline) return;
    this.rebuildBaseline = false;
    const hashes = new Map(this.files.map((file) => [file.path, file.contentHash]));
    this.baseline = {
      mapKey: key,
      centroids: Object.fromEntries([...centroids].map(([id, vector]) => [id, Array.from(vector)])),
      componentEdges: [...componentEdges(this.edges, this.aiOwner)],
      members: Object.fromEntries([...this.aiOwner].map(([path, id]) => [path, [id, hashes.get(path) ?? ''] as [string, string]])),
      complete,
    };
    if (this.stopped) return;
    const temp = `${this.baselineFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await mkdir(this.options.stateDir, { recursive: true });
      await writeFile(temp, JSON.stringify(this.baseline));
      await rename(temp, this.baselineFile);
    } catch (error) {
      console.error('map: cannot save the grouping baseline', error);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private status(): MapStatus {
    const embed = this.options.embed.status();
    const groupable = this.files.length - this.manualFiles.size;
    const tooLarge = groupable > MAX_AI_FILES;
    const assignmentWarnings = this.dangling.map(
      (path) => `${MAP_FILE}: assignments["${path}"] names a component that does not exist; it was ignored`,
    );
    return {
      layer: this.effectiveAi() ? 'ai' : 'folder',
      grouping: tooLarge ? 'too-large' : this.grouping,
      groupingError: tooLarge ? `AI grouping is limited to ${MAX_AI_FILES} files; this project has ${groupable}` : this.groupingError,
      groupedAt: this.groupedAt(),
      stale: this.stale.reasons.length > 0,
      staleReasons: this.stale.reasons,
      unassigned: this.unassigned.length,
      pending: this.pending.length,
      sending: this.sending,
      embeddings: embed.state,
      embeddingsError: embed.state === 'unavailable' ? embed.reason : null,
      embeddingPlacement: this.placementStatus(),
      modelDownloadBytes: embed.state === 'downloading' ? embed.bytes : null,
      warnings: [...this.map.warnings, ...(this.writeWarning ? [this.writeWarning] : []), ...assignmentWarnings],
      backgroundAi: this.options.backgroundAi(),
    };
  }

  private placementStatus(): EmbeddingPlacement | null {
    if (!this.effectiveAi()) return null;
    if (!this.rule) return { on: false, detail: 'no calibrated setting' };
    if (this.options.embed.status().state === 'unavailable') return { on: false, detail: 'the embedding model is unavailable' };
    const check = this.placement.check;
    if (!check) return { on: false, detail: 'waiting for embeddings' };
    const setting =
      this.rule.kind === 'threshold' ? `nearest-component similarity ≥ ${this.rule.min}` : `lead over the second-nearest component ≥ ${this.rule.min}`;
    const bound = `${Math.round(check.lowerBound * 1000) / 10} %`;
    return { on: check.passes, detail: `${setting}; ${check.correct} of ${check.assigned} checked placements right, 95 % lower bound ${bound} (needs 90 %)` };
  }

  private signature(status: MapStatus): string {
    return JSON.stringify([this.components, this.stale.driftedComponents, status]);
  }

  private publishIfChanged(): void {
    if (this.started && !this.stopped && this.signature(this.status()) !== this.published) this.options.onChange();
  }

  private effectiveAi(): AiComponent[] | null {
    return this.unsaved?.ai ?? this.map.ai;
  }

  private groupedAt(): string | null {
    return this.unsaved?.groupedAt ?? this.map.groupedAt;
  }

  private aiComponents(): AiComponent[] {
    return this.components
      .filter((component) => component.source === 'ai')
      .map(({ id, name, summary, description, keyFiles, files, globs }) => ({ id, name, summary, description, keyFiles, files, globs }));
  }

  private manualEvidence(map: MapFileData, ai: AiComponent[] | null) {
    const knownIds = new Set([...map.manual.map((component) => component.id), ...(ai ?? []).map((component) => component.id)]);
    return matchManual(
      this.files.map((file) => file.path),
      map.manual,
      map.assignments,
      knownIds,
      (path) => this.manualGlobOwner(path, map),
    );
  }

  // manualGlobOwner depends only on map.manual, so it can be memoized per path for as long as map.hash does not change.
  private manualGlobOwner(path: string, map: MapFileData): string | undefined {
    if (this.manualGlobMemoHash !== map.hash) {
      this.manualGlobMemoHash = map.hash;
      this.manualGlobMemo.clear();
    }
    if (this.manualGlobMemo.has(path)) return this.manualGlobMemo.get(path);
    const id = globOwnerOf(path, map.manual);
    this.manualGlobMemo.set(path, id);
    return id;
  }

  // Globs come from the files the grouping saw, so a file created or deleted meanwhile does not unsettle them.
  private finalize(ai: AiComponent[], map: MapFileData, inputPaths: string[]): AiComponent[] {
    const live = new Set(this.files.map((file) => file.path));
    const manual = this.manualEvidence(map, ai).owner;
    const claimed = ai.map((component) => ({ ...component, files: component.files.filter((path) => !manual.has(path)) }));
    const globs = ownedGlobs(claimed, inputPaths);
    return claimed
      .map((component) => ({ ...component, files: component.files.filter((path) => live.has(path)) }))
      .filter((component) => component.files.length > 0)
      .map((component) => ({
        ...component,
        keyFiles: component.keyFiles.filter((path) => component.files.includes(path)),
        globs: globs.get(component.id) ?? [],
      }));
  }

  private adopt(fresh: MapFileData): void {
    this.map = fresh.writable ? fresh : { ...this.map, writable: false, warnings: fresh.warnings, hash: fresh.hash };
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => console.error('map: update failed', error));
    return this.queue;
  }
}

const groupingKey = (ai: AiComponent[] | null): string =>
  JSON.stringify((ai ?? []).map((c) => [c.id, c.name, c.summary, c.description, c.keyFiles, c.files, c.globs]));

const sameGrouping = (a: AiComponent[] | null, b: AiComponent[] | null): boolean => groupingKey(a) === groupingKey(b);

async function readBaseline(file: string): Promise<GroupingBaseline | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  const json = text === null ? undefined : parseJson(text);
  return isRecord(json) &&
    typeof json.mapKey === 'string' &&
    isRecord(json.centroids) &&
    Array.isArray(json.componentEdges) &&
    isRecord(json.members) &&
    typeof json.complete === 'boolean'
    ? (json as unknown as GroupingBaseline)
    : null;
}
