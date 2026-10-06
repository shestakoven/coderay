import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { Baselines, EXCLUDED_DIRS, ScanAborted, ScanError, hashCandidates, newScanCache, scanTree } from '../../src/history/baselines';
import { ShadowRepo } from '../../src/history/shadow';
import { openStore } from '../../src/store/store';
import { tempDir, writeTree } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };

async function setup(files: Record<string, string>, repo = true) {
  const root = tempDir('scan-root-');
  if (repo) { sh(root, 'init', '-q'); sh(root, 'config', 'user.email', 'a@b'); sh(root, 'config', 'user.name', 'a'); }
  await writeTree(root, files);
  if (repo) { sh(root, 'add', '-A'); }
  const store = openStore(tempDir('scan-store-'));
  const shadow = await ShadowRepo.open(tempDir('scan-shadow-'));
  return { root, store, shadow, baselines: new Baselines(store) };
}

const FILES = {
  '.gitignore': 'dist/\n.env\nbackend/.env\nnode_modules/\nsecret.txt\n.claude/\n',
  'a.ts': 'a',
  'dist/x.js': 'x',
  '.env': 'K=1',
  'backend/.env': 'K=3',
  'secret.txt': 's',
  '.claude/settings.json': '{}',
  'node_modules/p/i.js': 'i',
};

async function seededRepo() {
  const ctx = await setup(FILES);
  sh(ctx.root, 'reset', '-q');
  sh(ctx.root, 'add', '.gitignore', 'a.ts');
  await writeTree(ctx.root, { 'b.ts': 'b' });
  return ctx;
}

describe('Baselines', () => {
  it('persists every set and remove immediately and reloads from the store', () => {
    const store = openStore(tempDir('bl-store-'));
    const baselines = new Baselines(store);
    const row = (path: string) => ({ path, hash: `h-${path}`, stored: true, size: 1, mode: 0o644 });
    baselines.set(row('a'));
    expect(store.baselines().map((b) => b.path)).toEqual(['a']);
    baselines.setMany([row('b'), row('c')]);
    baselines.remove('a');
    expect(store.baselines().map((b) => b.path)).toEqual(['b', 'c']);
    const reloaded = new Baselines(store);
    expect(reloaded.paths().sort()).toEqual(['b', 'c']);
    expect(reloaded.get('b')?.hash).toBe('h-b');
  });
});

const NO_RACY = { racyMs: 0 };

describe('scanTree with a cache', () => {
  const hashed = (put: { mock: { calls: unknown[][] } }): string[] => put.mock.calls.flatMap((call) => call[0] as string[]).map((path) => path.split('/').slice(-1)[0]!).sort();

  it('hashes nothing on a second scan of an unchanged tree', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    const put = vi.spyOn(shadow, 'putMany');
    const again = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    expect([again.drift, hashed(put)]).toEqual([[], []]);
  });

  it('finds a changed, a new and a deleted file and looks only at those', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    const put = vi.spyOn(shadow, 'putMany');
    writeFileSync(join(root, 'a.ts'), 'changed content');
    writeFileSync(join(root, 'fresh.ts'), 'new');
    rmSync(join(root, 'backend/.env'));
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    expect([result.drift.map((d) => d.path).sort(), hashed(put)]).toEqual([['a.ts', 'backend/.env', 'fresh.ts'], ['.env', 'a.ts', 'fresh.ts']]);
  });

  it('finds a content change that keeps the size, the modification time and the inode', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    const ref = join(tempDir('scan-ref-'), 'ref');
    execFileSync('touch', ['-r', join(root, 'a.ts'), ref]);
    writeFileSync(join(root, 'a.ts'), 'b');
    execFileSync('touch', ['-r', ref, join(root, 'a.ts')]);
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    expect(result.drift.map((d) => d.path)).toEqual(['a.ts']);
  });

  it('finds a content change after a file was unreadable and readable again', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    const ref = join(tempDir('scan-ref-'), 'ref');
    execFileSync('touch', ['-r', join(root, 'a.ts'), ref]);
    chmodSync(join(root, 'a.ts'), 0o000);
    const closed = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    chmodSync(join(root, 'a.ts'), 0o644);
    writeFileSync(join(root, 'a.ts'), 'b');
    execFileSync('touch', ['-r', ref, join(root, 'a.ts')]);
    const open = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    expect([closed.unreadable, open.drift.map((d) => d.path)]).toEqual([['a.ts'], ['a.ts']]);
  });

  it('hashes files touched within the racy window again on the next scan, and trusts their signatures once they are older', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache);
    const put = vi.spyOn(shadow, 'putMany');
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache);
    const racy = hashed(put);
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    put.mockClear();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    expect([racy.includes('a.ts'), hashed(put)]).toEqual([true, []]);
  });

  it('lists the ignored guarded files again only when asked to refresh', async () => {
    const { root, shadow, baselines } = await setup(FILES);
    const cache = newScanCache();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other/.env'), 'K=9');
    const cached = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, NO_RACY);
    const refreshed = await scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, { refresh: true, racyMs: 0 });
    expect([cached.drift.map((d) => d.path), refreshed.drift.map((d) => d.path)]).toEqual([[], ['other/.env']]);
  });
});

