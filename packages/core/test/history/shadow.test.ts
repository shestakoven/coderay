import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_BLOB_BYTES, ShadowRepo } from '../../src/history/shadow';
import { tempDir } from '../helpers';

const hooks = vi.hoisted(() => ({ afterLstat: null as null | ((path: string) => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      const stat = await (actual.lstat as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof actual.lstat>>>)(path, ...rest);
      hooks.afterLstat?.(String(path));
      return stat;
    },
  };
});

function vanishAfterStat(target: string): void {
  hooks.afterLstat = (path) => { if (path === target) { hooks.afterLstat = null; rmSync(path, { force: true }); } };
}

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

beforeAll(() => {
  for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8' });
const open = () => { const dir = tempDir('shadow-'); return ShadowRepo.open(dir).then((shadow) => ({ shadow, dir })); };

describe('ShadowRepo.open', () => {
  it('creates a bare repository with the pinned config and can be opened twice', async () => {
    const dir = tempDir('shadow-');
    await ShadowRepo.open(dir);
    await ShadowRepo.open(dir);
    expect(git(dir, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(git(dir, 'config', 'gc.auto').trim()).toBe('0');
    expect(git(dir, 'config', 'core.autocrlf').trim()).toBe('false');
    expect(git(dir, 'config', 'user.name').trim()).toBe('ide');
    expect(git(dir, 'config', 'user.email').trim()).toBe('ide@localhost');
  });
});

describe('ShadowRepo.put', () => {
  it('stores a CRLF file byte-exactly', async () => {
    const { shadow } = await open();
    const file = join(tempDir('w-'), 'a.txt'); writeFileSync(file, 'a\r\nb\r\n');
    const blob = await shadow.put(file);
    expect((await shadow.read(blob!.hash))!.toString()).toBe('a\r\nb\r\n');
  });

  it('stores a CRLF file byte-exactly even when git is told to convert line endings', async () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' };
    const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const { shadow } = await open();
      const file = join(tempDir('w-'), 'a.txt'); writeFileSync(file, 'a\r\nb\r\n');
      const blob = await shadow.put(file);
      expect((await shadow.read(blob!.hash))!.toString()).toBe('a\r\nb\r\n');
      expect(blob!.size).toBe(6);
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('reports size, stored and the mode from any exec bit', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'plain'), 'hello'); chmodSync(join(w, 'plain'), 0o644);
    writeFileSync(join(w, 'exec'), 'hello'); chmodSync(join(w, 'exec'), 0o710);
    expect(await shadow.put(join(w, 'plain'))).toMatchObject({ stored: true, size: 5, mode: 0o644 });
    expect(await shadow.put(join(w, 'exec'))).toMatchObject({ stored: true, size: 5, mode: 0o755 });
  });

  it('hashes a file over the limit without storing it', async () => {
    const { shadow } = await open();
    const file = join(tempDir('w-'), 'big.bin'); writeFileSync(file, Buffer.alloc(MAX_BLOB_BYTES + 1, 7));
    const blob = await shadow.put(file);
    expect(blob).toMatchObject({ stored: false, size: MAX_BLOB_BYTES + 1 });
    expect(await shadow.read(blob!.hash)).toBeNull();
  });

  it('returns null for a missing path, a directory and a file that vanishes after stat', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    mkdirSync(join(w, 'd')); writeFileSync(join(w, 'vanishing'), 'x');
    expect(await shadow.put(join(w, 'gone'))).toBeNull();
    expect(await shadow.put(join(w, 'd'))).toBeNull();
    vanishAfterStat(join(w, 'vanishing'));
    expect(await shadow.put(join(w, 'vanishing'))).toBeNull();
  });

  it('records a symlink by the hash of its target text', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    symlinkSync('some/target', join(w, 'link'));
    const blob = await shadow.put(join(w, 'link'));
    expect(blob).toMatchObject({ stored: true, mode: 0o644 });
    expect((await shadow.read(blob!.hash))!.toString()).toBe('some/target');
  });
});

