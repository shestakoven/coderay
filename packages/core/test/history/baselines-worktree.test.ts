import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import { Baselines, newScanCache, scanTree } from '../../src/history/baselines';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { tempDir, writeTree } from '../helpers';
import { addSubmodule, git, isolateGit, projectWithWorktree, rewriteDotGit, submoduleSource } from '../worktree-fixture';

isolateGit();

const NO_RACY = { racyMs: 0 };
const WT1 = '.worktrees/wt1';
const WT2 = '.worktrees/wt2';

async function scanner(files: Record<string, string> = {}, dir = WT1, configure?: (root: string) => void) {
  const { root, wt } = await projectWithWorktree(files, dir, configure);
  const store = openStore(tempDir('scan-store-'));
  const shadow = await ShadowRepo.open(tempDir('scan-shadow-'));
  const baselines = new Baselines(store);
  const scan = (cache?: ReturnType<typeof newScanCache>, options?: { refresh?: boolean; racyMs?: number; unsighted?: (rels: string[]) => void }) => scanTree(root, DEFAULT_POLICY, shadow, baselines, cache, options);
  const addWorktree = (name: string): void => {
    git(root, 'worktree', 'add', '-q', `.worktrees/${name}`);
    invalidateWorktrees(root);
  };
  const paths = (): string[] => store.baselines().map((b) => b.path).sort();
  return { root, wt, store, shadow, baselines, scan, addWorktree, paths };
}

