import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BackgroundAiStatus, EngineStatus } from '@ide/protocol';
import type { Engine } from '../../src/agent/engines/registry';
import { BackgroundAi, BackgroundAiOff, BackgroundAiStore, movedOn, OFF_RECHECK_MS, offHint } from '../../src/models/background-ai';
import type { StructuredModel } from '../../src/models/types';
import { FakeEmbedModel, GatedModel, ScriptedModel } from './fake-models';
import { tempDir } from '../helpers';

const REQUEST = { prompt: 'p', schema: { type: 'object' } };
type FakeEngine = Engine & { probes: number; backgrounds: number };
function engine(id: Engine['id'], state: EngineStatus['state'], model: StructuredModel | string | null, hint = `${id} hint`): FakeEngine {
  const fake: FakeEngine = {
    id, capabilities: {} as never, probes: 0, backgrounds: 0,
    status: async () => { fake.probes += 1; return { engine: id, state, hint: state === 'ready' ? null : hint }; },
    listModels: async () => [],
    start: () => { throw new Error('not a chat'); },
    background: async (choice) => { fake.backgrounds += 1; return typeof model === 'string' ? model : model ? { modelId: choice ?? `${id}-default`, model } : null; },
  };
  return fake;
}
const embed = () => Object.assign(new FakeEmbedModel(), { close: async () => undefined });
const ai = (engines: Engine[], dir: string, extra: Partial<ConstructorParameters<typeof BackgroundAi>[0]> = {}) =>
  new BackgroundAi({ engines: () => engines, embed: embed(), store: new BackgroundAiStore(dir), ...extra });
const turns = () => new Promise((resolve) => setImmediate(resolve));
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
}