describe('ShadowRepo.hash', () => {
  it('never stores', async () => {
    const { shadow } = await open();
    const file = join(tempDir('w-'), 'a'); writeFileSync(file, 'content');
    const blob = await shadow.hash(file);
    expect(blob).toMatchObject({ stored: false, size: 7 });
    expect(await shadow.read(blob!.hash)).toBeNull();
    expect((await shadow.put(file))!.hash).toBe(blob!.hash);
  });
});

describe('ShadowRepo.putMany', () => {
  it('returns null for a directory and a missing path, and keeps the others', async () => {
    const { shadow } = await open(); const w = tempDir('w-'); writeFileSync(join(w, 'a'), 'x'); mkdirSync(join(w, 'd'));
    const got = await shadow.putMany([join(w, 'a'), join(w, 'd'), join(w, 'gone')]);
    expect([...got.values()].map((b) => b !== null)).toEqual([true, false, false]);
    expect([...got.keys()]).toEqual([join(w, 'a'), join(w, 'd'), join(w, 'gone')]);
  });

  it('matches put for regular, exec, symlink and oversized files, across batches', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    const paths: string[] = [];
    for (let i = 0; i < 520; i++) { const p = join(w, `f${i}`); writeFileSync(p, `content ${i}`); paths.push(p); }
    chmodSync(paths[3]!, 0o755);
    symlinkSync('f0', join(w, 'link')); paths.push(join(w, 'link'));
    writeFileSync(join(w, 'big'), Buffer.alloc(MAX_BLOB_BYTES + 1, 1)); paths.push(join(w, 'big'));
    writeFileSync(join(w, 'odd\nname'), 'newline'); paths.push(join(w, 'odd\nname'));
    const many = await shadow.putMany(paths);
    expect(many.size).toBe(paths.length);
    for (const p of [...paths.slice(0, 3), paths[3]!, paths[499]!, paths[500]!, ...paths.slice(-3)]) expect(many.get(p)).toEqual(await shadow.put(p));
    expect([...many.values()].filter((b) => b?.stored).length).toBe(522);
    expect(many.get(paths[3]!)!.mode).toBe(0o755);
    expect(many.get(join(w, 'big'))!.stored).toBe(false);
  });

  it('does not fail the other paths when one vanishes after stat', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'a'), 'a'); writeFileSync(join(w, 'locked'), 'l'); writeFileSync(join(w, 'c'), 'c');
    vanishAfterStat(join(w, 'locked'));
    const got = await shadow.putMany([join(w, 'a'), join(w, 'locked'), join(w, 'c')]);
    expect([...got.values()].map((b) => b !== null)).toEqual([true, false, true]);
    expect((await shadow.read(got.get(join(w, 'c'))!.hash))!.toString()).toBe('c');
  });
});

describe('ShadowRepo.restore', () => {
  it('writes the blob, creating parent directories and setting the mode', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    const src = join(w, 'src'); writeFileSync(src, '#!/bin/sh\n');
    const blob = (await shadow.put(src))!;
    const target = join(w, 'deep', 'er', 'run.sh');
    expect(await shadow.restore(blob.hash, target, 0o755)).toBe('restored');
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n');
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(await shadow.restore(blob.hash, target, 0o644)).toBe('restored');
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('deletes on null, and a missing file is fine', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'f'), 'x');
    expect(await shadow.restore(null, join(w, 'f'), 0o644)).toBe('deleted');
    expect(existsSync(join(w, 'f'))).toBe(false);
    expect(await shadow.restore(null, join(w, 'f'), 0o644)).toBe('deleted');
  });

  it('answers missing-blob and writes nothing when the content was never stored', async () => {
    const { shadow } = await open(); const target = join(tempDir('w-'), 'f');
    expect(await shadow.restore('0'.repeat(40), target, 0o644)).toBe('missing-blob');
    expect(existsSync(target)).toBe(false);
  });

  it('restores over a symlink by replacing the link, not its target', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'real'), 'original');
    symlinkSync('real', join(w, 'link'));
    writeFileSync(join(w, 'src'), 'new content');
    const blob = (await shadow.put(join(w, 'src')))!;
    expect(await shadow.restore(blob.hash, join(w, 'link'), 0o644)).toBe('restored');
    expect(readFileSync(join(w, 'real'), 'utf8')).toBe('original');
    expect(lstatSync(join(w, 'link')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(w, 'link'), 'utf8')).toBe('new content');
  });

  it('leaves no temp files behind', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'src'), 'x');
    const blob = (await shadow.put(join(w, 'src')))!;
    await shadow.restore(blob.hash, join(w, 'out'), 0o644);
    expect(execFileSync('ls', [w], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['out', 'src']);
  });
});

