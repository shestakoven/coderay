import { posix } from 'node:path';
import type { EmbedModel, EmbedStatus, GenerateOptions, StructuredModel, StructuredRequest } from '../../src/models/types';

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

type Answer = unknown | ((request: StructuredRequest) => unknown);
const answerTo = (answer: Answer, request: StructuredRequest): unknown =>
  typeof answer === 'function' ? (answer as (request: StructuredRequest) => unknown)(request) : answer;

export class ScriptedModel implements StructuredModel {
  readonly requests: StructuredRequest[] = [];
  private readonly answers: Answer[];

  constructor(...answers: Answer[]) {
    this.answers = answers;
  }

  async generate(request: StructuredRequest): Promise<unknown> {
    this.requests.push(request);
    return answerTo(this.answers[Math.min(this.requests.length, this.answers.length) - 1], request);
  }
}

export class GatedModel implements StructuredModel {
  readonly requests: StructuredRequest[] = [];
  cancelled = false;
  private pending: { request: StructuredRequest; resolve: (value: unknown) => void } | undefined;

  generate(request: StructuredRequest, { signal }: GenerateOptions = {}): Promise<unknown> {
    this.requests.push(request);
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve };
      signal?.addEventListener(
        'abort',
        () => {
          this.cancelled = true;
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    });
  }

  answer(answer: Answer): void {
    const pending = this.pending;
    if (!pending) throw new Error('GatedModel: no request is waiting');
    this.pending = undefined;
    pending.resolve(answerTo(answer, pending.request));
  }
}

export function promptGroups(prompt: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of prompt.split('\n')) {
    const id = /^(g\d+) \(/.exec(line)?.[1];
    if (id) {
      current = [];
      groups.set(id, current);
    } else if (current && line.startsWith('  ') && !line.startsWith('  …')) {
      current.push(line.trim().split(' ')[0]!);
    } else {
      current = undefined;
    }
  }
  return groups;
}

export interface FakeComponent {
  name: string;
  groups: string[];
}

export const groupingAnswer = (components: FakeComponent[], moves: { file: string; component: string }[] = []) => ({
  components: components.map(({ name }) => ({ name, summary: `${name} summary`, description: `${name} description.`, keyFiles: [] })),
  groups: Object.fromEntries(components.flatMap(({ name, groups }) => groups.map((id) => [id, name]))),
  moves,
});

export function componentsPerDirectory(request: StructuredRequest): unknown {
  const byDir = new Map<string, string[]>();
  for (const [id, files] of promptGroups(request.prompt)) {
    const dir = posix.dirname(files[0] ?? '.');
    byDir.set(dir, [...(byDir.get(dir) ?? []), id]);
  }
  const title = (dir: string) => posix.basename(dir).charAt(0).toUpperCase() + posix.basename(dir).slice(1);
  return groupingAnswer([...byDir].map(([dir, groups]) => ({ name: title(dir), groups })));
}

export function componentPerGroup(request: StructuredRequest): unknown {
  return groupingAnswer([...promptGroups(request.prompt).keys()].map((id) => ({ name: `Part ${id.slice(1)}`, groups: [id] })));
}
