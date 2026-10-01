import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangeView } from '@ide/protocol';
import type { PlanGate } from '../../src/gate/scope-guard';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import { WatchdogWatcher, type FsEvent } from '../../src/watchdog/watcher';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const blobHash = (cwd: string, text: string): string => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: text, encoding: 'utf8' }).trim();
const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Write', toolClass: 'file-writer', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});
const write = (root: string, rel: string, text: string | Buffer): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

interface Fixture {
  root: string;
  service: ChangeService;
  ledger: ActivityLedger;
  ideWrites: IdeWrites;
  baselines: Baselines;
  checkpoints: Checkpoints;
  shadow: ShadowRepo;
  store: ReturnType<typeof openStore>;
  clock: { now: number };
  gate: { value: PlanGate };
  session: { id: string | null };
  ev(rel: string, exists?: boolean): FsEvent;
}

async function fixture(o: { root?: string; shadow?: (real: ShadowRepo) => ShadowRepo; keptChanges?: number } = {}): Promise<Fixture> {
  let root = o.root;
  if (!root) {
    root = tempDir('chg-root-');
    sh(root, 'init', '-q');
    await writeTree(root, { '.gitignore': 'dist/\n', 'a.ts': 'a', 'b.ts': 'b', '.env': 'K=1' });
    sh(root, 'add', '-A');
  }
  const store = openStore(tempDir('chg-store-'));
  store.saveSession(sessionRecord('s1', root));
  const realShadow = await ShadowRepo.open(tempDir('chg-shadow-'));
  const shadow = o.shadow ? o.shadow(realShadow) : realShadow;
  const baselines = new Baselines(store);
  await scanTree(root, DEFAULT_POLICY, shadow, baselines);
  const clock = { now: 1000 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  const ideWrites = new IdeWrites();
  const gate: { value: PlanGate } = { value: { state: 'none' } };
  const session: { id: string | null } = { id: 's1' };
  const checkpoints = new Checkpoints(store, () => 's1');
  const service = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger, store, checkpoints, sessionId: () => session.id, plans: { gate: () => gate.value },
    keptChanges: o.keptChanges,
  });
  return { root, service, ledger, ideWrites, baselines, checkpoints, shadow, store, clock, gate, session, ev: (rel, exists = true) => ({ rel, exists, at: clock.now, wall: Date.now() }) };
}

const approved = (activeStep: string | null): PlanGate => ({ state: 'approved', planId: 'p1', version: 2, scope: { files: [], globs: [] } as never, activeStep });
const byPath = (changes: ChangeView[], path: string): ChangeView => changes.find((c) => c.path === path)!;

