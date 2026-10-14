import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ChangeView } from '@ide/protocol';
import { Baselines } from '../../src/history/baselines';
import { Checkpoints } from '../../src/history/checkpoints';
import { DiffError, DiffService } from '../../src/history/diff';
import { ShadowRepo } from '../../src/history/shadow';
import { openStore } from '../../src/store/store';
import { sessionRecord, tempDir } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const change = (path: string, beforeHash: string | null, afterHash: string | null, o: Partial<ChangeView> = {}): ChangeView => ({
  id: `${path}-${afterHash}`, path, beforeHash, afterHash, at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false, toolUseIds: ['t'],
  planId: 'p', planVersion: 1, stepKey: 'edit', eventId: null, resolution: null, added: null, removed: null, stored: true, unreadable: false, beforeMode: null, ...o,
});

async function fixture(cacheSize?: number) {
  const shadow = await ShadowRepo.open(tempDir('diff-shadow-'));
  const work = tempDir('diff-work-');
  const store = openStore(tempDir('diff-store-'));
  store.saveSession(sessionRecord('s1', work));
  const baselines = new Baselines(store);
  const checkpoints = new Checkpoints(store, () => 's1');
  const changes: ChangeView[] = [];
  const blob = async (name: string, content: string): Promise<string> => {
    const abs = join(work, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    return (await shadow.put(abs))!.hash;
  };
  const diffs = new DiffService({ shadow, changes: () => changes, baselines, checkpoints, cacheSize });
  return { shadow, baselines, checkpoints, changes, blob, diffs, workDir: work };
}

describe('DiffService.diff', () => {
  it('refuses a hash that no change or baseline of that path carries', async () => {
    const f = await fixture();
    const h1 = await f.blob('a.ts', 'one\n');
    const h2 = await f.blob('a.ts', 'two\n');
    const other = await f.blob('secret.ts', 'TOKEN\n');
    f.changes.push(change('a.ts', h1, h2), change('secret.ts', null, other));
    await expect(f.diffs.diff('a.ts', other, h2)).rejects.toBeInstanceOf(DiffError);
    await expect(f.diffs.diff('a.ts', h1, other)).rejects.toBeInstanceOf(DiffError);
    await expect(f.diffs.diff('a.ts', h1, h2)).resolves.toMatchObject({ added: 1, removed: 1 });
  });

  it('allows a hash that a baseline of the path carries and refuses it for another path', async () => {
    const f = await fixture();
    const base = await f.blob('a.ts', 'base\n');
    const now = await f.blob('a.ts', 'now\n');
    f.baselines.set({ path: 'a.ts', hash: base, stored: true, size: 5, mode: 0o644 });
    f.changes.push(change('a.ts', base, now));
    await expect(f.diffs.diff('a.ts', base, null)).resolves.toMatchObject({ removed: 1 });
    await expect(f.diffs.diff('b.ts', base, null)).rejects.toBeInstanceOf(DiffError);
  });

  it('allows a blob shared by two paths for each path that carries it', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'same\n');
    f.changes.push(change('a.ts', null, h), change('b.ts', null, h));
    await expect(f.diffs.diff('a.ts', null, h)).resolves.toMatchObject({ added: 1 });
    await expect(f.diffs.diff('b.ts', null, h)).resolves.toMatchObject({ added: 1 });
    await expect(f.diffs.diff('c.ts', null, h)).rejects.toBeInstanceOf(DiffError);
  });

  it('rejects a path that is absolute, escaping, empty or not normalized', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'x\n');
    f.changes.push(change('a.ts', null, h));
    for (const bad of ['/etc/passwd', '../a.ts', 'src/../a.ts', '', './a.ts', 'src//a.ts', 'a\\b.ts', 'a\0.ts', 'dir/']) {
      await expect(f.diffs.diff(bad, null, h)).rejects.toBeInstanceOf(DiffError);
    }
  });

  it('diffs created and deleted files against the empty side', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'l1\nl2\n');
    f.changes.push(change('a.ts', null, h), change('a.ts', h, null));
    expect(await f.diffs.diff('a.ts', null, h)).toMatchObject({ added: 2, removed: 0 });
    expect(await f.diffs.diff('a.ts', h, null)).toMatchObject({ added: 0, removed: 2 });
  });

  it('returns an empty diff for identical sides without calling git', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'x\n');
    f.changes.push(change('a.ts', h, h));
    expect(await f.diffs.diff('a.ts', h, h)).toEqual({ binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] });
    expect(await f.diffs.diff('a.ts', null, null)).toMatchObject({ hunks: [] });
    expect(f.diffs.stats().gitCalls).toBe(0);
  });

  it('does not call git twice for the same pair, and keys the cache on both hashes', async () => {
    const f = await fixture();
    const h1 = await f.blob('a.ts', 'one\n');
    const h2 = await f.blob('a.ts', 'two\n');
    const h3 = await f.blob('a.ts', 'three\n');
    f.changes.push(change('a.ts', h1, h2), change('a.ts', h2, h3));
    const first = await f.diffs.diff('a.ts', h1, h2);
    expect(await f.diffs.diff('a.ts', h1, h2)).toEqual(first);
    expect(f.diffs.stats().gitCalls).toBe(1);
    await f.diffs.diff('a.ts', h2, h3);
    expect(f.diffs.stats().gitCalls).toBe(2);
  });

  it('shares one git call between concurrent requests for the same pair', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'x\n');
    f.changes.push(change('a.ts', null, h));
    await Promise.all([f.diffs.diff('a.ts', null, h), f.diffs.diff('a.ts', null, h)]);
    expect(f.diffs.stats().gitCalls).toBe(1);
  });

  it('evicts the least recently used entry beyond its size', async () => {
    const f = await fixture(3);
    const hashes: string[] = [];
    for (let i = 0; i < 5; i += 1) hashes.push(await f.blob('a.ts', `v${i}\n`));
    f.changes.push(...hashes.map((h) => change('a.ts', null, h)));
    for (const h of hashes) await f.diffs.diff('a.ts', null, h);
    expect(f.diffs.stats().gitCalls).toBe(5);
    await f.diffs.diff('a.ts', null, hashes[4]!);
    expect(f.diffs.stats().gitCalls).toBe(5);
    await f.diffs.diff('a.ts', null, hashes[1]!);
    expect(f.diffs.stats().gitCalls).toBe(6);
    await f.diffs.diff('a.ts', null, hashes[3]!);
    expect(f.diffs.stats().gitCalls).toBe(6);
    await f.diffs.diff('a.ts', null, hashes[2]!);
    expect(f.diffs.stats().gitCalls).toBe(7);
  });

  it('passes the 2000-line cut through', async () => {
    const f = await fixture();
    const h = await f.blob('big.ts', Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n') + '\n');
    f.changes.push(change('big.ts', null, h));
    const diff = await f.diffs.diff('big.ts', null, h);
    expect(diff.truncated).toBe(true);
    expect(diff.hunks.flatMap((x) => x.lines).length).toBeLessThanOrEqual(2000);
  });

  it('gives a missing diff, not an error, for an unstored hash a change carries', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'x\n');
    const ghost = 'f'.repeat(40);
    f.changes.push(change('a.ts', h, ghost, { stored: false }));
    expect(await f.diffs.diff('a.ts', h, ghost)).toMatchObject({ missing: true, added: 0, removed: 0, hunks: [] });
  });
});

