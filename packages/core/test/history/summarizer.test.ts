import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeView, PlanView, SummaryView } from '@ide/protocol';
import { guardedMatcher } from '../../src/gate/paths';
import { Summarizer, type SummarizerOptions } from '../../src/history/summarizer';
import type { IndexedFile } from '../../src/model';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { GatedModel, ScriptedModel } from '../models/fake-models';
import { indexed, tempDir } from '../helpers';

const SENTINEL = 'SECRET_SENTINEL';
const guarded = guardedMatcher(DEFAULT_POLICY);
const harness = ignore().add(DEFAULT_POLICY.harness);
const isProtected = (rel: string): boolean => guarded.ignores(rel) || harness.ignores(rel);

const change = (path: string, o: Partial<ChangeView> = {}): ChangeView => ({
  id: `c-${path}`, path, beforeHash: 'b', afterHash: 'a', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false, toolUseIds: ['t'],
  planId: 'p1', planVersion: 1, stepKey: 's1', eventId: null, resolution: null, added: 3, removed: 1, stored: true, unreadable: false, beforeMode: null, ...o,
});

const plan = (o: Partial<PlanView> = {}): PlanView => ({
  id: 'p1', version: 1, goal: 'Make greetings friendlier', status: 'approved', approvedBy: 'user-card',
  steps: [{ key: 's1', order: 1, title: 'Fix the greeting', rationale: 'The greeting is too curt', targets: [{ path: 'src/a.ts', op: 'modify' }, { path: '.env', op: 'modify' }], status: 'active' }],
  scope: { paths: [], globs: [] }, owners: {}, review: {} as PlanView['review'], feedback: null, proposedAt: 1, decidedAt: null, ...o,
});

const file = (path: string, names: [string, boolean][] = []): IndexedFile =>
  indexed(path, 'typescript', [], { symbols: names.map(([name, exported], i) => ({ name, kind: 'function', startLine: i, endLine: i, exported })) });

interface Setup {
  changes?: ChangeView[];
  plans?: PlanView[];
  files?: IndexedFile[];
  components?: { id: string; name: string; files: string[] }[];
  provider?: { fast: ScriptedModel | GatedModel };
}