describe('ChangeService recording', () => {
  it('keeps at most the newest keptChanges in memory while the store keeps them all', async () => {
    const f = await fixture({ keptChanges: 2 });
    for (const [i, rel] of ['a.ts', 'b.ts', 'a.ts', 'b.ts'].entries()) {
      write(f.root, rel, `v${i}`);
      await f.service.handle(f.ev(rel));
    }
    expect([f.service.changes().length, f.store.changes('s1').length]).toEqual([2, 4]);
    expect(f.service.changes().map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('never drops a change that belongs to an open event from memory', async () => {
    const f = await fixture({ keptChanges: 2 });
    write(f.root, 'a.ts', 'v0');
    await f.service.handle(f.ev('a.ts'));
    f.service.markOutOfPlan([f.service.changes()[0]!.id], 'e1');
    for (const [i, rel] of ['b.ts', 'b.ts', 'b.ts'].entries()) {
      write(f.root, rel, `w${i}`);
      await f.service.handle(f.ev(rel));
    }
    expect(f.service.changes().map((c) => [c.path, c.eventId])).toEqual([['a.ts', 'e1'], ['b.ts', null]]);
  });

  it('records one Change per real content change and none for a touch or a duplicate event', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'changed');
    await f.service.handle(f.ev('a.ts'));
    write(f.root, 'a.ts', 'changed');
    await f.service.handle(f.ev('a.ts'));
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('a.ts'))]);
    expect(f.service.changes()).toHaveLength(1);
    expect(f.service.changes()[0]).toMatchObject({ path: 'a.ts', origin: 'human', enforcement: 'enforced', outOfPlan: false, stored: true, added: 1, removed: 1, unreadable: false, resolution: null, eventId: null });
    expect(f.store.changes('s1')).toEqual(f.service.changes());
  });

  it('records the mode the file had before the change, and null for a created file', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'changed');
    chmodSync(join(f.root, 'a.ts'), 0o755);
    write(f.root, 'new.ts', 'new');
    await f.service.handle(f.ev('a.ts'));
    await f.service.handle(f.ev('new.ts'));
    expect(byPath(f.service.changes(), 'a.ts').beforeMode).toBe(0o644);
    expect(byPath(f.service.changes(), 'new.ts').beforeMode).toBeNull();
    write(f.root, 'a.ts', 'again');
    await f.service.handle(f.ev('a.ts'));
    expect(f.service.changes().filter((c) => c.path === 'a.ts').at(-1)?.beforeMode).toBe(0o755);
  });

  it('makes the next Change start from the previous afterHash and keeps the baseline current', async () => {
    const f = await fixture();
    const seeded = f.baselines.get('a.ts')!.hash;
    write(f.root, 'a.ts', 'one');
    await f.service.handle(f.ev('a.ts'));
    write(f.root, 'a.ts', 'two');
    await f.service.handle(f.ev('a.ts'));
    rmSync(join(f.root, 'a.ts'));
    await f.service.handle(f.ev('a.ts', false));
    const [first, second, third] = f.service.changes();
    expect(first!.beforeHash).toBe(seeded);
    expect(second!.beforeHash).toBe(first!.afterHash);
    expect(third).toMatchObject({ beforeHash: second!.afterHash, afterHash: null, stored: false, added: 0, removed: 1 });
    expect(f.baselines.get('a.ts')).toBeUndefined();
    write(f.root, 'new.ts', 'n');
    await f.service.handle(f.ev('new.ts'));
    expect(f.service.changes().at(-1)).toMatchObject({ path: 'new.ts', beforeHash: null });
    expect(f.baselines.get('new.ts')?.hash).toBe(f.service.changes().at(-1)!.afterHash);
    expect(f.store.baselines().map((b) => b.path)).toContain('new.ts');
  });

  it('does not track a gitignored path or a harness path: no change, no baseline, no blob, no listener call, while enforced files in the same batch are recorded', async () => {
    const f = await fixture();
    const heard: string[][] = [];
    f.service.onChange((c) => heard.push(c.map((x) => x.path).sort()));
    write(f.root, 'dist/x.js', 'v1');
    write(f.root, '.omc/state.json', '{}');
    write(f.root, 'a.ts', 'changed');
    write(f.root, '.env', 'K=2');
    await Promise.all([f.service.handle(f.ev('dist/x.js')), f.service.handle(f.ev('.omc/state.json')), f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('.env'))]);
    write(f.root, 'dist/x.js', 'v2');
    await f.service.handle(f.ev('dist/x.js'));
    rmSync(join(f.root, '.omc/state.json'));
    await f.service.handle(f.ev('.omc/state.json', false));
    rmSync(join(f.root, 'dist/x.js'));
    await f.service.handle(f.ev('dist/x.js', false));
    expect(f.service.changes().map((c) => [c.path, c.enforcement]).sort()).toEqual([['.env', 'enforced'], ['a.ts', 'enforced']]);
    expect(f.store.changes('s1').map((c) => c.path).sort()).toEqual(['.env', 'a.ts']);
    expect(heard).toEqual([['.env', 'a.ts']]);
    for (const rel of ['dist/x.js', '.omc/state.json']) {
      expect(f.baselines.get(rel)).toBeUndefined();
      expect(f.store.baselines().map((b) => b.path)).not.toContain(rel);
    }
    for (const text of ['v1', 'v2', '{}']) expect(await f.shadow.read(blobHash(f.root, text))).toBeNull();
  });

  it('labels an expected IDE write as ide, once, and does not stamp it with the step', async () => {
    const f = await fixture();
    f.gate.value = approved('s');
    f.ledger.allowed(call({ toolUseId: 'w', tool: 'Bash', toolClass: 'shell' }));
    write(f.root, 'a.ts', 'by ide');
    f.ideWrites.expect('a.ts', sh(f.root, 'hash-object', 'a.ts').trim());
    await f.service.handle(f.ev('a.ts'));
    write(f.root, 'a.ts', 'by ide again');
    await f.service.handle(f.ev('a.ts'));
    const [first, second] = f.service.changes();
    expect(first).toMatchObject({ origin: 'ide', toolUseIds: [], planId: null, stepKey: null });
    expect(second).toMatchObject({ origin: 'agent-tool', toolUseIds: ['w'] });
  });

  it('stamps agent and agent-tool changes with the active step and human changes with none', async () => {
    const f = await fixture();
    f.gate.value = approved('s1');
    f.checkpoints.begin('p1', 's1');
    f.ledger.allowed(call({ targets: ['a.ts'] }));
    write(f.root, 'a.ts', 'agent');
    write(f.root, 'b.ts', 'tool');
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('b.ts'))]);
    f.ledger.ended('t1');
    f.clock.now = 60_000;
    write(f.root, 'new.ts', 'human');
    await f.service.handle(f.ev('new.ts'));
    const changes = f.service.changes();
    expect(byPath(changes, 'a.ts')).toMatchObject({ origin: 'agent', toolUseIds: ['t1'], planId: 'p1', planVersion: 2, stepKey: 's1' });
    expect(byPath(changes, 'b.ts')).toMatchObject({ origin: 'agent-tool', toolUseIds: ['t1'], planId: 'p1', planVersion: 2, stepKey: 's1' });
    expect(byPath(changes, 'new.ts')).toMatchObject({ origin: 'human', toolUseIds: [], planId: null, planVersion: null, stepKey: null });
    expect(Object.keys(f.checkpoints.manifests('p1', 's1')!.after).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('stamps nothing while no plan is approved', async () => {
    const f = await fixture();
    f.ledger.allowed(call({ targets: ['a.ts'] }));
    write(f.root, 'a.ts', 'agent');
    await f.service.handle(f.ev('a.ts'));
    expect(f.service.changes()[0]).toMatchObject({ origin: 'agent', planId: null, planVersion: null, stepKey: null });
  });

  it('lets a tracked-paths shell cover tracked files only, and a call allowed once cover enforced files only', async () => {
    const f = await fixture();
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allTracked: true }));
    write(f.root, 'a.ts', 'tracked');
    write(f.root, 'fresh.ts', 'untracked');
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('fresh.ts'))]);
    expect(byPath(f.service.changes(), 'a.ts').origin).toBe('agent');
    expect(byPath(f.service.changes(), 'fresh.ts').origin).toBe('agent-tool');
    f.ledger.clear();
    f.ledger.allowed(call({ toolUseId: 'once', tool: 'Bash', toolClass: 'shell', allowedOnce: true }));
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/once');
    write(f.root, 'b.ts', 'o');
    await Promise.all([f.service.handle(f.ev('.git/HEAD')), f.service.handle(f.ev('b.ts'))]);
    expect(byPath(f.service.changes(), '.git/HEAD')).toMatchObject({ enforcement: 'recorded', origin: 'agent-tool' });
    expect(byPath(f.service.changes(), 'b.ts')).toMatchObject({ enforcement: 'enforced', origin: 'agent' });
  });

  it('does not turn a late exists event for the old name after a case-only rename into a change', async () => {
    const f = await fixture();
    renameSync(join(f.root, 'a.ts'), join(f.root, 'A.tmp'));
    renameSync(join(f.root, 'A.tmp'), join(f.root, 'A.ts'));
    await f.service.handle(f.ev('a.ts', false));
    await f.service.handle(f.ev('A.ts'));
    await f.service.handle(f.ev('a.ts'));
    const late = f.service.changes().filter((c) => c.path === 'a.ts' && c.afterHash !== null);
    expect(late).toEqual([]);
  });

  it('resolves a batch promise only after its batch is done', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'x');
    const done = f.service.handle(f.ev('a.ts')).then(() => f.service.changes().length);
    expect(await done).toBe(1);
    await f.service.idle();
  });
});