describe('DiffService.netDiff', () => {
  it('nets the first change before to the last change after for the path', async () => {
    const f = await fixture();
    const h0 = await f.blob('a.ts', 'zero\n');
    const h1 = await f.blob('a.ts', 'one\n');
    const h2 = await f.blob('a.ts', 'two\nextra\n');
    const o = await f.blob('o.ts', 'other\n');
    f.changes.push(change('a.ts', h0, h1), change('o.ts', null, o), change('a.ts', h1, h2));
    const net = await f.diffs.netDiff('a.ts');
    expect(net).toEqual(await f.shadow.diff(h0, h2));
    expect(net).not.toEqual(await f.shadow.diff(h1, h2));
  });

  it('is null when the path has no change', async () => {
    const f = await fixture();
    expect(await f.diffs.netDiff('a.ts')).toBeNull();
  });

  it('nets a create then delete to an empty diff', async () => {
    const f = await fixture();
    const h = await f.blob('a.ts', 'x\n');
    f.changes.push(change('a.ts', null, h), change('a.ts', h, null));
    expect(await f.diffs.netDiff('a.ts')).toMatchObject({ added: 0, removed: 0, hunks: [] });
  });
});

describe('DiffService.stepDiff', () => {
  it('diffs a step from its manifests and is null for an unknown step or path', async () => {
    const f = await fixture();
    const h0 = await f.blob('a.ts', 'zero\n');
    const h1 = await f.blob('a.ts', 'one\n');
    const c = change('a.ts', h0, h1);
    f.changes.push(c);
    f.checkpoints.begin('p', 'edit');
    f.checkpoints.record(c);
    f.checkpoints.seal('p', 'edit');
    expect(await f.diffs.stepDiff('p', 'edit', 'a.ts')).toMatchObject({ added: 1, removed: 1 });
    expect(await f.diffs.stepDiff('p', 'nope', 'a.ts')).toBeNull();
    expect(await f.diffs.stepDiff('p', 'edit', 'b.ts')).toBeNull();
  });

  it('goes through the allow-list', async () => {
    const f = await fixture();
    const h0 = await f.blob('a.ts', 'zero\n');
    const h1 = await f.blob('a.ts', 'one\n');
    f.checkpoints.begin('p', 'edit');
    f.checkpoints.record(change('a.ts', h0, h1));
    await expect(f.diffs.stepDiff('p', 'edit', 'a.ts')).rejects.toBeInstanceOf(DiffError);
  });
});

describe('DiffService.content', () => {
  it('returns the text of a recorded version and refuses a hash the path never carried', async () => {
    const f = await fixture();
    const h1 = await f.blob('a.ts', 'one\n');
    const h2 = await f.blob('a.ts', 'two\n');
    const other = await f.blob('secret.ts', 'TOKEN\n');
    f.changes.push(change('a.ts', h1, h2), change('secret.ts', null, other));
    await expect(f.diffs.content('a.ts', h1)).resolves.toBe('one\n');
    await expect(f.diffs.content('a.ts', other)).rejects.toBeInstanceOf(DiffError);
  });

  it('answers null for a binary version', async () => {
    const f = await fixture();
    const abs = join(f.workDir, 'logo.bin');
    writeFileSync(abs, Buffer.from([0x89, 0x00, 0x01]));
    const hash = (await f.shadow.put(abs))!.hash;
    f.changes.push(change('logo.bin', null, hash));
    await expect(f.diffs.content('logo.bin', hash)).resolves.toBeNull();
  });
});