describe('scanTree after the core restarted', () => {
  const hashed = (put: { mock: { calls: unknown[][] } }): string[] => put.mock.calls.flatMap((call) => call[0] as string[]).map((path) => path.split('/').slice(-1)[0]!).sort();

  async function seededAndStopped(files = FILES, options: { racyMs?: number } = NO_RACY) {
    const ctx = await setup(files);
    await scanTree(ctx.root, DEFAULT_POLICY, ctx.shadow, ctx.baselines, newScanCache(), options);
    const restart = (opts: { racyMs?: number } = NO_RACY) => {
      const reopened = new Baselines(ctx.store);
      return scanTree(ctx.root, DEFAULT_POLICY, ctx.shadow, reopened, newScanCache(reopened), opts);
    };
    return { ...ctx, restart, signed: () => ctx.store.baselines().filter((b) => b.sig !== undefined).map((b) => b.path).sort() };
  }

  it('hashes only the files that changed meanwhile and reports them', async () => {
    const c = await seededAndStopped();
    writeFileSync(join(c.root, 'a.ts'), 'changed content');
    writeFileSync(join(c.root, 'fresh.ts'), 'new');
    const put = vi.spyOn(c.shadow, 'putMany');
    const result = await c.restart();
    expect([result.drift.map((d) => d.path).sort(), hashed(put)]).toEqual([['a.ts', 'fresh.ts'], ['a.ts', 'fresh.ts']]);
  });

  it('still reports a change nobody took over after the next restart too', async () => {
    const c = await seededAndStopped();
    writeFileSync(join(c.root, 'a.ts'), 'changed content');
    await c.restart();
    const put = vi.spyOn(c.shadow, 'putMany');
    const again = await c.restart();
    expect([again.drift.map((d) => d.path), hashed(put)]).toEqual([['a.ts'], ['a.ts']]);
  });

  it('hashes a file touched without a content change once, finds no drift, and trusts its new signature afterwards', async () => {
    const c = await seededAndStopped();
    utimesSync(join(c.root, 'a.ts'), 1_000, 1_000);
    const put = vi.spyOn(c.shadow, 'putMany');
    const touched = await c.restart();
    const touchedHash = hashed(put);
    put.mockClear();
    await c.restart();
    expect([touched.drift, touchedHash, hashed(put)]).toEqual([[], ['a.ts'], []]);
  });

  it('hashes a file again whose baseline was rewritten by anything other than a scan', async () => {
    const c = await seededAndStopped();
    const { path, hash, stored, size, mode } = c.baselines.get('a.ts')!;
    c.baselines.set({ path, hash, stored, size, mode });
    const put = vi.spyOn(c.shadow, 'putMany');
    const result = await c.restart();
    expect([result.drift, hashed(put)]).toEqual([[], ['a.ts']]);
  });

  it('stops between listing and hashing when asked to, leaving the baselines and the shadow repository as they were', async () => {
    const c = await seededAndStopped();
    writeFileSync(join(c.root, 'a.ts'), 'changed content');
    const before = c.store.baselines();
    const put = vi.spyOn(c.shadow, 'putMany');
    let asked = 0;
    const reopened = new Baselines(c.store);
    const aborted = scanTree(c.root, DEFAULT_POLICY, c.shadow, reopened, newScanCache(reopened), { ...NO_RACY, stopped: () => ++asked > 1 });
    await expect(aborted).rejects.toBeInstanceOf(ScanAborted);
    expect([c.store.baselines(), put.mock.calls.length]).toEqual([before, 0]);
  });

  it('never keeps the signature of a file written within the racy window', async () => {
    const racy = { racyMs: 60_000 };
    const c = await seededAndStopped(FILES, racy);
    const seeded = c.signed();
    await scanTree(c.root, DEFAULT_POLICY, c.shadow, c.baselines, newScanCache(), racy);
    expect([seeded, c.signed()]).toEqual([[], []]);
  });
});