describe('ShadowRepo.diff', () => {
  const store = async (shadow: ShadowRepo, content: string | Buffer) => {
    const file = join(tempDir('w-'), 'f'); writeFileSync(file, content);
    return (await shadow.put(file))!.hash;
  };

  it('gives hunks with counts for text', async () => {
    const { shadow } = await open();
    const a = await store(shadow, 'one\ntwo\nthree\n');
    const b = await store(shadow, 'one\nTWO\nthree\nfour\n');
    const diff = await shadow.diff(a, b);
    expect(diff).toMatchObject({ binary: false, truncated: false, missing: false, added: 2, removed: 1 });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(diff.hunks[0]!.lines).toEqual([
      { op: 'context', text: 'one' }, { op: 'del', text: 'two' }, { op: 'add', text: 'TWO' },
      { op: 'context', text: 'three' }, { op: 'add', text: 'four' },
    ]);
  });

  it('treats null as the empty blob on either side', async () => {
    const { shadow } = await open();
    const a = await store(shadow, 'x\ny\n');
    expect(await shadow.diff(null, a)).toMatchObject({ added: 2, removed: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] });
    expect(await shadow.diff(a, null)).toMatchObject({ added: 0, removed: 2, hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }] });
  });

  it('gives an empty diff for identical sides', async () => {
    const { shadow } = await open();
    const a = await store(shadow, 'same\n');
    expect(await shadow.diff(a, a)).toEqual({ binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] });
    expect(await shadow.diff(null, null)).toEqual({ binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] });
  });

  it('ignores the no-newline marker', async () => {
    const { shadow } = await open();
    const a = await store(shadow, 'a\nb');
    const b = await store(shadow, 'a\nc');
    const diff = await shadow.diff(a, b);
    expect(diff.hunks[0]!.lines).toEqual([{ op: 'context', text: 'a' }, { op: 'del', text: 'b' }, { op: 'add', text: 'c' }]);
  });

  it('flags binary content without hunks', async () => {
    const { shadow } = await open();
    const a = await store(shadow, Buffer.from([1, 0, 2, 3]));
    const b = await store(shadow, Buffer.from([1, 0, 9, 9]));
    expect(await shadow.diff(a, b)).toEqual({ binary: true, truncated: false, missing: false, added: 0, removed: 0, hunks: [] });
    expect(await shadow.diff(null, a)).toMatchObject({ binary: true, hunks: [] });
  });

  it('cuts a long diff at 2,000 lines', async () => {
    const { shadow } = await open();
    const a = await store(shadow, Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n') + '\n');
    const b = await store(shadow, Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n') + '\n');
    const diff = await shadow.diff(a, b);
    expect(diff.truncated).toBe(true);
    expect(diff.hunks.reduce((n, h) => n + h.lines.length, 0)).toBe(2000);
    expect(diff.added).toBe(5000);
    expect(diff.removed).toBe(5000);
  });

  it('does not truncate a diff of exactly 2,000 lines', async () => {
    const { shadow } = await open();
    const b = await store(shadow, Array.from({ length: 2000 }, (_, i) => `n${i}`).join('\n') + '\n');
    const diff = await shadow.diff(null, b);
    expect(diff.truncated).toBe(false);
    expect(diff.hunks[0]!.lines).toHaveLength(2000);
  });

  it('flags a side that is not stored as missing', async () => {
    const { shadow } = await open();
    const a = await store(shadow, 'x\n');
    const expected = { binary: false, truncated: false, missing: true, added: 0, removed: 0, hunks: [] };
    expect(await shadow.diff(a, '1'.repeat(40))).toEqual(expected);
    expect(await shadow.diff('1'.repeat(40), null)).toEqual(expected);
  });
});