describe('scanTree with a nested worktree', () => {
  it('baselines the files of the worktree under their path from the project root, and seeds without drift', async () => {
    const c = await scanner();
    writeFileSync(join(c.wt, '.gitignore'), '.worktrees/\ndist/\n.env\n');
    await writeTree(c.wt, { '.env': 'K=1', 'dist/x.js': 'x', 'backend/src/untracked.py': 'u' });
    expect(await c.scan()).toEqual({ seeded: true, drift: [], unreadable: [] });
    const paths = c.paths();
    expect(paths).toEqual(expect.arrayContaining([`${WT1}/backend/src/a.py`, `${WT1}/README.md`, `${WT1}/.gitignore`, `${WT1}/.env`, `${WT1}/backend/src/untracked.py`]));
    expect(paths).not.toContain(`${WT1}/dist/x.js`);
    expect(paths).not.toContain(`${WT1}/.git`);
    expect(paths).toEqual(expect.arrayContaining(['backend/src/a.py', 'README.md']));
  });

  it('records the content of a worktree file as it is on disk', async () => {
    const c = await scanner();
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 2\n');
    await c.scan();
    expect(c.baselines.get(`${WT1}/backend/src/a.py`)?.hash).toBe(git(c.wt, 'hash-object', 'backend/src/a.py').trim());
  });

  it('seeds a worktree first seen after the core was seeded, silently, and reports a later change in it', async () => {
    const c = await scanner();
    await c.scan();
    c.addWorktree('wt2');
    expect(await c.scan()).toEqual({ seeded: false, drift: [], unreadable: [] });
    expect(c.paths()).toEqual(expect.arrayContaining([`${WT2}/backend/src/a.py`, `${WT2}/README.md`]));
    expect((await c.scan()).drift).toEqual([]);
    writeFileSync(join(c.root, WT2, 'backend/src/a.py'), 'a = 3\n');
    writeFileSync(join(c.root, WT2, 'backend/src/new.py'), 'new\n');
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.before === null, d.after === null]).sort()).toEqual([
      [`${WT2}/backend/src/a.py`, false, false],
      [`${WT2}/backend/src/new.py`, true, false],
    ]);
  });

  it('takes a file of a first-seen worktree that differs from a baseline as the new baseline, with no drift', async () => {
    const c = await scanner();
    await c.scan();
    c.baselines.set({ path: `${WT2}/backend/src/a.py`, hash: 'f'.repeat(40), stored: true, size: 1, mode: 0o644 });
    c.addWorktree('wt2');
    const { drift } = await c.scan();
    expect(drift).toEqual([]);
    expect(c.baselines.get(`${WT2}/backend/src/a.py`)?.hash).toBe(git(c.root, 'hash-object', 'backend/src/a.py').trim());
  });

  it('still reports real drift of the project itself in the scan that first sees a worktree', async () => {
    const c = await scanner();
    await c.scan();
    writeFileSync(join(c.root, 'backend/src/a.py'), 'outer change\n');
    rmSync(join(c.root, 'README.md'));
    c.addWorktree('wt2');
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.after === null]).sort()).toEqual([['README.md', true], ['backend/src/a.py', false]]);
  });

  it('drops the baselines under a worktree that was removed and created again, silently, and takes its new content', async () => {
    const c = await scanner();
    await c.scan();
    expect(c.baselines.get(`${WT1}/README.md`)).toBeDefined();
    git(c.root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    git(c.root, 'worktree', 'add', '-q', '.worktrees/wt1', '-b', 'again');
    rmSync(join(c.wt, 'README.md'));
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 9\n');
    writeFileSync(join(c.wt, 'backend/src/extra.py'), 'extra\n');
    invalidateWorktrees(c.root);
    expect(await c.scan()).toEqual({ seeded: false, drift: [], unreadable: [] });
    expect(c.baselines.get(`${WT1}/README.md`)).toBeUndefined();
    expect(c.baselines.get(`${WT1}/backend/src/a.py`)?.hash).toBe(git(c.wt, 'hash-object', 'backend/src/a.py').trim());
    expect(c.baselines.get(`${WT1}/backend/src/extra.py`)).toBeDefined();
  });

  it('does not take the same worktree as new again on a later scan', async () => {
    const c = await scanner();
    await c.scan();
    git(c.root, 'worktree', 'remove', '--force', '.worktrees/wt1');
    git(c.root, 'worktree', 'add', '-q', '.worktrees/wt1', '-b', 'again');
    invalidateWorktrees(c.root);
    await c.scan();
    writeFileSync(join(c.wt, 'README.md'), 'edited later\n');
    expect((await c.scan()).drift.map((d) => d.path)).toEqual([`${WT1}/README.md`]);
  });

  it('leaves a file written just now in a first-seen worktree to its watcher event instead of baselining or reporting it', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    c.addWorktree('wt2');
    const result = await c.scan(cache);
    expect(result.drift).toEqual([]);
    expect(c.paths().filter((path) => path.startsWith(`${WT2}/`))).toEqual([]);
  });

  it('baselines the settled files of a first-seen worktree on a scan with a cache', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    c.addWorktree('wt2');
    expect((await c.scan(cache, NO_RACY)).drift).toEqual([]);
    expect(c.paths()).toEqual(expect.arrayContaining([`${WT2}/backend/src/a.py`]));
  });

  it('lists the ignored guarded files of a worktree again only when asked to refresh', async () => {
    const c = await scanner();
    writeFileSync(join(c.wt, '.gitignore'), '.worktrees/\ndist/\n.env\n');
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    mkdirSync(join(c.wt, 'other'));
    writeFileSync(join(c.wt, 'other/.env'), 'K=9');
    const cached = await c.scan(cache, NO_RACY);
    const refreshed = await c.scan(cache, { refresh: true, racyMs: 0 });
    expect([cached.drift.map((d) => d.path), refreshed.drift.map((d) => d.path)]).toEqual([[], [`${WT1}/other/.env`]]);
  });

  it('reports the removal of a file of a worktree that has been seen before', async () => {
    const c = await scanner();
    await c.scan();
    rmSync(join(c.wt, 'README.md'));
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.after])).toEqual([[`${WT1}/README.md`, null]]);
  });
});

const nestedMeta = (baselines: Baselines): Record<string, { id: string | null; origin: string | null }> => JSON.parse(baselines.meta('baselines.nested') ?? '{}');

const PLACES = [
  ['gitignored', '.worktrees/wt1'],
  ['not gitignored', 'trees/w1'],
  ['guarded', '.claude/worktrees/w1'],
] as const;