function setup(s: Setup = {}) {
  const store = openStore(tempDir('sum-store-'));
  const state = {
    changes: s.changes ?? [change('src/a.ts')],
    plans: s.plans ?? [plan()],
    files: s.files ?? [file('src/a.ts', [['greet', true]])],
    components: s.components ?? [{ id: 'c1', name: 'Greeter', files: ['src/a.ts', '.env'] }],
  };
  const model = s.provider?.fast ?? new ScriptedModel({ summary: 'Greets politely.' });
  const options: SummarizerOptions = {
    store, provider: { fast: model }, changes: () => state.changes, plans: () => state.plans, files: () => state.files,
    components: () => state.components, isProtected,
  };
  const summarizer = new Summarizer(options);
  const requests = (): { prompt: string }[] => (model as ScriptedModel).requests;
  const settle = () => vi.advanceTimersByTimeAsync(2_000);
  return { store, state, model, options, summarizer, requests, settle };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Summarizer prompt', () => {
  it('is built from names and counts only', async () => {
    const dir = tempDir('sum-work-');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), `export const greet = () => '${SENTINEL}';\n`);
    writeFileSync(join(dir, '.env'), `TOKEN=${SENTINEL}\n`);
    const f = setup({
      changes: [
        change('src/a.ts'),
        change('.env'),
        change('.omc/x'),
        change('debug.log', { enforcement: 'recorded' }),
        change('src/a.ts', { id: 'c2', added: 2, removed: 0 }),
      ],
      files: [file('src/a.ts', [['greet', true], [`hidden${SENTINEL}`, false]]), file('.env', [[`secret${SENTINEL}`, true]])],
    });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.requests()).toHaveLength(1);
    const prompt = f.requests()[0]!.prompt;
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('Fix the greeting');
    expect(prompt).toContain('The greeting is too curt');
    expect(prompt).toContain('Make greetings friendlier');
    expect(prompt).toContain('greet');
    expect(prompt).toContain('"added":5');
    expect(prompt).toContain('"removed":1');
    expect(prompt).toContain('3 protected file(s)');
    expect(prompt).not.toContain(SENTINEL);
    expect(prompt).not.toContain('.env');
    expect(prompt).not.toContain('.omc');
    expect(prompt).not.toContain('debug.log');
    expect(prompt).not.toMatch(/^[+-][^+-]/m);
    expect(prompt).not.toContain('@@');
  });

  it('describes a component from its changed enforced files, ignoring unassigned ones', async () => {
    const f = setup({
      changes: [change('src/a.ts'), change('.env'), change('other/b.ts')],
      files: [file('src/a.ts', [['greet', true]]), file('other/b.ts', [['orphan', true]])],
    });
    f.summarizer.request('component', 'c1');
    await f.settle();
    const prompt = f.requests()[0]!.prompt;
    expect(prompt).toContain('Greeter');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('greet');
    expect(prompt).toContain('1 protected file(s)');
    expect(prompt).not.toContain('other/b.ts');
    expect(prompt).not.toContain('orphan');
    expect(prompt).not.toContain('.env');
  });

  it('summarizes a step with no changes', async () => {
    const f = setup({ changes: [] });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.requests()).toHaveLength(1);
    expect(f.requests()[0]!.prompt).toContain('Fix the greeting');
    expect(f.summarizer.views()).toMatchObject([{ scope: 'step', ref: 'p1/s1', text: 'Greets politely.', pending: false }]);
  });

  it('ignores a request for an unknown step or component', async () => {
    const f = setup();
    f.summarizer.request('step', 'p1/nope');
    f.summarizer.request('component', 'zzz');
    await f.settle();
    expect(f.requests()).toHaveLength(0);
    expect(f.summarizer.views()).toEqual([]);
  });
});

describe('Summarizer cache', () => {
  it('makes no call for a stored input, also after a restart', async () => {
    const f = setup();
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.requests()).toHaveLength(1);
    const restarted = new Summarizer(f.options);
    restarted.request('step', 'p1/s1');
    await f.settle();
    expect(f.requests()).toHaveLength(1);
    expect(restarted.views()).toMatchObject([{ text: 'Greets politely.', pending: false }]);
  });

  it('calls the model again when the input changes', async () => {
    const f = setup({ provider: { fast: new ScriptedModel({ summary: 'One.' }, { summary: 'Two.' }) } });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    f.state.changes = [change('src/a.ts', { added: 9 })];
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.requests()).toHaveLength(2);
    const views = f.summarizer.views();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ text: 'Two.', pending: false });
  });

  it('keys two steps with the same facts apart', async () => {
    const two = plan({ steps: [...plan().steps, { key: 's2', order: 2, title: 'Fix the greeting', rationale: 'The greeting is too curt', targets: plan().steps[0]!.targets, status: 'pending' }] });
    const f = setup({ plans: [two] });
    f.summarizer.request('step', 'p1/s1');
    f.summarizer.request('step', 'p1/s2');
    await f.settle();
    await f.settle();
    expect(f.summarizer.views().map((v) => v.ref).sort()).toEqual(['p1/s1', 'p1/s2']);
  });
});

