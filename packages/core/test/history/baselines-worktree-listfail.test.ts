import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifyPaths } from '../../src/gate/paths';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { tempDir } from '../helpers';
import { git, isolateGit, projectWithWorktree } from '../worktree-fixture';

isolateGit();

const listing = vi.hoisted(() => ({ fails: false }));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = (...args: unknown[]) => {
    const [, argv, , callback] = args as [string, unknown, unknown, unknown];
    if (listing.fails && Array.isArray(argv) && argv.includes('worktree') && argv.includes('list') && typeof callback === 'function') {
      queueMicrotask(() => callback(new Error('git worktree list failed'), '', ''));
      return undefined;
    }
    return (actual.execFile as (...rest: unknown[]) => unknown)(...args);
  };
  return { ...actual, execFile };
});

const DIR = 'trees/w1';
const SILENT = { seeded: false, drift: [], unreadable: [] };

async function seeded() {
  listing.fails = false;
  const { root, wt } = await projectWithWorktree({}, DIR);
  const store = openStore(tempDir('lf-store-'));
  const shadow = await ShadowRepo.open(tempDir('lf-shadow-'));
  const baselines = new Baselines(store);
  const scan = () => scanTree(root, DEFAULT_POLICY, shadow, baselines);
  await scan();
  expect(baselines.paths()).toContain(`${DIR}/backend/src/a.py`);
  const restart = (listFails: boolean): void => {
    invalidateWorktrees(root);
    listing.fails = listFails;
  };
  return { root, wt, baselines, scan, restart, paths: () => baselines.paths().sort() };
}

describe('scanTree when git cannot list the worktrees', () => {
  it('scans a worktree the meta of the baselines names and reports what changed in it meanwhile', async () => {
    const c = await seeded();
    writeFileSync(join(c.wt, 'backend/src/a.py'), 'a = 2\n');
    c.restart(true);
    const { drift } = await c.scan();
    expect(drift.map((d) => [d.path, d.before !== null, d.after !== null])).toEqual([[`${DIR}/backend/src/a.py`, true, true]]);
  });

  it('reports a file of that worktree removed meanwhile', async () => {
    const c = await seeded();
    rmSync(join(c.wt, 'README.md'));
    c.restart(true);
    expect((await c.scan()).drift.map((d) => [d.path, d.after])).toEqual([[`${DIR}/README.md`, null]]);
  });

  it('still drops the baselines of a known directory that another repository took over', async () => {
    const c = await seeded();
    rmSync(c.wt, { recursive: true });
    git(c.root, 'worktree', 'prune');
    git(c.root, 'clone', '-q', c.root, DIR);
    c.restart(true);
    expect(await c.scan()).toEqual(SILENT);
    expect(c.paths().filter((path) => path.startsWith(`${DIR}/`))).toEqual([]);
  });

  it('takes a worktree the meta does not name as new once git can list them again, silently', async () => {
    const c = await seeded();
    git(c.root, 'worktree', 'add', '-q', 'trees/w2');
    c.restart(true);
    expect(await c.scan()).toEqual(SILENT);
    expect(c.paths().filter((path) => path.startsWith('trees/w2/'))).toEqual([]);
    c.restart(false);
    expect(await c.scan()).toEqual(SILENT);
    expect(c.paths()).toEqual(expect.arrayContaining(['trees/w2/backend/src/a.py']));
  });

  it('remembers the known worktree for the classification of its paths in this run', async () => {
    const c = await seeded();
    c.restart(true);
    await c.scan();
    invalidateWorktrees(c.root);
    const [info] = await classifyPaths([join(c.root, DIR, 'backend/src/a.py')], { root: c.root, policy: DEFAULT_POLICY, home: tempDir('lf-home-'), tempRoots: [] });
    expect(info).toMatchObject({ cls: 'enforced', scopeRel: 'backend/src/a.py' });
  });
});
