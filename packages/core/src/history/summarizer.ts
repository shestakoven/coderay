import { createHash } from 'node:crypto';
import type { ChangeView, PlanView, SummaryView } from '@ide/protocol';
import type { IndexedFile } from '../model';
import type { ModelProvider } from '../models/types';
import type { Store } from '../store/store';

type Scope = 'step' | 'component';

export interface SummarizerOptions {
  store: Store;
  provider: Pick<ModelProvider, 'fast'>;
  changes: () => ChangeView[];
  plans: () => PlanView[];
  files: () => IndexedFile[];
  components: () => { id: string; name: string; files: string[] }[];
  isProtected: (rel: string) => boolean;
  now?: () => number;
  debounceMs?: number;
  backoffMs?: number[];
}

interface Entry {
  scope: Scope;
  ref: string;
  key: string;
  tries: number;
  due: number;
  exhausted: boolean;
}

interface Built {
  key: string;
  prompt: string;
}

const MAX_TRIES = 3;
const MAX_CHARS = 200;
const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
      : value;

function cleanAnswer(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const summary = (answer as { summary?: unknown }).summary;
  if (typeof summary !== 'string') return undefined;
  const text = summary.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, MAX_CHARS).trim();
  return text === '' ? undefined : text;
}

export class Summarizer {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(views: SummaryView[]) => void>();
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly backoffMs: number[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;

  constructor(private readonly o: SummarizerOptions) {
    this.now = o.now ?? Date.now;
    this.debounceMs = o.debounceMs ?? 2_000;
    this.backoffMs = o.backoffMs ?? [5_000, 20_000, 60_000];
  }

  request(scope: Scope, ref: string): void {
    const built = this.build(scope, ref);
    if (!built) return;
    if (this.o.store.summaries().some((summary) => summary.key === built.key)) {
      this.entries.delete(`${scope}:${ref}`);
      return;
    }
    const id = `${scope}:${ref}`;
    const existing = this.entries.get(id);
    if (existing && existing.key === built.key && !existing.exhausted && existing.tries > 0) return;
    this.entries.set(id, { scope, ref, key: built.key, tries: 0, due: this.now() + this.debounceMs, exhausted: false });
    this.emit();
    this.schedule();
  }

  onChange(listener: (views: SummaryView[]) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  views(): SummaryView[] {
    const byRef = new Map<string, SummaryView>();
    for (const s of this.o.store.summaries()) byRef.set(`${s.scope}:${s.ref}`, { key: s.key, scope: s.scope, ref: s.ref, text: s.text, pending: false });
    for (const [id, e] of this.entries) byRef.set(id, { key: e.key, scope: e.scope, ref: e.ref, text: null, pending: true });
    return [...byRef.values()];
  }

  private emit(): void {
    const views = this.views();
    for (const listener of this.listeners) {
      try {
        listener(views);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private schedule(): void {
    if (this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const waiting = [...this.entries.values()].filter((e) => !e.exhausted);
    if (waiting.length === 0) return;
    const next = Math.min(...waiting.map((e) => e.due));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, Math.max(0, next - this.now()));
  }

  private async run(): Promise<void> {
    if (this.inFlight) return;
    const now = this.now();
    const ready = [...this.entries.entries()].filter(([, e]) => !e.exhausted && e.due <= now).sort(([, a], [, b]) => a.due - b.due)[0];
    if (!ready) return this.schedule();
    const [id, entry] = ready;
    const built = this.build(entry.scope, entry.ref);
    if (!built) {
      this.entries.delete(id);
      this.emit();
      return this.schedule();
    }
    if (built.key !== entry.key) entry.key = built.key;
    this.inFlight = true;
    let text: string | undefined;
    try {
      text = cleanAnswer(await this.o.provider.fast.generate({ prompt: built.prompt, schema: SCHEMA }));
    } catch {
      text = undefined;
    }
    this.inFlight = false;
    if (text !== undefined) {
      try {
        this.o.store.saveSummary({ key: built.key, scope: entry.scope, ref: entry.ref, text, createdAt: this.now() });
        if (this.entries.get(id)?.key === built.key) this.entries.delete(id);
      } catch {
        text = undefined;
      }
    }
    const current = this.entries.get(id);
    if (text === undefined && current) {
      current.tries += 1;
      if (current.tries >= MAX_TRIES) current.exhausted = true;
      else current.due = this.now() + (this.backoffMs[current.tries - 1] ?? this.backoffMs.at(-1) ?? 0);
    }
    this.emit();
    this.schedule();
  }

  private build(scope: Scope, ref: string): Built | undefined {
    const facts = scope === 'step' ? this.stepFacts(ref) : this.componentFacts(ref);
    if (!facts) return undefined;
    const json = JSON.stringify(canonical({ ...facts, ref, scope }));
    const key = createHash('sha256').update(json).digest('hex');
    const lead =
      scope === 'step'
        ? 'Describe in one sentence, in English, what this plan step did. Use only these facts; the file list is complete and no file contents are available.'
        : 'Describe in one sentence, in English, what changed in this component during this session. Use only these facts; the file list is complete and no file contents are available.';
    const hidden = (facts as { protectedFiles: number }).protectedFiles;
    const prompt = `${lead} Answer with JSON {"summary": "<one sentence>"}.\n${json}\n${hidden} protected file(s) are not listed.`;
    return { key, prompt };
  }

  private filesFacts(changes: ChangeView[], protectedPaths: Set<string>): { files: unknown[]; protectedFiles: number } {
    const symbols = new Map(this.o.files().map((f) => [f.path, f.symbols.filter((s) => s.exported).map((s) => ({ name: s.name, kind: s.kind }))]));
    const net = new Map<string, { added: number; removed: number }>();
    for (const c of changes) {
      if (c.enforcement !== 'enforced' || this.o.isProtected(c.path)) {
        protectedPaths.add(c.path);
        continue;
      }
      const sum = net.get(c.path) ?? { added: 0, removed: 0 };
      sum.added += c.added ?? 0;
      sum.removed += c.removed ?? 0;
      net.set(c.path, sum);
    }
    const files = [...net].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, n]) => ({ path, added: n.added, removed: n.removed, symbols: symbols.get(path) ?? [] }));
    return { files, protectedFiles: protectedPaths.size };
  }

  private stepFacts(ref: string): Record<string, unknown> | undefined {
    const at = ref.lastIndexOf('/');
    if (at < 0) return undefined;
    const plan = this.o.plans().find((p) => p.id === ref.slice(0, at));
    const step = plan?.steps.find((s) => s.key === ref.slice(at + 1));
    if (!plan || !step) return undefined;
    const protectedPaths = new Set<string>();
    const targets: { path?: string; componentId?: string; op: string }[] = [];
    for (const t of step.targets) {
      if (t.path !== undefined && this.o.isProtected(t.path)) protectedPaths.add(t.path);
      else targets.push({ ...(t.path !== undefined ? { path: t.path } : {}), ...(t.componentId !== undefined ? { componentId: t.componentId } : {}), op: t.op });
    }
    const changed = this.o.changes().filter((c) => c.planId === plan.id && c.stepKey === step.key);
    const { files, protectedFiles } = this.filesFacts(changed, protectedPaths);
    return { goal: plan.goal, title: step.title, rationale: step.rationale, targets, files, protectedFiles };
  }

  private componentFacts(ref: string): Record<string, unknown> | undefined {
    const component = this.o.components().find((c) => c.id === ref);
    if (!component) return undefined;
    const members = new Set(component.files);
    const changed = this.o.changes().filter((c) => members.has(c.path));
    const { files, protectedFiles } = this.filesFacts(changed, new Set());
    return { name: component.name, files, protectedFiles };
  }
}
