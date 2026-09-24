import { posix } from 'node:path';
import type { EmbedModel, EmbedStatus } from '../../src/models/types';

const DIR_DIMS = 64;
const NAME_DIMS = 16;
const hash = (text: string) => [...text].reduce((h, char) => (h * 31 + char.charCodeAt(0)) >>> 0, 7);

export interface FakeEmbedOptions {
  status?: EmbedStatus;
  id?: string;
  alias?: Record<string, string>;
}

export class FakeEmbedModel implements EmbedModel {
  readonly id: string;
  readonly calls: string[][] = [];
  private readonly current: EmbedStatus;
  private readonly alias: Record<string, string>;
  private readonly dirs = new Map<string, number>();
  private gate: Promise<void> | undefined;

  constructor(options: FakeEmbedOptions = {}) {
    this.id = options.id ?? 'fake-embed';
    this.current = options.status ?? { state: 'ready' };
    this.alias = options.alias ?? {};
  }

  status(): EmbedStatus {
    return this.current;
  }

  onStatus(): () => void {
    return () => undefined;
  }

  hold(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = undefined;
      release();
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    if (this.current.state === 'unavailable') throw new Error(this.current.reason);
    await this.gate;
    return texts.map((text) => this.vectorFor(text.slice(0, text.indexOf('\n'))));
  }

  vectorFor(path: string): Float32Array {
    const dir = this.alias[posix.dirname(path)] ?? posix.dirname(path);
    const dirIndex = this.dirs.get(dir) ?? this.dirs.size % DIR_DIMS;
    this.dirs.set(dir, dirIndex);
    const vector = new Float32Array(DIR_DIMS + NAME_DIMS);
    vector[dirIndex] = 1;
    vector[DIR_DIMS + (hash(posix.basename(path)) % NAME_DIMS)] = 0.2;
    const norm = Math.hypot(1, 0.2);
    return vector.map((value) => value / norm);
  }
}