describe('ChangeService batching', () => {
  it('records a 300-file burst as one batch with one check-ignore and a handful of git processes, not one per file', async () => {
    const f = await fixture();
    const bin = tempDir('chg-bin-');
    const log = join(bin, 'calls.log');
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const events: FsEvent[] = [];
    for (let i = 0; i < 300; i += 1) { write(f.root, `burst/f${i}.ts`, `${i}`); events.push(f.ev(`burst/f${i}.ts`)); }
    const batches: number[] = [];
    f.service.onChange((c) => batches.push(c.length));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await Promise.all(events.map((e) => f.service.handle(e)));
      await f.service.idle();
    } finally { process.env.PATH = path; }
    expect(batches).toEqual([300]);
    const calls = (execFileSync('cat', [log], { encoding: 'utf8' })).split('\n');
    expect(calls.filter(Boolean).length).toBeLessThanOrEqual(5);
    expect(calls.filter((l) => l.includes('check-ignore'))).toHaveLength(1);
    expect(f.store.changes('s1')).toHaveLength(300);
  });

  it('takes at most 500 events per batch', async () => {
    const f = await fixture();
    const events: FsEvent[] = [];
    for (let i = 0; i < 620; i += 1) { write(f.root, `many/f${i}.ts`, `${i}`); events.push(f.ev(`many/f${i}.ts`)); }
    const batches: number[] = [];
    f.service.onChange((c) => batches.push(c.length));
    await Promise.all(events.map((e) => f.service.handle(e)));
    expect(batches).toEqual([500, 120]);
  });

  it('collapses several events for one path in a batch into one Change', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'final');
    const batches: number[] = [];
    f.service.onChange((c) => batches.push(c.length));
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('a.ts', false)), f.service.handle(f.ev('a.ts'))]);
    expect(batches).toEqual([1]);
  });
});

