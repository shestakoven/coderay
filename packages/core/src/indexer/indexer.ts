import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { LanguageAdapter, ParsedFile } from '../lang/types';
import type { IndexedFile } from '../model';
import { createIgnoreMatcher, type IgnoreMatcher } from './ignore';

export const MAX_FILE_BYTES = 1_000_000;

export interface IndexerOptions {
  root: string;
  adapters: LanguageAdapter[];
  debounceMs?: number;
}

export type ChangeListener = (changedPaths: string[]) => void;

export class Indexer {
  private readonly root: string;
  private readonly adapters: LanguageAdapter[];
  private readonly debounceMs: number;
  private readonly isIgnored: IgnoreMatcher;
  private readonly indexed = new Map<string, IndexedFile>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Set<string>();
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: IndexerOptions) {
    this.root = options.root;
    this.adapters = options.adapters;
    this.debounceMs = options.debounceMs ?? 100;
    this.isIgnored = createIgnoreMatcher(options.root);
  }

  async start(): Promise<void> {
    await this.scan('');
    const watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (absPath, stats) => this.isIgnored(this.toRel(absPath), stats?.isDirectory() ?? false),
    });
    watcher.on('all', (_event, absPath) => this.schedule(this.toRel(absPath)));
    this.watcher = watcher;
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
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
      if (changed.size > 0) for (const listener of this.listeners) listener([...changed]);
    });
  }

  private async refresh(relPath: string): Promise<string[]> {
    const info = await stat(join(this.root, relPath)).catch(() => null);
    if (!info) return this.removeUnder(relPath);
    if (info.isDirectory()) return this.scan(relPath);
    return this.indexFile(relPath, info.size);
  }

  private async scan(relDir: string): Promise<string[]> {
    const changed: string[] = [];
    const entries = await readdir(join(this.root, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || this.isIgnored(relPath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        changed.push(...(await this.scan(relPath)));
      } else if (entry.isFile()) {
        const info = await stat(join(this.root, relPath)).catch(() => null);
        if (info) changed.push(...(await this.indexFile(relPath, info.size)));
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