describe.each(PLACES)('scanTree after a worktree in a %s place is gone', (_kind, dir) => {
  const under = (c: Awaited<ReturnType<typeof scanner>>, prefix: string = dir): string[] => c.paths().filter((path) => path.startsWith(`${prefix}/`));
  // A restarted core knows nothing of what git said before.
  const forget = (c: Awaited<ReturnType<typeof scanner>>): void => invalidateWorktrees(c.root);
  const SILENT = { seeded: false, drift: [], unreadable: [] };

  async function seen() {
    const c = await scanner({}, dir);
    await c.scan();
    expect(under(c)).toEqual(expect.arrayContaining([`${dir}/backend/src/a.py`, `${dir}/README.md`]));
    return c;
  }

  it('drops its baselines and its meta entry silently when git removed it', async () => {
    const c = await seen();
    git(c.root, 'worktree', 'remove', '--force', dir);
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect([under(c), Object.keys(nestedMeta(c.baselines))]).toEqual([[], []]);
    expect(c.baselines.get('backend/src/a.py')).toBeDefined();
  });

  it('drops them silently when the directory vanished while git still lists it', async () => {
    const c = await seen();
    rmSync(c.wt, { recursive: true });
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect([under(c), Object.keys(nestedMeta(c.baselines))]).toEqual([[], []]);
  });

  it('drops them silently when the directory vanished while the core was off, and keeps the files of the project', async () => {
    const c = await seen();
    const before = c.paths().filter((path) => !path.startsWith(`${dir}/`));
    rmSync(c.wt, { recursive: true });
    git(c.root, 'worktree', 'prune');
    expect(await c.scan()).toEqual(SILENT);
    expect(c.paths()).toEqual(before.sort());
  });

  it('drops them silently when another repository took its place, and tracks nothing in it', async () => {
    const c = await seen();
    rmSync(c.wt, { recursive: true });
    git(c.root, 'worktree', 'prune');
    git(c.root, 'clone', '-q', c.root, dir);
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect(under(c)).toEqual([]);
    expect(nestedMeta(c.baselines)[dir]).toEqual({ id: null, origin: null });
    writeFileSync(join(c.root, dir, 'backend/src/a.py'), 'a = 5\n');
    expect(await c.scan()).toEqual(SILENT);
    expect(under(c)).toEqual([]);
  });

  it('drops them silently when only its .git went away and tracks none of the files left in the directory', async () => {
    const c = await seen();
    rmSync(join(c.wt, '.git'));
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect(under(c)).toEqual([]);
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 5\n');
    expect(await c.scan()).toEqual(SILENT);
    expect(under(c)).toEqual([]);
  });

  it('takes a worktree created at that place after a replacement as new, silently', async () => {
    const c = await seen();
    rmSync(c.wt, { recursive: true });
    git(c.root, 'worktree', 'prune');
    git(c.root, 'clone', '-q', c.root, dir);
    forget(c);
    await c.scan();
    rmSync(c.wt, { recursive: true });
    git(c.root, 'worktree', 'add', '-q', dir, '-b', 'again');
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect(under(c)).toEqual(expect.arrayContaining([`${dir}/backend/src/a.py`]));
  });

  it('forgets the old place of a moved worktree silently and takes the new place as new, silently', async () => {
    const c = await seen();
    const moved = `${dir}-moved`;
    git(c.root, 'worktree', 'move', dir, moved);
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect([under(c), under(c, moved).length > 0, Object.keys(nestedMeta(c.baselines))]).toEqual([[], true, [moved]]);
    writeFileSync(join(c.root, moved, 'README.md'), 'edited after the move\n');
    expect((await c.scan()).drift.map((d) => d.path)).toEqual([`${moved}/README.md`]);
  });

  it('keeps tracking a worktree whose .git file was only rewritten, and still reports what changed meanwhile', async () => {
    const c = await seen();
    rewriteDotGit(c.wt);
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 7\n');
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.before !== null, d.after !== null])).toEqual([[`${dir}/backend/src/a.py`, true, true]]);
    expect(Object.keys(nestedMeta(c.baselines))).toEqual([dir]);
  });

  it('keeps tracking a worktree whose branch was switched meanwhile, and still reports what changed', async () => {
    const c = await seen();
    git(c.wt, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(c.wt, 'README.md'), 'edited on the other branch\n');
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.before !== null, d.after !== null])).toEqual([[`${dir}/README.md`, true, true]]);
  });

  it('takes a worktree whose git dir or HEAD is different as another one, silently', async () => {
    const c = await seen();
    git(c.root, 'worktree', 'remove', '--force', dir);
    git(c.root, 'worktree', 'add', '-q', dir, '-b', 'again');
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 9\n');
    forget(c);
    expect(await c.scan()).toEqual(SILENT);
    expect(c.baselines.get(`${dir}/backend/src/a.py`)?.hash).toBe(git(c.wt, 'hash-object', 'backend/src/a.py').trim());
  });
});