describe('scanTree', () => {
  it('excludes exactly the four dependency directories', () => {
    expect(EXCLUDED_DIRS).toEqual(['node_modules', '.venv', 'venv', '__pycache__']);
  });

  it('seeds baselines on the first scan and raises no drift', async () => {
    const { root, shadow, baselines, store } = await seededRepo();
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(result).toEqual({ seeded: true, drift: [], unreadable: [] });
    const paths = store.baselines().map((b) => b.path);
    expect(paths).toEqual(expect.arrayContaining(['a.ts', 'b.ts', '.env', 'backend/.env', '.claude/settings.json', '.gitignore']));
    expect(paths).not.toContain('dist/x.js');
    expect(paths).not.toContain('secret.txt');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.filter((p) => p.startsWith('.git/') && !/^\.git\/(hooks\/|info\/|config$)/.test(p))).toEqual([]);
  });

  it('baselines the guarded parts of .git', async () => {
    const { root, shadow, baselines, store } = await seededRepo();
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\n');
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const paths = store.baselines().map((b) => b.path);
    expect(paths).toContain('.git/config');
    expect(paths).toContain('.git/hooks/pre-commit');
    expect(paths).not.toContain('.git/HEAD');
  });

  it('does not baseline a gitignored file outside the guarded list, and never a directory', async () => {
    const { root, shadow, baselines, store } = await seededRepo();
    mkdirSync(join(root, 'emptydir'));
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const paths = store.baselines().map((b) => b.path);
    expect(paths).not.toContain('secret.txt');
    expect(paths).not.toContain('emptydir');
  });

  it('reports added, changed and removed files on a later scan and leaves baselines alone', async () => {
    const { root, shadow, baselines, store } = await seededRepo();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const before = JSON.stringify(store.baselines());
    await writeTree(root, { 'a.ts': 'changed', 'c.ts': 'new' });
    rmSync(join(root, 'b.ts'));
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(result.seeded).toBe(false);
    const byPath = new Map(result.drift.map((d) => [d.path, d]));
    expect([...byPath.keys()].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(byPath.get('c.ts')).toMatchObject({ before: null, after: { stored: true } });
    expect(byPath.get('a.ts')?.before?.hash).not.toBe(byPath.get('a.ts')?.after?.hash);
    expect(byPath.get('b.ts')).toMatchObject({ after: null, before: { path: 'b.ts' } });
    expect(JSON.stringify(store.baselines())).toBe(before);
    expect(JSON.stringify(new Baselines(store).paths().sort())).toBe(JSON.stringify(store.baselines().map((b) => b.path)));
  });

  it('reports a tracked file deleted from disk as removed', async () => {
    const { root, shadow, baselines } = await seededRepo();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    rmSync(join(root, 'a.ts'));
    const { drift } = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(drift.map((d) => [d.path, d.after])).toEqual([['a.ts', null]]);
  });

  it('does not report a mode-only change as drift', async () => {
    const { root, shadow, baselines } = await seededRepo();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    chmodSync(join(root, 'a.ts'), 0o755);
    const { drift } = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(drift).toEqual([]);
  });

  it('handles file names with newlines and quotes', async () => {
    const { root, shadow, baselines, store } = await setup({ 'we"ird\nname.ts': 'w', 'plain.ts': 'p', 'sp ace/é.ts': 'u' });
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const paths = store.baselines().map((b) => b.path);
    expect(paths).toEqual(expect.arrayContaining(['we"ird\nname.ts', 'plain.ts', 'sp ace/é.ts']));
    expect(paths.every((p) => !p.startsWith('"'))).toBe(true);
  });

  it('skips excluded directories even when git does not ignore them', async () => {
    const { root, shadow, baselines, store } = await setup({ 'a.ts': 'a', 'node_modules/p/i.js': 'i', 'pkg/.venv/l.py': 'v', 'venv/x': 'x', 'sub/__pycache__/m.pyc': 'c', '.env': 'K=1', 'node_modules/.env': 'K=2' });
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const paths = store.baselines().map((b) => b.path).filter((p) => !p.startsWith('.git/'));
    expect(paths).toEqual(['.env', 'a.ts']);
  });

  it('walks a project that is not a git repository, enforcing everything', async () => {
    const { root, shadow, baselines, store } = await setup({ 'a.ts': 'a', 'dist/x.js': 'x', 'node_modules/p/i.js': 'i', '.venv/lib.py': 'v', 'sub/__pycache__/m.pyc': 'c', 'sub/venv/z': 'z' }, false);
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(result.seeded).toBe(true);
    expect(store.baselines().map((b) => b.path)).toEqual(['a.ts', 'dist/x.js']);
  });

  it('baselines a 6 MiB file without storing it', async () => {
    const { root, shadow, baselines, store } = await setup({});
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1));
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const row = store.baselines().find((b) => b.path === 'big.bin');
    expect(row).toMatchObject({ path: 'big.bin', stored: false, size: 6 * 1024 * 1024 });
    expect(row!.hash).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('lists an unreadable file in unreadable and skips it', async () => {
    const { root, shadow, baselines, store } = await setup({ 'ok.ts': 'ok', 'locked.ts': 'no' });
    chmodSync(join(root, 'locked.ts'), 0o000);
    try {
      const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
      expect(result.unreadable).toEqual(process.getuid?.() === 0 ? [] : ['locked.ts']);
      const paths = store.baselines().map((b) => b.path);
      expect(paths).toContain('ok.ts');
      if (process.getuid?.() !== 0) expect(paths).not.toContain('locked.ts');
    } finally { chmodSync(join(root, 'locked.ts'), 0o644); }
  });
});

