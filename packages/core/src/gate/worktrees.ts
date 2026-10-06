import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// A linked worktree of the project's own repository under the project root holds a copy of the project:
// its files are judged as the project's own, by their path inside it. Any other nested repository is not the project.

const GIT_TIMEOUT_MS = 2000;
const TTL_MS = 3000;
const SKIPPED = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git']);
const LIST = ['worktree', 'list', '--porcelain'];

export interface NestedRepo { dir: string; abs: string }
// inner: the path inside the worktree, as its own git names it.
export interface WorktreeHit { worktreeRoot: string; dir: string; inner: string }

type Kind = 'none' | 'same' | 'foreign';

interface State {
  listed: NestedRepo[];
  loaded: boolean;
  listedAt: number;
  generation: number;
  loading: Promise<void> | null;
  found: Map<string, NestedRepo>;
  kinds: Map<string, { kind: Kind; at: number }>;
  common: string | null;
  prefix: string | null;
}

const states = new Map<string, State>();

function stateOf(root: string): State {
  let state = states.get(root);
  if (!state) {
    state = { listed: [], loaded: false, listedAt: -Infinity, generation: 0, loading: null, found: new Map(), kinds: new Map(), common: null, prefix: null };
    states.set(root, state);
  }
  return state;
}

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function hasDotGit(abs: string): boolean {
  try {
    lstatSync(join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}

const gitSync = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The project's repository (its common git dir) and where the project root lies in it ("" at its top).
function ownRepo(root: string, state: State): { common: string | null; prefix: string } {
  if (state.prefix === null) {
    try {
      const [common, prefix] = gitSync(root, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-prefix']).split('\n');
      state.common = realOr(common!.trim());
      state.prefix = prefix?.trim() ?? '';
    } catch {
      return { common: null, prefix: '' };
    }
  }
  return { common: state.common, prefix: state.prefix };
}

function parse(root: string, porcelain: string): NestedRepo[] {
  const base = realOr(root);
  const repos: NestedRepo[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const rel = relative(base, realOr(line.slice('worktree '.length)));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const abs = join(root, rel);
    if (hasDotGit(abs)) repos.push({ dir: rel.split(sep).join('/'), abs });
  }
  return repos;
}

function loadSync(root: string, state: State): void {
  try {
    state.listed = parse(root, gitSync(root, LIST));
  } catch {
    state.listed = [];
  }
  state.loaded = true;
  state.listedAt = Date.now();
}

export function refreshWorktrees(root: string): Promise<void> {
  const state = stateOf(root);
  if (Date.now() - state.listedAt < TTL_MS) return Promise.resolve();
  const generation = state.generation;
  const loading = state.loading ?? new Promise<void>((resolve) => {
    execFile('git', ['-C', root, ...LIST], { timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (state.loading === loading) state.loading = null;
      // A listing started before the cache was invalidated may miss what changed since: it is not taken.
      if (generation === state.generation) {
        state.listed = error ? [] : parse(root, stdout);
        state.loaded = true;
        state.listedAt = Date.now();
      }
      for (const [dir, repo] of state.found) if (!hasDotGit(repo.abs)) state.found.delete(dir);
      resolve();
    });
  });
  state.loading = loading;
  return loading;
}

// A ".git" appearing or vanishing under the root may add or remove a worktree.
export function invalidateWorktrees(root: string): void {
  const state = stateOf(root);
  state.generation += 1;
  state.listedAt = -Infinity;
  state.loading = null;
  state.kinds.clear();
}

export function worktreeOf(root: string, rel: string): WorktreeHit | null {
  const state = stateOf(root);
  if (!state.loaded) loadSync(root, state);
  let best: NestedRepo | null = null;
  for (const repo of [...state.listed, ...state.found.values()]) {
    if (rel.startsWith(`${repo.dir}/`) && (best === null || repo.dir.length > best.dir.length)) best = repo;
  }
  // A worktree being removed stops being one as soon as its .git is gone, before the cached list catches up.
  if (best === null || !hasDotGit(best.abs)) return null;
  const inner = rel.slice(best.dir.length + 1);
  if (inner === '.git' || inner.startsWith('.git/')) return null;
  return { worktreeRoot: best.abs, dir: best.dir, inner };
}

// The worktree of the project's repository that a directory lies in, itself included.
export function worktreeAt(root: string, abs: string): WorktreeHit | null {
  const rel = relative(root, abs).split(sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  // Named as a file in the directory, which is how both lookups take a path.
  const inside = `${rel}/.`;
  return worktreeOf(root, inside) ?? discoverNestedRepo(root, inside);
}

// The path the project names a worktree file by; null for a file outside the project's part of the worktree,
// when the project root is a subdirectory of its repository.
export function scopeRelOf(root: string, hit: WorktreeHit): string | null {
  const { prefix } = ownRepo(root, stateOf(root));
  if (prefix === '') return hit.inner;
  if (`${hit.inner}/` === prefix) return '';
  return hit.inner.startsWith(prefix) ? hit.inner.slice(prefix.length) : null;
}

// Where the project's own files lie in each worktree known now.
export function worktreeBases(root: string): string[] {
  const state = stateOf(root);
  if (!state.loaded) loadSync(root, state);
  const repos = [...state.listed, ...state.found.values()].filter((repo) => hasDotGit(repo.abs));
  if (repos.length === 0) return [];
  const { prefix } = ownRepo(root, state);
  return repos.map((repo) => join(repo.abs, prefix));
}

// Where the project root lies in its repository, which is also where it lies in each worktree ("" at the top).
export function projectPrefix(root: string): string {
  return ownRepo(root, stateOf(root)).prefix;
}

// 'unknown' when git could not answer: neither taken for a worktree nor for another repository, and not cached.
function kindAt(root: string, state: State, dir: string): Kind | 'unknown' {
  const cached = state.kinds.get(dir);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.kind;
  const abs = join(root, dir);
  let kind: Kind = 'none';
  if (hasDotGit(abs)) {
    const { common } = ownRepo(root, state);
    let theirs: string;
    try {
      theirs = realOr(gitSync(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    } catch {
      return 'unknown';
    }
    if (common === null) return 'unknown';
    kind = theirs === common ? 'same' : 'foreign';
  }
  state.kinds.set(dir, { kind, at: Date.now() });
  return kind;
}

// Whether a directory holds a worktree of the project's own repository (a clone, a submodule or another repository
// is not one); null when git cannot tell.
export function isWorktreeDir(root: string, dir: string): boolean | null {
  if (!hasDotGit(join(root, dir))) return false;
  const kind = kindAt(root, stateOf(root), dir);
  return kind === 'unknown' ? null : kind === 'same';
}

// The nearest enclosing worktree of the project's repository around a path the project's own repo ignores,
// for one the cached listing does not know yet; remembered for this run.
export function discoverNestedRepo(root: string, rel: string): WorktreeHit | null {
  const parts = rel.split('/');
  if (parts.some((part) => SKIPPED.has(part))) return null;
  const state = stateOf(root);
  for (let n = parts.length - 1; n >= 1; n -= 1) {
    const dir = parts.slice(0, n).join('/');
    const kind = kindAt(root, state, dir);
    if (kind === 'none') continue;
    if (kind !== 'same') return null;
    state.found.set(dir, { dir, abs: join(root, dir) });
    return { worktreeRoot: join(root, dir), dir, inner: parts.slice(n).join('/') };
  }
  return null;
}

// The worktrees under the root: the ones git lists, the ones found since, and the known ones that still are worktrees.
export async function nestedRepos(root: string, known: Iterable<string> = []): Promise<NestedRepo[]> {
  await refreshWorktrees(root);
  const state = stateOf(root);
  const all = new Map<string, NestedRepo>();
  for (const repo of [...state.listed, ...state.found.values()]) all.set(repo.dir, repo);
  for (const dir of known) {
    if (all.has(dir) || isWorktreeDir(root, dir) !== true) continue;
    const repo = { dir, abs: join(root, dir) };
    state.found.set(dir, repo);
    all.set(dir, repo);
  }
  return [...all.values()];
}

// Changes when the repository at this place is replaced by another one, so a fresh one is seeded again.
export function repoIdentity(abs: string): string | null {
  try {
    const stat = lstatSync(join(abs, '.git'));
    return `${stat.ino}:${Math.trunc(stat.birthtimeMs)}`;
  } catch {
    return null;
  }
}

// The git dir of a worktree and its HEAD: unchanged by "git worktree repair", which rewrites its .git file.
export function repoOrigin(abs: string): string | null {
  try {
    const dotgit = join(abs, '.git');
    const gitdir = lstatSync(dotgit).isDirectory() ? dotgit : resolve(abs, /^gitdir: (.+)$/m.exec(readFileSync(dotgit, 'utf8'))?.[1]?.trim() ?? '.git');
    return `${realOr(gitdir)}\n${readFileSync(join(gitdir, 'HEAD'), 'utf8').trim()}`;
  } catch {
    return null;
  }
}