describe('ChangeService file kinds', () => {
  it('stores no blob for a 6 MiB file and no line counts for a binary one, and keeps recording', async () => {
    const f = await fixture();
    write(f.root, 'big.txt', Buffer.alloc(6 * 1024 * 1024, 97));
    write(f.root, 'img.bin', Buffer.from([0, 1, 2, 0, 255, 0]));
    write(f.root, 'a.ts', 'text');
    await Promise.all(['big.txt', 'img.bin', 'a.ts'].map((r) => f.service.handle(f.ev(r))));
    const changes = f.service.changes();
    expect(byPath(changes, 'big.txt')).toMatchObject({ stored: false, added: null, removed: null, unreadable: false });
    expect(await f.shadow.read(byPath(changes, 'big.txt').afterHash!)).toBeNull();
    expect(byPath(changes, 'img.bin')).toMatchObject({ stored: true, added: null, removed: null });
    expect(byPath(changes, 'a.ts')).toMatchObject({ stored: true, added: 1, removed: 1 });
  });

  it('marks an unreadable file, keeps its hash, does not baseline it, and still records the rest of the batch', async () => {
    const root = tempDir('chg-root-');
    sh(root, 'init', '-q');
    await writeTree(root, { 'a.ts': 'a', 'locked.ts': 'secret' });
    sh(root, 'add', '-A');
    const asRoot = process.getuid?.() === 0;
    const f = await fixture({
      root,
      shadow: (real) => (asRoot ? new Proxy(real, {
        get(target, key) {
          if (key !== 'putMany') { const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; }
          return async (paths: string[]) => {
            const out = await target.putMany(paths);
            for (const p of paths) if (p.endsWith('locked.ts')) out.set(p, null);
            return out;
          };
        },
      }) : real),
    });
    const before = f.baselines.get('locked.ts');
    if (!asRoot) chmodSync(join(root, 'locked.ts'), 0o000);
    write(root, 'a.ts', 'changed');
    await Promise.all([f.service.handle(f.ev('locked.ts')), f.service.handle(f.ev('a.ts'))]);
    const [locked, a] = [byPath(f.service.changes(), 'locked.ts'), byPath(f.service.changes(), 'a.ts')];
    expect(locked).toMatchObject({ unreadable: true, stored: false, beforeHash: before?.hash ?? null, afterHash: before?.hash ?? null, added: null, removed: null });
    expect(a).toMatchObject({ unreadable: false, afterHash: expect.any(String) });
    expect(f.baselines.get('locked.ts')).toEqual(before);
    await f.service.handle(f.ev('locked.ts'));
    expect(f.service.changes().filter((c) => c.path === 'locked.ts')).toHaveLength(1);
    if (!asRoot) chmodSync(join(root, 'locked.ts'), 0o644);
  });
});