describe('scanTree seeding marker', () => {
  it('seeds an empty project once and treats a later file as drift', async () => {
    const { root, shadow, baselines } = await setup({});
    expect((await scanTree(root, DEFAULT_POLICY, shadow, baselines)).seeded).toBe(true);
    await writeTree(root, { 'new.ts': 'n' });
    const second = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(second.seeded).toBe(false);
    expect(second.drift.map((d) => d.path)).toEqual(['new.ts']);
  });

  it('does not re-seed after the last baseline is removed', async () => {
    const { root, shadow, baselines } = await setup({ 'only.ts': 'o' });
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    for (const path of baselines.paths()) baselines.remove(path);
    const second = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(second.seeded).toBe(false);
    expect(second.drift.map((d) => d.path)).toContain('only.ts');
  });

  it('drops a baseline that no longer belongs to the candidate rules, only while seeding', async () => {
    const { root, shadow, baselines, store } = await setup({ 'a.ts': 'a', 'stale.ts': 's' });
    baselines.set({ path: 'stale.ts', hash: 'x'.repeat(40), stored: true, size: 1, mode: 0o644 });
    writeFileSync(join(root, '.gitignore'), 'stale.ts\n');
    sh(root, 'rm', '-q', '--cached', 'stale.ts');
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(store.baselines().map((b) => b.path)).not.toContain('stale.ts');
  });
});

describe('scanTree removed drift', () => {
  it('does not call a file removed when it still exists but left the candidate rules', async () => {
    const { root, shadow, baselines } = await seededRepo();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    writeFileSync(join(root, '.gitignore'), 'dist/\nb.ts\n');
    const { drift } = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(drift.map((d) => d.path)).not.toContain('b.ts');
    expect(baselines.get('b.ts')).toBeDefined();
  });
});