describe('ShadowRepo.snapshot', () => {
  it('snapshots 300 files under a ref without touching a work tree, skipping null and unstored hashes', async () => {
    const { shadow, dir } = await open(); const w = tempDir('w-');
    const files: { path: string; hash: string | null }[] = [];
    const paths = Array.from({ length: 300 }, (_, i) => join(w, `f${i}`));
    paths.forEach((p, i) => writeFileSync(p, `c${i}`));
    const stored = await shadow.putMany(paths);
    paths.forEach((p, i) => files.push({ path: `dir${i % 5}/f${i}`, hash: stored.get(p)!.hash }));
    files.push({ path: 'deleted.txt', hash: null }, { path: 'never-stored.txt', hash: '2'.repeat(40) });
    const started = Date.now();
    const sha = await shadow.snapshot('e1', files);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'rev-parse', 'refs/ide/snapshots/e1').trim()).toBe(sha);
    const listing = git(dir, 'ls-tree', '-r', 'refs/ide/snapshots/e1').split('\n').filter(Boolean);
    expect(listing).toHaveLength(300);
    expect(listing.join('\n')).not.toContain('deleted.txt');
    expect(listing.join('\n')).not.toContain('never-stored.txt');
    expect(git(dir, 'cat-file', 'blob', `refs/ide/snapshots/e1:dir0/f0`)).toBe('c0');
  });

  it('records the exec bit when given a mode and works for an empty set', async () => {
    const { shadow, dir } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'x'), 'run'); chmodSync(join(w, 'x'), 0o755);
    const blob = (await shadow.put(join(w, 'x')))!;
    await shadow.snapshot('m', [{ path: 'bin/x', hash: blob.hash, mode: blob.mode }]);
    expect(git(dir, 'ls-tree', '-r', 'refs/ide/snapshots/m')).toMatch(/^100755 blob /);
    const empty = await shadow.snapshot('empty', []);
    expect(git(dir, 'rev-parse', 'refs/ide/snapshots/empty').trim()).toBe(empty);
    expect(git(dir, 'ls-tree', '-r', 'refs/ide/snapshots/empty').trim()).toBe('');
  });
});