describe('ChangeService git internals', () => {
  it('records .git/HEAD and .git/refs as recorded, never out of plan, flagged when the agent did it', async () => {
    const f = await fixture();
    sh(f.root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'init');
    f.ledger.allowed(call({ toolUseId: 'g', tool: 'Bash', toolClass: 'shell' }));
    sh(f.root, 'checkout', '-q', '-b', 'topic');
    await Promise.all([f.service.handle(f.ev('.git/HEAD')), f.service.handle(f.ev('.git/refs/heads/topic'))]);
    f.ledger.ended('g');
    f.clock.now += 60_000;
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/main2');
    await f.service.handle(f.ev('.git/HEAD'));
    const changes = f.service.changes();
    expect(changes).toHaveLength(3);
    for (const c of changes.slice(0, 2)) expect(c).toMatchObject({ enforcement: 'recorded', outOfPlan: false, resolution: 'flagged', origin: 'agent-tool', stored: false });
    expect(changes[2]).toMatchObject({ path: '.git/HEAD', origin: 'human', resolution: null, outOfPlan: false });
    expect(changes[2]!.beforeHash).toBe(changes[0]!.afterHash);
  });

  it('records a git-internal path against an in-memory last hash, with no baseline and no blob, and nothing for a duplicate', async () => {
    const f = await fixture();
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/v1');
    await f.service.handle(f.ev('.git/HEAD'));
    await f.service.handle(f.ev('.git/HEAD'));
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/v1');
    await f.service.handle(f.ev('.git/HEAD'));
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/v2');
    await f.service.handle(f.ev('.git/HEAD'));
    const [first, second, ...rest] = f.service.changes();
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ path: '.git/HEAD', enforcement: 'recorded', stored: false, added: null, removed: null, beforeHash: null });
    expect(first!.afterHash).toBe(blobHash(f.root, 'ref: refs/heads/v1\n'));
    expect(second).toMatchObject({ path: '.git/HEAD', beforeHash: first!.afterHash, afterHash: blobHash(f.root, 'ref: refs/heads/v2\n') });
    expect(await f.shadow.read(first!.afterHash!)).toBeNull();
    expect(f.baselines.get('.git/HEAD')).toBeUndefined();
  });

  it('reads .git/HEAD of a linked worktree from its real location', async () => {
    const main = tempDir('chg-main-');
    sh(main, 'init', '-q');
    writeFileSync(join(main, 'a.ts'), 'a');
    sh(main, 'add', '-A');
    sh(main, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'init');
    const wt = join(tempDir('chg-wt-'), 'wt');
    sh(main, 'worktree', 'add', '-q', '-b', 'side', wt);
    const f = await fixture({ root: wt });
    sh(wt, 'symbolic-ref', 'HEAD', 'refs/heads/other');
    await f.service.handle(f.ev('.git/HEAD'));
    const real = sh(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD').trim();
    expect(f.service.changes()).toHaveLength(1);
    expect(f.service.changes()[0]!.afterHash).toBe(sh(wt, 'hash-object', real).trim());
  });
});

