import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord, parseJson } from '../json';
import type { IndexedFile } from '../model';
import type { EmbedModel } from '../models/types';

export const EMBED_TEXT_CHARS = 2000;
const BATCH_SIZE = 16;
const SAVE_DELAY_MS = 30_000;

export function embeddingText(file: IndexedFile, source: string): string {
  const exported = file.symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name);
  return `${file.path}\n${exported.join(' ')}\n${source.slice(0, EMBED_TEXT_CHARS)}`;
}

export interface EmbeddingIndexOptions {
  root: string;
  cacheFile: string;
  model: EmbedModel;
  saveDelayMs?: number;
  onProgress?: (progress: { done: number; total: number } | null) => void;
}

interface Missing {
  path: string;
  hash: string;
  key: string;
  text: string;
}

export class EmbeddingIndex {
  private readonly root: string;
  private readonly cacheFile: string;
  private readonly model: EmbedModel;
  private readonly saveDelayMs: number;
  private readonly onProgress: ((progress: { done: number; total: number } | null) => void) | undefined;
  private readonly cache = new Map<string, Float32Array>();
  private readonly keyOf = new Map<string, string>();
  private readonly hashOf = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | undefined;
  private unsaved = false;

  constructor(options: EmbeddingIndexOptions) {
    this.root = options.root;
    this.cacheFile = options.cacheFile;
    this.model = options.model;
    this.saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS;
    this.onProgress = options.onProgress;
  }

  async load(): Promise<void> {
    const text = await readFile(this.cacheFile, 'utf8').catch(() => null);
    const json = text === null ? undefined : parseJson(text);
    if (!isRecord(json) || json.model !== this.model.id || !isRecord(json.entries)) return;
    for (const [key, value] of Object.entries(json.entries)) {
      const vector = typeof value === 'string' ? decode(value) : null;
      if (vector) this.cache.set(key, vector);
    }
  }

  vector(path: string): Float32Array | undefined {
    const key = this.keyOf.get(path);
    return key === undefined ? undefined : this.cache.get(key);
  }

  update(files: IndexedFile[], signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.embedMissing(files, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const run = this.saving.then(() => this.saveUnsaved());
    this.saving = run;
    return run;
  }

  private async saveUnsaved(): Promise<void> {
    if (!this.unsaved) return;
    this.unsaved = false;
    try {
      await this.save();
    } catch (error) {
      this.unsaved = true;
      console.error('map: cannot save the embedding cache', error);
    }
  }

  private async embedMissing(files: IndexedFile[], signal: AbortSignal | undefined): Promise<void> {
    const live = new Set(files.map((file) => file.path));
    for (const path of [...this.keyOf.keys()]) {
      if (live.has(path)) continue;
      this.keyOf.delete(path);
      this.hashOf.delete(path);
    }
    const missing: Missing[] = [];
    for (const file of files) {
      if (this.hashOf.get(file.path) === file.contentHash) continue;
      const source = await readFile(join(this.root, file.path), 'utf8').catch(() => null);
      if (source === null) continue;
      const text = embeddingText(file, source);
      const key = createHash('sha1').update(`${this.model.id}\0${text}`).digest('hex');
      if (this.cache.has(key)) this.remember(file.path, file.contentHash, key);
      else missing.push({ path: file.path, hash: file.contentHash, key, text });
    }
    if (missing.length === 0) return;
    this.onProgress?.({ done: 0, total: missing.length });
    try {
      for (let start = 0; start < missing.length; start += BATCH_SIZE) {
        const batch = missing.slice(start, start + BATCH_SIZE);
        const vectors = await untilAborted(this.model.embed(batch.map((entry) => entry.text)), signal);
        batch.forEach((entry, i) => {
          const vector = vectors[i];
          if (!vector) return;
          this.cache.set(entry.key, vector);
          this.remember(entry.path, entry.hash, entry.key);
        });
        this.scheduleSave();
        this.onProgress?.({ done: Math.min(start + BATCH_SIZE, missing.length), total: missing.length });
      }
    } finally {
      this.onProgress?.(null);
    }
  }

  private remember(path: string, hash: string, key: string): void {
    this.keyOf.set(path, key);
    this.hashOf.set(path, hash);
  }

  private scheduleSave(): void {
    this.unsaved = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDelayMs);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    const used = new Set(this.keyOf.values());
    for (const key of [...this.cache.keys()]) if (!used.has(key)) this.cache.delete(key);
    const entries = Object.fromEntries([...this.cache].map(([key, vector]) => [key, encode(vector)]));
    const temp = `${this.cacheFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(temp, JSON.stringify({ model: this.model.id, entries }));
      await rename(temp, this.cacheFile);
    } finally {
      await rm(temp, { force: true });
    }
  }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('embedding cancelled'));
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

const encode = (vector: Float32Array): string => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');

function decode(text: string): Float32Array | null {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