describe('scanTree git failures', () => {
  it('throws instead of walking when the repository is broken', async () => {
    const { root, shadow, baselines, store } = await seededRepo();
    writeFileSync(join(root, '.git/HEAD'), 'garbage\n');
    await expect(scanTree(root, DEFAULT_POLICY, shadow, baselines)).rejects.toThrow(ScanError);
    await expect(scanTree(root, DEFAULT_POLICY, shadow, baselines)).rejects.toThrow(/git ls-files failed/);
    expect(store.baselines()).toEqual([]);
  });
});

describe('scanTree special layouts', () => {
  it('baselines the guarded git files of a linked worktree under their logical names', async () => {
    const main = tempDir('scan-main-');
    sh(main, 'init', '-q'); sh(main, 'config', 'user.email', 'a@b'); sh(main, 'config', 'user.name', 'a');
    writeFileSync(join(main, 'a.ts'), 'a');
    sh(main, 'add', '-A'); sh(main, 'commit', '-q', '-m', 'init');
    writeFileSync(join(main, '.git/hooks/pre-commit'), '#!/bin/sh\n');
    const root = join(tempDir('scan-wt-'), 'wt');
    sh(main, 'worktree', 'add', '-q', root, '-b', 'feature');
    const store = openStore(tempDir('scan-store-'));
    const shadow = await ShadowRepo.open(tempDir('scan-shadow-'));
    await scanTree(root, DEFAULT_POLICY, shadow, new Baselines(store));
    const paths = store.baselines().map((b) => b.path);
    expect(paths).toEqual(expect.arrayContaining(['a.ts', '.git/config', '.git/hooks/pre-commit', '.git/info/exclude']));
    expect(paths.filter((p) => p.startsWith('.git/') && !/^\.git\/(hooks\/|info\/|config$)/.test(p))).toEqual([]);
  });

  it('records a symlink by its target text without following it', async () => {
    const { root, shadow, baselines, store } = await setup({ 'a.ts': 'a' });
    symlinkSync('a.ts', join(root, 'link'));
    symlinkSync('missing', join(root, 'dangling'));
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const rows = new Map(store.baselines().map((b) => [b.path, b]));
    const target = await shadow.hash(join(root, 'link'));
    expect(rows.get('link')?.hash).toBe(target?.hash);
    expect(rows.get('link')?.hash).not.toBe(rows.get('a.ts')?.hash);
    expect(rows.get('dangling')).toBeDefined();
  });

  it('reports a change to .git/info/exclude', async () => {
    const { root, shadow, baselines } = await seededRepo();
    await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    writeFileSync(join(root, '.git/info/exclude'), '*.secret\n');
    const { drift } = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(drift.map((d) => d.path)).toEqual(['.git/info/exclude']);
  });

  it('silently skips a nested repository directory', async () => {
    const { root, shadow, baselines, store } = await setup({ 'a.ts': 'a' });
    mkdirSync(join(root, 'nested'));
    sh(join(root, 'nested'), 'init', '-q');
    writeFileSync(join(root, 'nested/inner.ts'), 'i');
    const result = await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    expect(result.unreadable).toEqual([]);
    expect(store.baselines().map((b) => b.path).filter((p) => p.startsWith('nested'))).toEqual([]);
  });
});

describe('Baselines.setMany', () => {
  it('is one Store call', () => {
    const store = openStore(tempDir('bl-store-'));
    const spy = vi.spyOn(store, 'saveBaselines');
    new Baselines(store).setMany([1, 2, 3].map((n) => ({ path: `f${n}`, hash: `h${n}`, stored: true, size: 1, mode: 0o644 })));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('hashCandidates', () => {
  it('skips a file that vanished and does not call it unreadable', async () => {
    const { root, shadow } = await setup({ 'here.ts': 'h' });
    const { blobs, unreadable } = await hashCandidates(root, shadow, ['here.ts', 'gone.ts']);
    expect([...blobs.keys()]).toEqual(['here.ts']);
    expect(unreadable).toEqual([]);
  });
});
