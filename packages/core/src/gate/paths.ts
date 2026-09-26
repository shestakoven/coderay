import { realpathSync, statSync, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import type { Policy } from '@ide/protocol';
import { gitIgnored } from './gitignore';

export type PathClass = 'enforced' | 'recorded' | 'temp' | 'outside';

export interface PathInfo {
  abs: string;
  rel: string | null;
  cls: PathClass;
  guarded: boolean;
  isDir: boolean;
  exists: boolean;
  why: string;
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

export function realTarget(path: string, cwd: string): string {
  const abs = resolve(cwd, path);
  const rest: string[] = [];
  for (let dir = abs; ; dir = dirname(dir)) {
    try {
      return join(realpathSync.native(dir), ...[...rest].reverse());
    } catch {
      if (dirname(dir) === dir) return abs;
      rest.push(basename(dir));
    }
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

function allowedPatterns(entries: string[], home: string): string[] {
  return entries.flatMap((entry) => {
    const expanded = expandHome(entry, home);
    return expanded.endsWith('/') ? [`${expanded}**`, expanded.slice(0, -1)] : [expanded];
  });
}

export async function classifyPaths(paths: string[], ctx: ClassifyContext): Promise<PathInfo[]> {
  const home = ctx.home ?? homedir();
  const temps = ctx.tempRoots ?? defaultTempRoots();
  const guarded = ignore().add(ctx.policy.guarded);
  const harness = ignore().add(ctx.policy.harness);
  const allowed = allowedPatterns(ctx.policy.outsideAllowed, home);
  const infos = paths.map((abs): PathInfo => {
    const stat = statOrNull(abs);
    const base = { abs, isDir: stat?.isDirectory() ?? false, exists: stat !== null, guarded: false };
    if (under(abs, ctx.root)) {
      const rel = relative(ctx.root, abs).split(sep).join('/');
      if (rel === '') return { ...base, rel, cls: 'enforced', why: 'the project root' };
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
  const candidates = infos.filter((info) => info.cls === 'enforced' && !info.guarded && info.rel);
  const ignored = await gitIgnored(ctx.root, candidates.map((info) => info.rel as string));
  return infos.map((info) =>
    info.cls === 'enforced' && !info.guarded && info.rel !== null && ignored.has(info.rel) ? { ...info, cls: 'recorded', why: 'gitignored' } : info,
  );
}
