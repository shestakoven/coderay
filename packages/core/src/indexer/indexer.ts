import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { LanguageAdapter, ParsedFile } from '../lang/types';
import type { IndexedFile } from '../model';
import { watchRecursive, type RecursiveWatch } from '../watch/recursive';
import { createIgnoreMatcher, type IgnoreMatcher } from './ignore';

export const MAX_FILE_BYTES = 1_000_000;
const MAX_WAIT_MS = 1000;

export interface IndexerOptions {
  root: string;
  adapters: LanguageAdapter[];
  debounceMs?: number;
  reconcileDelayMs?: number;
  onProgress?: (indexed: number) => void;
}

export type ChangeListener = (changedPaths: string[]) => void;

export class Indexer {
  private readonly root: string;
  private readonly adapters: LanguageAdapter[];
  private readonly debounceMs: number;
  private readonly reconcileDelayMs: number;
  private readonly isIgnored: IgnoreMatcher;
  private readonly onProgress: ((indexed: number) => void) | undefined;
  private readonly indexed = new Map<string, IndexedFile>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Set<string>();
  private watcher: RecursiveWatch | undefined;
  private timer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private firstPendingAt: number | undefined;
  private live = false;
  private stopping = false;
  private realRoot = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(options: IndexerOptions) {
    this.root = options.root;
    this.adapters = options.adapters;
    this.debounceMs = options.debounceMs ?? 100;
    this.reconcileDelayMs = options.reconcileDelayMs ?? 1000;
    this.isIgnored = createIgnoreMatcher(options.root);
    this.onProgress = options.onProgress;
  }

  async start(): Promise<void> {
    this.realRoot = await realpath(this.root);
    if (this.stopping) return;
    // Events carry no file type, so a file no adapter handles is dropped by refresh() rather than here.
    const watcher = watchRecursive(this.root, {
      ignored: (absPath) => this.isIgnored(this.toRel(absPath), false),
      onEvent: (absPath) => this.schedule(this.toRel(absPath)),
      onError: (error) => console.error('indexer: watch error', error),
    });
    this.watcher = watcher;
    await watcher.ready.catch((error: unknown) => {
      if (!this.stopping) console.error('indexer: watch error', error);
    });
    if (this.stopping) return;
    this.queue = this.queue.then(async () => {
      await this.scan('');
    });
    await this.queue;
    if (this.stopping) return;
    this.live = true;
    if (this.pending.size > 0) this.flush();
    this.reconcileTimer = setTimeout(() => this.reconcile(), this.reconcileDelayMs);
    this.reconcileTimer.unref();
    await this.queue;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    clearTimeout(this.reconcileTimer);
    await this.watcher?.close();
    await this.queue;
  }

  files(): IndexedFile[] {
    return [...this.indexed.values()];
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private toRel(absPath: string): string {
    return relative(this.root, absPath).split(sep).join('/');
  }

  private schedule(relPath: string): void {
    this.pending.add(relPath);
    if (!this.live) return;
    this.firstPendingAt ??= Date.now();
    clearTimeout(this.timer);
    const untilMaxWait = this.firstPendingAt + MAX_WAIT_MS - Date.now();
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.debounceMs, untilMaxWait)));
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.firstPendingAt = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    this.queue = this.queue.then(async () => {
      const changed = new Set<string>();
      for (const relPath of batch) {
        try {
          for (const path of await this.refresh(relPath)) changed.add(path);
        } catch (error) {
          console.error(`indexer: failed to refresh ${relPath}`, error);
        }
      }
      this.notify([...changed]);
    });
  }

  private reconcile(): void {
    this.queue = this.queue.then(async () => {
      const seen = new Set<string>();
      const changed = await this.scan('', seen);
      const removed = [...this.indexed.keys()].filter((path) => !seen.has(path));
      for (const path of removed) this.indexed.delete(path);
      this.notify([...changed, ...removed]);
    });
  }

  private notify(changed: string[]): void {
    if (changed.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(changed);
      } catch (error) {
        console.error('indexer: change listener failed', error);
      }
    }
  }

  private async refresh(relPath: string): Promise<string[]> {
    const absPath = join(this.root, relPath);
    const info = await lstat(absPath).catch(() => null);
    if (!info || info.isSymbolicLink() || !(await this.isExactPath(absPath, relPath))) return this.removeUnder(relPath);
    if (info.isDirectory()) return this.scan(relPath);
    return this.indexFile(relPath, info.size);
  }

  private async isExactPath(absPath: string, relPath: string): Promise<boolean> {
    const real = await realpath(absPath).catch(() => null);
    return real === join(this.realRoot, relPath);
  }

  private async scan(relDir: string, seen?: Set<string>): Promise<string[]> {
    const changed: string[] = [];
    const entries = await readdir(join(this.root, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || this.isIgnored(relPath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        changed.push(...(await this.scan(relPath, seen)));
      } else if (entry.isFile()) {
        const info = await lstat(join(this.root, relPath)).catch(() => null);
        if (!info?.isFile()) continue;
        seen?.add(relPath);
        const indexedPaths = await this.indexFile(relPath, info.size);
        changed.push(...indexedPaths);
        if (!this.live && indexedPaths.length > 0) this.onProgress?.(this.indexed.size);
      }
    }
    return changed;
  }

  private async indexFile(relPath: string, size: number): Promise<string[]> {
    const adapter = this.adapters.find((a) => a.handles(relPath));
    if (!adapter || size > MAX_FILE_BYTES) return this.removeUnder(relPath);
    const source = await readFile(join(this.root, relPath), 'utf8').catch(() => null);
    if (source === null) return this.removeUnder(relPath);
    const contentHash = createHash('sha1').update(source).digest('hex');
    if (this.indexed.get(relPath)?.contentHash === contentHash) return [];
    this.indexed.set(relPath, { path: relPath, lang: adapter.lang, contentHash, ...safeParse(adapter, relPath, source) });
    return [relPath];
  }

  private removeUnder(relPath: string): string[] {
    const removed = [...this.indexed.keys()].filter((p) => p === relPath || p.startsWith(`${relPath}/`));
    for (const path of removed) this.indexed.delete(path);
    return removed;
  }
}

function safeParse(adapter: LanguageAdapter, relPath: string, source: string): ParsedFile {
  try {
    return adapter.parse(relPath, source);
  } catch {
    return { imports: [], symbols: [], parseError: true };
  }
}