describe('review fixes', () => {
  const withEnv = async (env: Record<string, string>, body: () => Promise<void>) => {
    const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { await body(); } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it('keeps paths that differ only by a trailing CR apart in putMany', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'cr'), 'plain'); writeFileSync(join(w, 'cr\r'), 'with cr');
    const got = await shadow.putMany([join(w, 'cr'), join(w, 'cr\r')]);
    expect((await shadow.read(got.get(join(w, 'cr'))!.hash))!.toString()).toBe('plain');
    expect((await shadow.read(got.get(join(w, 'cr\r'))!.hash))!.toString()).toBe('with cr');
  });

  it('stores CRLF byte-exactly through putMany under autocrlf', async () => {
    await withEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' }, async () => {
      const { shadow } = await open(); const w = tempDir('w-');
      writeFileSync(join(w, 'a'), 'a\r\nb\r\n'); writeFileSync(join(w, 'b'), 'x');
      const got = await shadow.putMany([join(w, 'a'), join(w, 'b')]);
      expect((await shadow.read(got.get(join(w, 'a'))!.hash))!.toString()).toBe('a\r\nb\r\n');
    });
  });

  it('snapshots paths with a newline or a leading quote, and skips .git paths on purpose', async () => {
    const { shadow, dir } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'f'), 'content');
    const hash = (await shadow.put(join(w, 'f')))!.hash;
    await shadow.snapshot('odd', [
      { path: 'a\nb.txt', hash }, { path: '"quoted".txt', hash }, { path: 'ok/f', hash },
      { path: '.git/config', hash }, { path: 'sub/.git/hooks/x', hash }, { path: '../escape', hash },
    ]);
    const listed = git(dir, 'ls-tree', '-r', '-z', '--name-only', 'refs/ide/snapshots/odd').split('\0').filter(Boolean).sort();
    expect(listed).toEqual(['"quoted".txt', 'a\nb.txt', 'ok/f']);
  });

  it.each([
    ['diff', (s: ShadowRepo, out: string) => s.diff(`--output=${out}`, null).then(() => undefined)],
    ['read', (s: ShadowRepo, out: string) => s.read(`--output=${out}`).then(() => undefined)],
    ['restore', (s: ShadowRepo, out: string) => s.restore(`--output=${out}`, out + '.r', 0o644).then(() => undefined)],
    ['snapshot', (s: ShadowRepo, out: string) => s.snapshot('h', [{ path: 'x', hash: `--output=${out}` }]).then(() => undefined)],
  ])('never passes an option-like hash to git (%s)', async (_name, call) => {
    const { shadow } = await open(); const out = join(tempDir('w-'), 'pwned');
    await call(shadow, out);
    expect(existsSync(out)).toBe(false);
  });

  it('reports option-like and rev-expression hashes as missing', async () => {
    const { shadow } = await open(); const w = tempDir('w-'); writeFileSync(join(w, 'f'), 'x');
    const good = (await shadow.put(join(w, 'f')))!.hash;
    await shadow.snapshot('e1', [{ path: 'f', hash: good }]);
    const rev = 'refs/ide/snapshots/e1:f';
    expect(await shadow.read(rev)).toBeNull();
    expect(await shadow.read('-h')).toBeNull();
    expect(await shadow.restore(rev, join(w, 'out'), 0o644)).toBe('missing-blob');
    expect(existsSync(join(w, 'out'))).toBe(false);
    expect(await shadow.diff(rev, good)).toMatchObject({ missing: true });
    await shadow.snapshot('e2', [{ path: 'f', hash: rev }]);
    expect(await shadow.read(good)).not.toBeNull();
  });

  it('ignores git environment variables inherited from the process', async () => {
    await withEnv({
      GIT_AUTHOR_NAME: 'evil', GIT_COMMITTER_NAME: 'evil', GIT_INDEX_FILE: join(tempDir('x-'), 'bogus-index'),
      GIT_WORK_TREE: tempDir('x-'), GIT_OBJECT_DIRECTORY: join(tempDir('x-'), 'objects'),
    }, async () => {
      const { shadow, dir } = await open(); const w = tempDir('w-'); writeFileSync(join(w, 'f'), 'x');
      const blob = (await shadow.put(join(w, 'f')))!;
      await shadow.snapshot('env', [{ path: 'f', hash: blob.hash }]);
      const clean = { ...process.env }; for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) delete clean[k];
      const inspect = (...args: string[]) => execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', env: clean });
      expect(inspect('cat-file', 'blob', blob.hash)).toBe('x');
      expect(inspect('log', '-1', '--format=%an|%cn', 'refs/ide/snapshots/env').trim()).toBe('ide|ide');
    });
  });

  it('removes its temp file when the rename fails', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'src'), 'x');
    const blob = (await shadow.put(join(w, 'src')))!;
    mkdirSync(join(w, 'dir')); writeFileSync(join(w, 'dir', 'keep'), 'k');
    await expect(shadow.restore(blob.hash, join(w, 'dir'), 0o644)).rejects.toThrow();
    expect(readdirSync(w).sort()).toEqual(['dir', 'src']);
  });

  it('never reuses a temp name across instances', async () => {
    const dir = tempDir('shadow-');
    const one = await ShadowRepo.open(dir); const two = await ShadowRepo.open(dir);
    const w = tempDir('w-'); writeFileSync(join(w, 'src'), 'x');
    const blob = (await one.put(join(w, 'src')))!;
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).restore(blob.hash, join(w, `o${i}`), 0o644)));
    expect(readdirSync(w).filter((n) => n.includes('.ide-'))).toEqual([]);
  });

  it('reads the one-line hunk header with a default count of 1', async () => {
    const { shadow } = await open(); const w = tempDir('w-');
    writeFileSync(join(w, 'a'), 'a\n'); writeFileSync(join(w, 'b'), 'b\n');
    const a = (await shadow.put(join(w, 'a')))!.hash; const b = (await shadow.put(join(w, 'b')))!.hash;
    expect((await shadow.diff(a, b)).hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });
});