describe('Summarizer scheduling', () => {
  it('debounces a burst of requests into one call after 2 s', async () => {
    const f = setup();
    f.summarizer.request('step', 'p1/s1');
    await vi.advanceTimersByTimeAsync(1_500);
    f.summarizer.request('step', 'p1/s1');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.requests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(f.requests()).toHaveLength(1);
  });

  it('keeps one request in flight', async () => {
    const gated = new GatedModel();
    const f = setup({ provider: { fast: gated }, components: [{ id: 'c1', name: 'Greeter', files: ['src/a.ts'] }] });
    f.summarizer.request('step', 'p1/s1');
    f.summarizer.request('component', 'c1');
    await f.settle();
    expect(gated.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gated.requests).toHaveLength(1);
    gated.answer({ summary: 'First.' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(gated.requests).toHaveLength(2);
    gated.answer({ summary: 'Second.' });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.summarizer.views().map((v) => v.text).sort()).toEqual(['First.', 'Second.']);
  });

  it('stays pending after a failing provider and retries with backoff', async () => {
    let calls = 0;
    const flaky = new ScriptedModel(() => {
      calls += 1;
      if (calls < 3) throw new Error('haiku is down');
      return { summary: 'Finally.' };
    });
    const f = setup({ provider: { fast: flaky } });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(calls).toBe(1);
    expect(f.summarizer.views()).toEqual([{ key: expect.any(String), scope: 'step', ref: 'p1/s1', text: null, pending: true }]);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(19_800);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(3);
    expect(f.summarizer.views()).toMatchObject([{ text: 'Finally.', pending: false }]);
  });

  it('gives up after three tries and leaves the view pending', async () => {
    const f = setup({ provider: { fast: new ScriptedModel(() => { throw new Error('down'); }) } });
    f.summarizer.request('step', 'p1/s1');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.requests()).toHaveLength(3);
    expect(f.summarizer.views()).toMatchObject([{ text: null, pending: true }]);
  });

  it('retries a fresh request after giving up', async () => {
    let fail = true;
    const f = setup({ provider: { fast: new ScriptedModel(() => (fail ? Promise.reject(new Error('down')) : { summary: 'Back.' })) } });
    f.summarizer.request('step', 'p1/s1');
    await vi.advanceTimersByTimeAsync(200_000);
    fail = false;
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.summarizer.views()).toMatchObject([{ text: 'Back.', pending: false }]);
  });
});

describe('Summarizer answers', () => {
  it.each([
    ['an empty string', { summary: '' }],
    ['only whitespace', { summary: ' \n ' }],
    ['a non-string', { summary: 42 }],
    ['a missing field', { text: 'x' }],
    ['a non-object', 'Greets.'],
    ['null', null],
  ])('retries after %s and then accepts a good answer', async (_name, bad) => {
    const f = setup({ provider: { fast: new ScriptedModel(bad, { summary: 'Good.' }) } });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.summarizer.views()).toMatchObject([{ text: null, pending: true }]);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(f.summarizer.views()).toMatchObject([{ text: 'Good.', pending: false }]);
    expect(f.store.summaries()).toHaveLength(1);
  });

  it('leaves the view pending when every answer is invalid', async () => {
    const f = setup({ provider: { fast: new ScriptedModel({ summary: '' }) } });
    f.summarizer.request('step', 'p1/s1');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.requests()).toHaveLength(3);
    expect(f.summarizer.views()).toMatchObject([{ text: null, pending: true }]);
    expect(f.store.summaries()).toEqual([]);
  });

  it('cuts at 200 characters and strips newlines', async () => {
    const f = setup({ provider: { fast: new ScriptedModel({ summary: `${'x'.repeat(250)}` }, { summary: 'one\ntwo\r\nthree' }) } });
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.summarizer.views()[0]!.text).toBe('x'.repeat(200));
    f.state.changes = [change('src/a.ts', { added: 99 })];
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(f.summarizer.views()[0]!.text).toBe('one two three');
  });
});

describe('Summarizer onChange', () => {
  it('fires when a view appears as pending and when it resolves, and stops after unsubscribe', async () => {
    const f = setup();
    const seen: SummaryView[][] = [];
    const off = f.summarizer.onChange((views) => seen.push(views));
    f.summarizer.request('step', 'p1/s1');
    expect(seen.at(-1)).toMatchObject([{ pending: true, text: null }]);
    await f.settle();
    expect(seen.at(-1)).toMatchObject([{ pending: false, text: 'Greets politely.' }]);
    const count = seen.length;
    off();
    f.state.changes = [change('src/a.ts', { added: 50 })];
    f.summarizer.request('step', 'p1/s1');
    await f.settle();
    expect(seen).toHaveLength(count);
  });
});