describe('ChangeService corrections', () => {
  it('re-attributes a change whose batch was still being recorded when the call ended', async () => {
    const f = await fixture();
    f.clock.now = 500;
    write(f.root, 'y.ts', 'written by the call');
    const diff = f.shadow.diff.bind(f.shadow);
    let counting!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { counting = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    f.shadow.diff = async (...args) => { counting(); await released; return diff(...args); };
    const handled = f.service.handle(f.ev('y.ts'));
    await started;
    const updating = f.service.reattribute('call-1', 400, 1000);
    release();
    await handled;
    expect((await updating).map((c) => c.path)).toEqual(['y.ts']);
    expect(byPath(f.service.changes(), 'y.ts')).toMatchObject({ origin: 'agent-tool', toolUseIds: ['call-1'] });
  });

  it('re-attributes human changes inside a window to the call, sparing IDE claims and outside times', async () => {
    const f = await fixture();
    f.clock.now = 500;
    write(f.root, 'a.ts', 'in window');
    await f.service.handle(f.ev('a.ts'));
    write(f.root, 'b.ts', 'by ide');
    f.ideWrites.expect('b.ts', sh(f.root, 'hash-object', 'b.ts').trim());
    f.clock.now = 600;
    await f.service.handle(f.ev('b.ts'));
    f.clock.now = 5000;
    write(f.root, 'new.ts', 'late');
    await f.service.handle(f.ev('new.ts'));
    f.gate.value = approved('s1');
    const updated = await f.service.reattribute('call-1', 400, 1000);
    expect(updated.map((c) => c.path)).toEqual(['a.ts']);
    expect(byPath(f.service.changes(), 'a.ts')).toMatchObject({ origin: 'agent-tool', toolUseIds: ['call-1'], planId: 'p1', stepKey: 's1' });
    expect(byPath(f.service.changes(), 'b.ts').origin).toBe('ide');
    expect(byPath(f.service.changes(), 'new.ts').origin).toBe('human');
    expect(f.store.changes('s1').find((c) => c.path === 'a.ts')?.origin).toBe('agent-tool');
    f.clock.now = 2900;
    write(f.root, 'c.ts', 'inside the grace');
    await f.service.handle(f.ev('c.ts'));
    f.clock.now = 3100;
    write(f.root, 'd.ts', 'after the grace');
    await f.service.handle(f.ev('d.ts'));
    const graced = await f.service.reattribute('call-1', 400, 1000);
    expect(graced.map((c) => c.path)).toEqual(['c.ts']);
    expect(byPath(f.service.changes(), 'd.ts').origin).toBe('human');
  });

  it('records scan drift with the given origin, updates baselines, and does not emit', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'drifted');
    rmSync(join(f.root, 'b.ts'));
    write(f.root, 'c.ts', 'created');
    const { drift } = await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines);
    const emitted: number[] = [];
    f.service.onChange((c) => emitted.push(c.length));
    const made = await f.service.recordDrift(drift, 'unknown');
    expect(emitted).toEqual([]);
    expect(made.map((c) => [c.path, c.origin, c.beforeHash === null, c.afterHash === null]).sort()).toEqual([
      ['a.ts', 'unknown', false, false], ['b.ts', 'unknown', false, true], ['c.ts', 'unknown', true, false],
    ]);
    expect(made.every((c) => c.enforcement === 'enforced' && c.planId === null && c.toolUseIds.length === 0)).toBe(true);
    expect(byPath(made, 'a.ts')).toMatchObject({ added: 1, removed: 1, stored: true });
    expect((await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift).toEqual([]);
    expect(f.store.changes('s1')).toHaveLength(3);
  });

  it('persists a resolution and a relabel to human', async () => {
    const f = await fixture();
    f.gate.value = approved('s1');
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell' }));
    write(f.root, 'a.ts', 'x');
    write(f.root, 'b.ts', 'y');
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('b.ts'))]);
    const [a, b] = f.service.changes();
    f.service.setResolution([a!.id], 'kept', 'ev-1');
    f.service.relabelHuman([b!.id]);
    const stored = f.store.changes('s1');
    expect(stored[0]).toMatchObject({ resolution: 'kept', eventId: 'ev-1', origin: 'agent-tool' });
    expect(stored[1]).toMatchObject({ origin: 'human', resolution: 'relabeled-human', toolUseIds: [], planId: null, stepKey: null, outOfPlan: false });
    expect(f.service.changes()).toEqual(stored);
  });
});

