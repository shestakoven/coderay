import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EmbedModel, EmbedStatus } from './types';

export const BGE_SMALL = {
  id: 'Xenova/bge-small-en-v1.5',
  pooling: 'cls',
  weightsFile: 'onnx/model_quantized.onnx',
  downloadBytes: 34_726_871,
} as const;

export const READY_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSED_MESSAGE = 'embedding model closed';

export interface LocalEmbedOptions {
  cacheDir: string;
  workerUrl?: URL;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; dims: number[]; data: Float32Array }
  | { type: 'failed'; id: number; message: string };

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

export class LocalEmbedModel implements EmbedModel {
  readonly id = BGE_SMALL.id;
  private current: EmbedStatus;
  private readonly listeners = new Set<(status: EmbedStatus) => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly readyTimer: NodeJS.Timeout;
  private settleReady: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private nextId = 1;
  private closed = false;

  constructor(options: LocalEmbedOptions) {
    const cached = existsSync(join(options.cacheDir, BGE_SMALL.id, BGE_SMALL.weightsFile));
    this.current = cached ? { state: 'loading' } : { state: 'downloading', bytes: BGE_SMALL.downloadBytes };
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = { resolve, reject };
    });
    this.ready.catch(() => undefined);
    this.readyTimer = setTimeout(() => this.fail('timed out loading the embedding model'), READY_TIMEOUT_MS).unref();
    this.worker = new Worker(options.workerUrl ?? new URL('./embed-worker.ts', import.meta.url), {
      workerData: { cacheDir: options.cacheDir, modelId: BGE_SMALL.id, pooling: BGE_SMALL.pooling },
    });
    this.worker.unref();
    this.worker.on('message', (message: WorkerMessage) => this.handle(message));
    this.worker.on('error', (error) => this.fail(error.message));
    this.worker.on('exit', (code) => this.fail(`embedding worker exited with code ${code}`));
  }

  status(): EmbedStatus {
    return this.current;
  }

  onStatus(listener: (status: EmbedStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    await this.ready;
    if (this.closed) throw new Error(CLOSED_MESSAGE);
    if (this.current.state === 'unavailable') throw new Error(this.current.reason);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, texts });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.readyTimer);
    const error = new Error(CLOSED_MESSAGE);
    this.settleReady?.reject(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    await this.worker.terminate();
  }

  private handle(message: WorkerMessage): void {
    if (message.type === 'ready') {
      clearTimeout(this.readyTimer);
      this.setStatus({ state: 'ready' });
      this.settleReady?.resolve();
    } else if (message.type === 'error') {
      this.fail(message.message);
    } else {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === 'failed') entry?.reject(new Error(message.message));
      else entry?.resolve(rows(message.data, message.dims));
    }
  }

  private fail(reason: string): void {
    if (this.closed || this.current.state === 'unavailable') return;
    clearTimeout(this.readyTimer);
    this.setStatus({ state: 'unavailable', reason });
    const error = new Error(reason);
    this.settleReady?.reject(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void this.worker.terminate();
  }

  private setStatus(status: EmbedStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
}

function rows(data: Float32Array, dims: number[]): Float32Array[] {
  const [count = 0, width = 0] = dims;
  return Array.from({ length: count }, (_, row) => data.slice(row * width, (row + 1) * width));
}
