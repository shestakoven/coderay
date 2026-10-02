import { lstatSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import type { Policy } from '@ide/protocol';
import { gitIgnored } from './gitignore';
import { discoverNestedRepo, invalidateWorktrees, refreshWorktrees, scopeRelOf, worktreeOf, type WorktreeHit } from './worktrees';

export type PathClass = 'enforced' | 'recorded' | 'temp' | 'outside';

export interface PathInfo {
  abs: string;
  rel: string | null;
  cls: PathClass;
  guarded: boolean;
  isDir: boolean;
  exists: boolean;
  why: string;
  // The path the project names this file by: its path inside a nested worktree; absent for any other path.
  scopeRel?: string;
}

export interface ClassifyContext {
  root: string;
  policy: Policy;
  home?: string;
  tempRoots?: string[];
}

const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero']);

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

const MAX_LINK_HOPS = 40;

function danglingLink(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(realpathSync.native(dirname(path)), readlinkSync(path));
  } catch {
    return null;
  }
}

export function realTarget(path: string, cwd: string): string {
  let abs = resolve(cwd, path);
  for (let hops = 0; ; hops += 1) {
    const rest: string[] = [];
    let next: string | null = null;
    for (let dir = abs; next === null; dir = dirname(dir)) {
      try {
        return join(realpathSync.native(dir), ...[...rest].reverse());
      } catch {
        const link = hops < MAX_LINK_HOPS ? danglingLink(dir) : null;
        if (link !== null) next = join(link, ...[...rest].reverse());
        else if (dirname(dir) === dir) return abs;
        else rest.push(basename(dir));
      }
    }
    abs = next;
  }
}

export function defaultTempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  for (const candidate of [tmpdir(), '/tmp', env.TMPDIR, env.TMP]) {
    if (!candidate) continue;
    try {
      roots.add(realpathSync.native(candidate));
    } catch {
      // A configured temp directory that does not exist holds nothing to classify.
    }
  }
  return [...roots];
}

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function homes(home: string): string[] {
  try {
    return [...new Set([home, realpathSync.native(home)])];
  } catch {
    return [home];
  }
}

function allowedPatterns(entries: string[], home: string): string[] {
  return [...new Set(entries.flatMap((entry) => homes(home).flatMap((base) => {
    const expanded = expandHome(entry, base);
    return expanded.endsWith('/') ? [`${expanded}**`, expanded.slice(0, -1)] : [expanded];
  })))];
}

export const guardedMatcher = (policy: Policy) => ignore().add(policy.guarded);

export async function classifyPaths(paths: string[], ctx: ClassifyContext): Promise<PathInfo[]> {
  const home = ctx.home ?? homedir();
  const temps = ctx.tempRoots ?? defaultTempRoots();
  const guarded = guardedMatcher(ctx.policy);
  const harness = ignore().add(ctx.policy.harness);
  const allowed = allowedPatterns(ctx.policy.outsideAllowed, home);
  const inside = paths.filter((abs) => abs !== ctx.root && under(abs, ctx.root));
  if (inside.some((abs) => basename(abs) === '.git' && abs !== join(ctx.root, '.git'))) invalidateWorktrees(ctx.root);
  if (inside.length > 0) await refreshWorktrees(ctx.root);
  const nested = new Map<number, WorktreeHit>();
  const inNested = (base: Omit<PathInfo, 'rel' | 'cls' | 'why'>, rel: string, hit: WorktreeHit): PathInfo => {
    const scopeRel = scopeRelOf(ctx.root, hit);
    if (scopeRel === null) return { ...base, rel, cls: 'recorded', why: 'outside the project in a nested worktree' };
    if (scopeRel === '') return { ...base, rel, scopeRel, cls: 'enforced', why: 'the project root in a nested worktree' };
    const probes = base.isDir ? [`${rel}/`, `${scopeRel}/`] : [rel, scopeRel];
    const info = { ...base, rel, scopeRel };
    if (probes.some((probe) => guarded.ignores(probe))) return { ...info, cls: 'enforced', guarded: true, why: 'a guarded path' };
    if (probes.some((probe) => harness.ignores(probe))) return { ...info, cls: 'recorded', why: 'a harness path' };
    return { ...info, cls: 'enforced', why: 'a project file in a nested worktree' };
  };
  const infos = paths.map((abs, index): PathInfo => {
    const stat = statOrNull(abs);
    const base = { abs, isDir: stat?.isDirectory() ?? false, exists: stat !== null, guarded: false };
    if (under(abs, ctx.root)) {
      const rel = relative(ctx.root, abs).split(sep).join('/');
      if (rel === '') return { ...base, rel, cls: 'enforced', why: 'the project root' };
      const hit = worktreeOf(ctx.root, rel);
      if (hit) {
        nested.set(index, hit);
        return inNested(base, rel, hit);
      }
      const probe = base.isDir ? `${rel}/` : rel;
      if (guarded.ignores(probe)) return { ...base, rel, cls: 'enforced', guarded: true, why: 'a guarded path' };
      if (rel === '.git' || rel.startsWith('.git/')) return { ...base, rel, cls: 'recorded', why: 'git internals' };
      if (harness.ignores(probe)) return { ...base, rel, cls: 'recorded', why: 'a harness path' };
      return { ...base, rel, cls: 'enforced', why: 'a project file' };
    }
    if (DEVICES.has(abs) || abs.startsWith('/dev/fd/')) return { ...base, rel: null, cls: 'temp', why: 'a device' };
    if (temps.some((dir) => under(abs, dir))) return { ...base, rel: null, cls: 'temp', why: 'a temporary directory' };
    if (allowed.some((pattern) => posix.matchesGlob(abs, pattern))) return { ...base, rel: null, cls: 'temp', why: 'allowed outside the project' };
    return { ...base, rel: null, cls: 'outside', why: 'outside the project' };
  });
  const checked = (i: number): boolean => infos[i]!.cls === 'enforced' && !infos[i]!.guarded && Boolean(infos[i]!.rel);
  const outer = infos.flatMap((_, i) => (checked(i) && !nested.has(i) ? [i] : []));
  const { ignored, submodule } = await gitIgnored(ctx.root, outer.map((i) => infos[i]!.rel as string));
  for (const i of outer) {
    const info = infos[i]!;
    if (submodule.has(info.rel as string)) {
      infos[i] = { ...info, cls: 'recorded', why: 'inside a submodule' };
      continue;
    }
    if (!ignored.has(info.rel as string)) continue;
    const hit = discoverNestedRepo(ctx.root, info.rel as string);
    if (hit) {
      nested.set(i, hit);
      infos[i] = inNested(info, info.rel as string, hit);
    } else {
      infos[i] = { ...info, cls: 'recorded', why: 'gitignored' };
    }
  }
  const byRepo = new Map<string, number[]>();
  for (const [i, hit] of nested) {
    if (!checked(i)) continue;
    const indexes = byRepo.get(hit.worktreeRoot);
    if (indexes) indexes.push(i);
    else byRepo.set(hit.worktreeRoot, [i]);
  }
  await Promise.all([...byRepo].map(async ([repo, indexes]) => {
    const inner = await gitIgnored(repo, indexes.map((i) => nested.get(i)!.inner));
    for (const i of indexes) {
      const path = nested.get(i)!.inner;
      if (inner.submodule.has(path)) infos[i] = { ...infos[i]!, cls: 'recorded', why: 'inside a submodule' };
      else if (inner.ignored.has(path)) infos[i] = { ...infos[i]!, cls: 'recorded', why: 'gitignored' };
    }
  }));
  return infos;
}