describe('ChangeService with the real watcher', () => {
  it('records a write the watcher reports', async () => {
    const f = await fixture();
    const watcher = new WatchdogWatcher({ root: f.root });
    watcher.onEvent((e) => { void f.service.handle(e); });
    await watcher.start();
    try {
      write(f.root, 'watched.ts', 'hello');
      const change = await waitFor(() => f.service.changes().find((c) => c.path === 'watched.ts'), 'watched change', 5000);
      expect(change).toMatchObject({ origin: 'human', beforeHash: null, enforcement: 'enforced' });
    } finally { await watcher.stop(); }
  });
});

describe('ChangeService failure handling', () => {
  const failOnce = (f: Fixture) => vi.spyOn(f.store, 'saveChanges').mockImplementationOnce(() => { throw new Error('disk full'); });

  it('loses nothing when the store fails mid-batch: state is untouched and the next event records it', async () => {
    const f = await fixture();
    const before = f.baselines.get('a.ts')!.hash;
    const heard: number[] = [];
    f.service.onChange((c) => heard.push(c.length));
    failOnce(f);
    f.gate.value = approved('s1');
    f.checkpoints.begin('p1', 's1');
    f.ledger.allowed(call({ targets: ['a.ts'] }));
    write(f.root, 'a.ts', 'changed');
    sh(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/topic');
    await expect(Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('.git/HEAD'))])).rejects.toThrow('disk full');
    expect(f.service.changes()).toEqual([]);
    expect(heard).toEqual([]);
    expect(f.baselines.get('a.ts')!.hash).toBe(before);
    expect(f.checkpoints.manifests('p1', 's1')!.after).toEqual({});
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('.git/HEAD'))]);
    expect(f.service.changes().map((c) => [c.path, c.beforeHash === null ? null : c.beforeHash === before])).toEqual([['a.ts', true], ['.git/HEAD', null]]);
    expect(heard).toEqual([2]);
    expect(f.store.changes('s1')).toHaveLength(2);
  });

  it('fails a drift record loudly and keeps the drift until it is saved', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'drifted');
    const { drift } = await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines);
    failOnce(f);
    await expect(f.service.recordDrift(drift, 'unknown')).rejects.toThrow('disk full');
    expect(f.service.changes()).toEqual([]);
    expect((await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift).toHaveLength(1);
    await f.service.recordDrift(drift, 'unknown');
    expect((await scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines)).drift).toEqual([]);
  });

  it('fails a re-attribution loudly and leaves the change human', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'x');
    await f.service.handle(f.ev('a.ts'));
    failOnce(f);
    await expect(f.service.reattribute('c1', 0, 5000)).rejects.toThrow('disk full');
    expect(f.service.changes()[0]!.origin).toBe('human');
    expect(f.store.changes('s1')[0]!.origin).toBe('human');
    expect(await f.service.reattribute('c1', 0, 5000)).toHaveLength(1);
  });

  it('rejects a batch and advances nothing while there is no session', async () => {
    const f = await fixture();
    const before = { a: f.baselines.get('a.ts')!.hash, b: f.baselines.get('b.ts')!.hash };
    f.session.id = null;
    write(f.root, 'a.ts', 'x');
    write(f.root, 'b.ts', 'y');
    await expect(Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('b.ts'))])).rejects.toThrow('no session');
    expect([f.baselines.get('a.ts')!.hash, f.baselines.get('b.ts')!.hash]).toEqual([before.a, before.b]);
    expect(f.service.changes()).toEqual([]);
    f.session.id = 's1';
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('b.ts'))]);
    expect(f.service.changes().map((c) => [c.path, c.beforeHash])).toEqual([['a.ts', before.a], ['b.ts', before.b]]);
  });

  it('stamps each event with the step that was active when it arrived', async () => {
    const f = await fixture();
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell' }));
    write(f.root, 'a.ts', 'one');
    write(f.root, 'b.ts', 'two');
    f.gate.value = approved('s1');
    const first = f.service.handle(f.ev('a.ts'));
    f.gate.value = approved('s2');
    const second = f.service.handle(f.ev('b.ts'));
    f.gate.value = approved(null);
    await Promise.all([first, second]);
    expect(f.service.changes().map((c) => [c.path, c.stepKey])).toEqual([['a.ts', 's1'], ['b.ts', 's2']]);
  });

  it('counts lines up to 100 enforced changes per batch and leaves them null above', async () => {
    const small = await fixture();
    for (let i = 0; i < 100; i += 1) write(small.root, `n/f${i}.ts`, 'x');
    await Promise.all(Array.from({ length: 100 }, (_, i) => small.service.handle(small.ev(`n/f${i}.ts`))));
    expect(small.service.changes().every((c) => c.added === 1 && c.removed === 0)).toBe(true);
    const big = await fixture();
    for (let i = 0; i < 101; i += 1) write(big.root, `n/f${i}.ts`, 'x');
    await Promise.all(Array.from({ length: 101 }, (_, i) => big.service.handle(big.ev(`n/f${i}.ts`))));
    expect(big.service.changes()).toHaveLength(101);
    expect(big.service.changes().every((c) => c.added === null && c.removed === null && c.stored)).toBe(true);
  });

  it('treats no path as tracked when git ls-files fails', async () => {
    const f = await fixture();
    const bin = tempDir('chg-bin-');
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in *ls-files*) exit 2;; esac
exec '${real}' "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allTracked: true }));
    write(f.root, 'a.ts', 'tracked but unknown');
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try { await f.service.handle(f.ev('a.ts')); } finally { process.env.PATH = path; }
    expect(f.service.changes()[0]!.origin).toBe('agent-tool');
  });

  it('writes changes and baselines in one transaction: a failing baseline write leaves no change and the retry records exactly one', async () => {
    const f = await fixture();
    const before = f.baselines.get('a.ts')!.hash;
    const real = f.store.saveChanges.bind(f.store);
    vi.spyOn(f.store, 'saveChanges').mockImplementationOnce((id, changes, baselines) =>
      real(id, changes, baselines && { ...baselines, rows: baselines.rows.map((r) => ({ ...r, hash: null as never })) }));
    write(f.root, 'a.ts', 'changed');
    await expect(f.service.handle(f.ev('a.ts'))).rejects.toThrow();
    expect(f.store.changes('s1')).toEqual([]);
    expect(f.store.baselines().find((b) => b.path === 'a.ts')!.hash).toBe(before);
    expect(f.baselines.get('a.ts')!.hash).toBe(before);
    await f.service.handle(f.ev('a.ts'));
    expect(f.store.changes('s1')).toHaveLength(1);
    expect(f.service.changes()).toHaveLength(1);
    expect(f.store.baselines().find((b) => b.path === 'a.ts')!.hash).toBe(f.service.changes()[0]!.afterHash);
  });

  it('still labels an IDE write as ide on the retry of a batch that failed', async () => {
    const f = await fixture();
    write(f.root, 'a.ts', 'by ide');
    f.ideWrites.expect('a.ts', sh(f.root, 'hash-object', 'a.ts').trim());
    failOnce(f);
    await expect(f.service.handle(f.ev('a.ts'))).rejects.toThrow('disk full');
    await f.service.handle(f.ev('a.ts'));
    expect(f.service.changes().map((c) => c.origin)).toEqual(['ide']);
  });
  it('persists the out-of-plan decision and the event it belongs to', async () => {
    const f = await fixture();
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell' }));
    write(f.root, 'a.ts', 'x');
    write(f.root, 'b.ts', 'y');
    await Promise.all([f.service.handle(f.ev('a.ts')), f.service.handle(f.ev('b.ts'))]);
    const [a, b] = f.service.changes();
    const marked = f.service.markOutOfPlan([a!.id], 'ev-1');
    expect(marked).toHaveLength(1);
    expect(f.store.changes('s1')[0]).toMatchObject({ outOfPlan: true, eventId: 'ev-1', resolution: null });
    expect(f.store.changes('s1')[1]).toMatchObject({ id: b!.id, outOfPlan: false, eventId: null });
    expect(f.service.changes()).toEqual(f.store.changes('s1'));
  });
});