describe('scanTree with a worktree seen for the first time after the seed', () => {
  const future = (): Date => new Date(Date.now() + 60_000);

  it('hands the files written just now to the unsighted callback, without a baseline and without drift', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache);
    c.addWorktree('wt2');
    for (const file of ['backend/src/a.py', 'README.md']) utimesSync(join(c.root, WT2, file), future(), future());
    const unsighted = vi.fn();
    expect((await c.scan(cache, { unsighted })).drift).toEqual([]);
    expect(unsighted).toHaveBeenCalledTimes(1);
    expect(unsighted.mock.calls[0]![0]).toEqual(expect.arrayContaining([`${WT2}/backend/src/a.py`, `${WT2}/README.md`]));
    expect(c.paths()).not.toContain(`${WT2}/backend/src/a.py`);
    expect(c.paths()).not.toContain(`${WT2}/README.md`);
  });

  it('hands over only the files that are not settled yet and baselines the others', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    c.addWorktree('wt2');
    utimesSync(join(c.root, WT2, 'backend/src/other.py'), future(), future());
    const unsighted = vi.fn();
    expect((await c.scan(cache, { ...NO_RACY, unsighted })).drift).toEqual([]);
    expect(unsighted.mock.calls).toEqual([[[`${WT2}/backend/src/other.py`]]]);
    const baselined = c.paths().filter((path) => path.startsWith(`${WT2}/`));
    expect(baselined).toEqual(expect.arrayContaining([`${WT2}/backend/src/a.py`, `${WT2}/README.md`]));
    expect(baselined).not.toContain(`${WT2}/backend/src/other.py`);
  });

  it('does not call back when every file of the new worktree is settled, or when the scan has no cache', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    c.addWorktree('wt2');
    const unsighted = vi.fn();
    await c.scan(cache, { ...NO_RACY, unsighted });
    c.addWorktree('wt3');
    await c.scan(undefined, { unsighted });
    expect(unsighted).not.toHaveBeenCalled();
    expect(c.paths()).toEqual(expect.arrayContaining([`${WT2}/README.md`, '.worktrees/wt3/README.md']));
  });

  it('does not call back for a worktree it has seen before, whose changed file is reported as drift', async () => {
    const c = await scanner();
    const cache = newScanCache();
    await c.scan(cache, NO_RACY);
    writeFileSync(join(c.wt, 'README.md'), 'changed\n');
    const unsighted = vi.fn();
    expect((await c.scan(cache, { ...NO_RACY, unsighted })).drift.map((d) => d.path)).toEqual([`${WT1}/README.md`]);
    expect(unsighted).not.toHaveBeenCalled();
  });
});

describe('scanTree for repositories that are not worktrees of the project', () => {
  it('does not take a clone in an ignored directory for a worktree: it is neither listed in the meta nor baselined', async () => {
    const c = await scanner({ '.gitignore': '.worktrees/\nvendor/\n' });
    git(c.root, 'clone', '-q', c.root, join(c.root, 'vendor/clone1'));
    writeFileSync(join(c.root, 'vendor/clone1/notes.txt'), 'untracked in the clone\n');
    await c.scan();
    expect(Object.keys(nestedMeta(c.baselines))).toEqual([WT1]);
    expect(c.paths().filter((path) => path.startsWith('vendor/clone1/'))).toEqual([]);
    writeFileSync(join(c.root, 'vendor/clone1/backend/src/a.py'), 'changed in the clone\n');
    expect(await c.scan()).toEqual({ seeded: false, drift: [], unreadable: [] });
  });

  it('does not baseline the files of a submodule of the project or of a worktree', async () => {
    const lib = await submoduleSource();
    const c = await scanner({}, WT1, (root) => { addSubmodule(root, lib, 'vendor/lib'); });
    git(c.wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
    await c.scan();
    expect(c.paths().filter((path) => path.includes('vendor/lib/'))).toEqual([]);
  });
});

describe('scanTree with a meta of the nested worktrees that cannot be read', () => {
  it.each([['not JSON', '{not json'], ['an array', '[".worktrees/wt1"]'], ['entries of the wrong shape', '{".worktrees/wt1": 5}'], ['an entry with no identity', '{".worktrees/wt1": {}}']])(
    'takes the worktrees as new, silently, when it is %s',
    async (_what, meta) => {
      const c = await scanner();
      await c.scan();
      c.baselines.setMeta('baselines.nested', meta);
      writeFileSync(join(c.wt, 'README.md'), 'changed while the meta was bad\n');
      expect(await c.scan()).toEqual({ seeded: false, drift: [], unreadable: [] });
      expect(c.baselines.get(`${WT1}/README.md`)?.hash).toBe(git(c.wt, 'hash-object', 'README.md').trim());
      expect(Object.keys(nestedMeta(c.baselines))).toEqual([WT1]);
    },
  );
});