describe('BackgroundAi', () => {
  it('auto takes the first ready engine with a model in order, caches the pick, and reports each change once', async (t) => {
    const dir = tempDir('bg-ai-', t);
    const claude = engine('claude', 'ready', null);
    const provider = ai([claude, engine('codex', 'ready', new ScriptedModel({ a: 1 })), engine('opencode', 'ready', new ScriptedModel({ b: 2 }))], dir);
    const seen: string[] = [];
    provider.onChange((status) => seen.push(status.state));
    expect(await provider.fast.generate(REQUEST)).toEqual({ a: 1 });
    expect(await provider.reasoning.generate(REQUEST)).toEqual({ a: 1 });
    expect([claude.probes, claude.backgrounds]).toEqual([1, 1]);
    expect(provider.status()).toEqual({ state: 'ready', engine: 'codex', modelId: 'codex-default', note: null });
    provider.refresh();
    provider.refresh();
    expect(await provider.fast.generate(REQUEST)).toEqual({ a: 1 });
    expect(seen).toEqual(['ready', 'checking', 'ready']);
  });

  it('with no ready engine every call fails at once with the hint, nothing is probed again until a probe sees another state, and a re-check is asked for', async (t) => {
    fakeTimers();
    const dir = tempDir('bg-ai-', t);
    const claude = engine('claude', 'missing', null, 'Install Claude Code: claude is not on the PATH.');
    let rechecks = 0;
    const provider = ai([claude], dir, { recheck: () => { rechecks += 1; } });
    await expect(provider.fast.generate(REQUEST)).rejects.toBeInstanceOf(BackgroundAiOff);
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow('No AI engine is installed');
    expect(provider.status()).toMatchObject({ state: 'off', reason: 'none', engine: null });
    // Codex is no engine this pick saw: a change of its state picks nothing again.
    provider.enginesChanged([{ engine: 'claude', state: 'missing', hint: 'x' }, { engine: 'codex', state: 'ready', hint: null }]);
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow();
    expect(claude.probes).toBe(1);
    provider.enginesChanged([{ engine: 'claude', state: 'ready', hint: null }]);
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow();
    expect(claude.probes).toBe(2);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(rechecks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rechecks).toBe(1);
  });

  it('a failed engine is skipped for ten minutes and the next one answers, without asking the failed one again, unless a refresh forgets it; Settings shows it failed, not ready', async (t) => {
    const dir = tempDir('bg-ai-', t);
    const down = new Set<Engine['id']>(['claude']);
    const answering = (id: Engine['id'], failure: string) => engine(id, 'ready', new ScriptedModel(() => {
      if (down.has(id)) throw new Error(failure);
      return { ok: id };
    }));
    const claude = answering('claude', 'claude exited with code 1: Not logged in, key sk-ant-api03-abcdefghijklmnopqrstuv');
    const codex = answering('codex', 'codex failed');
    let now = 0;
    const provider = ai([claude, codex, answering('opencode', 'opencode failed')], dir, { now: () => now });
    const first = await Promise.allSettled([provider.fast.generate(REQUEST), provider.fast.generate(REQUEST)]);
    const reason = 'claude exited with code 1: Not logged in, key [key hidden]';
    expect(first.map((result) => result.status === 'rejected' && (result.reason as Error).message)).toEqual([reason, reason]);
    expect(await provider.fast.generate(REQUEST)).toEqual({ ok: 'codex' });
    expect(await provider.fast.generate(REQUEST)).toEqual({ ok: 'codex' });
    expect([claude.backgrounds, codex.backgrounds]).toEqual([1, 1]);
    expect(provider.status()).toEqual({ state: 'ready', engine: 'codex', modelId: 'codex-default', note: `Claude Code failed: ${reason}` });
    const ready = (id: Engine['id']): EngineStatus => ({ engine: id, state: 'ready', hint: null });
    const signedOut: EngineStatus = { engine: 'claude', state: 'signed-out', hint: 'Run claude /login.' };
    const shown = (statuses: EngineStatus[]) => provider.view(statuses, []).options.map((option) => option.status);
    // A probe that is not ready already says why.
    expect([shown([ready('claude'), ready('codex')]), shown([signedOut])]).toEqual([
      [{ engine: 'claude', state: 'error', hint: `Claude Code failed: ${reason}` }, ready('codex'), null], [signedOut, null, null],
    ]);
    provider.refresh();
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow('Not logged in');
    expect(claude.backgrounds).toBe(2);
    // Codex fails just before Claude's ten minutes are up: opencode answers. One failing at ten minutes brings Claude back.
    down.add('codex');
    now = 10 * 60_000 - 1;
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow('codex failed');
    expect(await provider.fast.generate(REQUEST)).toEqual({ ok: 'opencode' });
    down.add('opencode');
    down.delete('claude');
    now = 10 * 60_000;
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow('opencode failed');
    expect(await provider.fast.generate(REQUEST)).toEqual({ ok: 'claude' });
  });

  it('an explicit engine runs its chosen model; one that is not ready is off, not auto, with no other to choose when the core runs it alone, and another core on the same home follows the choice', async (t) => {
    const dir = tempDir('bg-ai-', t);
    const engines = () => [engine('claude', 'ready', new ScriptedModel({ a: 1 })), engine('opencode', 'signed-out', null, 'Run opencode auth login.')];
    const other = ai(engines(), dir);
    const provider = ai(engines(), dir);
    expect(await other.fast.generate(REQUEST)).toEqual({ a: 1 });
    provider.setChoice({ mode: 'engine', engine: 'opencode', model: null });
    await expect(provider.fast.generate(REQUEST)).rejects.toThrow('Choose another engine in Settings');
    expect(provider.status()).toMatchObject({ state: 'off', reason: 'unavailable', engine: 'opencode', hint: expect.stringContaining('opencode is signed out') });
    await expect(other.fast.generate(REQUEST)).rejects.toThrow('Choose another engine in Settings');
    provider.setChoice({ mode: 'engine', engine: 'claude', model: 'opus' });
    expect(await provider.fast.generate(REQUEST)).toEqual({ a: 1 });
    expect(provider.status()).toMatchObject({ state: 'ready', engine: 'claude', modelId: 'opus' });
    // A model of another engine in the file is no model of the chosen one.
    writeFileSync(join(dir, 'background-ai.json'), JSON.stringify({ choice: { mode: 'engine', engine: 'claude', model: 'codex:gpt-6' }, onboarded: true }));
    expect(provider.choice()).toEqual({ mode: 'engine', engine: 'claude', model: null });
    // An engine with a reason to run no background call is passed over calmly: no failure, its sentence as the note or the hint.
    const unverified = 'Codex 0.164.0 is newer than CodeRay has checked for background calls; chats are not affected';
    const calm = ai([engine('codex', 'ready', unverified), engine('opencode', 'ready', new ScriptedModel({ b: 2 }))], tempDir('bg-ai-', t));
    expect(await calm.fast.generate(REQUEST)).toEqual({ b: 2 });
    expect(calm.status()).toMatchObject({ state: 'ready', engine: 'opencode', note: unverified });
    calm.setChoice({ mode: 'engine', engine: 'codex', model: null });
    await expect(calm.fast.generate(REQUEST)).rejects.toThrow(`${unverified}. Choose another engine in Settings → Background AI.`);
    // The only engine of the core, with a hint that names it: said once, and no other engine to choose.
    const only = ai([engine('claude', 'missing', null, 'Install Claude Code: claude is not on the PATH.')], tempDir('bg-ai-', t));
    only.setChoice({ mode: 'engine', engine: 'claude', model: null });
    await expect(only.fast.generate(REQUEST)).rejects.toBeInstanceOf(BackgroundAiOff);
    expect(only.status()).toMatchObject({ state: 'off', hint: 'Install Claude Code: claude is not on the PATH.' });
  });

  it('Off makes no call, probes no engine and asks for no re-check, and neither does a ready AI', async (t) => {
    fakeTimers();
    const dir = tempDir('bg-ai-', t);
    const claude = engine('claude', 'ready', new ScriptedModel({ a: 1 }));
    let rechecks = 0;
    const provider = ai([claude], dir, { recheck: () => { rechecks += 1; } });
    provider.setChoice({ mode: 'off' });
    await expect(provider.fast.generate(REQUEST)).rejects.toBeInstanceOf(BackgroundAiOff);
    vi.advanceTimersByTime(OFF_RECHECK_MS);
    expect(claude.probes + claude.backgrounds + rechecks).toBe(0);
    expect(provider.status()).toEqual({ state: 'off', reason: 'choice', engine: null, hint: 'Background AI is off. Turn it on in Settings → Background AI.' });
    provider.setChoice({ mode: 'auto' });
    expect(await provider.fast.generate(REQUEST)).toEqual({ a: 1 });
    vi.advanceTimersByTime(OFF_RECHECK_MS);
    expect(rechecks).toBe(0);
  });

  it('an aborted call neither waits for a slow pick nor counts as a failure, and a stale pick never serves a call or overwrites a newer status', async (t) => {
    const dir = tempDir('bg-ai-', t);
    let release: (status: EngineStatus) => void = () => undefined;
    const slow = new Promise<EngineStatus>((resolve) => { release = resolve; });
    const provider = ai([engine('claude', 'ready', new ScriptedModel({ a: 1 }))], dir, { status: () => slow });
    const abort = new AbortController();
    const pending = provider.fast.generate(REQUEST, { signal: abort.signal });
    const waiting = provider.fast.generate(REQUEST).catch((error: unknown) => error);
    abort.abort();
    await expect(pending).rejects.toThrow('cancelled');
    provider.setChoice({ mode: 'off' });
    release({ engine: 'claude', state: 'ready', hint: null });
    await turns();
    expect(provider.status()).toMatchObject({ state: 'off', reason: 'choice' });
    expect(await waiting).toBeInstanceOf(BackgroundAiOff);

    const gated = new GatedModel();
    const running = ai([engine('claude', 'ready', gated)], tempDir('bg-ai-', t));
    const call = new AbortController();
    const answer = running.fast.generate(REQUEST, { signal: call.signal });
    await turns();
    call.abort();
    await expect(answer).rejects.toThrow('cancelled');
    expect([gated.requests.length, running.status()]).toEqual([1, { state: 'ready', engine: 'claude', modelId: 'claude-default', note: null }]);
  });

  it('offHint names the install step, keeps an engine hint that names its engine, says which engine failed or has no such model, and hides secrets', () => {
    const missing = (engine: Engine['id'], hint: string): EngineStatus => ({ engine, state: 'missing', hint });
    expect(offHint({ mode: 'auto' }, [missing('claude', 'x'), missing('codex', 'y')], [], new Map())).toBe('No AI engine is installed. Install Claude Code, Codex or opencode and sign in; the map and chat work without one.');
    expect(offHint({ mode: 'engine', engine: 'codex', model: null }, [{ engine: 'codex', state: 'signed-out', hint: 'Codex is signed out: run codex login.' }], [], new Map()))
      .toBe('Codex is signed out: run codex login. Choose another engine in Settings → Background AI.');
    expect(offHint({ mode: 'engine', engine: 'codex', model: null }, [{ engine: 'codex', state: 'signed-out', hint: 'This Codex account is signed out: add it again.' }], [], new Map()))
      .toBe('This Codex account is signed out: add it again. Choose another engine in Settings → Background AI.');
    const ready: EngineStatus = { engine: 'codex', state: 'ready', hint: null };
    expect([
      offHint({ mode: 'engine', engine: 'codex', model: null }, [ready], [], new Map([['codex', 'codex turn failed: 401']])),
      offHint({ mode: 'engine', engine: 'codex', model: 'codex:gone' }, [ready], ['codex'], new Map()),
    ]).toEqual([
      'Codex failed: codex turn failed: 401. Choose another engine in Settings → Background AI.',
      'Codex lists no model for this choice. Choose another engine in Settings → Background AI.',
    ]);
    expect(offHint({ mode: 'auto' }, [{ engine: 'codex', state: 'error', hint: 'OpenAI rejected the API key sk-proj-abcdefghijklmnop' }], [], new Map())).not.toContain('sk-proj');
  });

  it('movedOn: the AI moved on when it is ready after off or on another engine or model, not on the first status or the same engine', () => {
    const on = (engine: Engine['id'], modelId: string, note: string | null = null): BackgroundAiStatus => ({ state: 'ready', engine, modelId, note });
    const off: BackgroundAiStatus = { state: 'off', reason: 'none', engine: null, hint: 'h' };
    const rows: [BackgroundAiStatus | null, BackgroundAiStatus][] = [
      [off, on('claude', 'haiku')], [on('claude', 'haiku'), on('codex', 'codex:a', 'Claude Code failed')], [on('codex', 'codex:a'), on('codex', 'codex:b')],
      [null, on('claude', 'haiku')], [on('codex', 'codex:a', 'Claude Code failed'), on('codex', 'codex:a')], [on('claude', 'haiku'), off],
    ];
    expect(rows.map(([before, after]) => movedOn(before, after))).toEqual([true, true, true, false, false, false]);
  });
});
