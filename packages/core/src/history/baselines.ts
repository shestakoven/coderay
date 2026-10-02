import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Policy } from '@ide/protocol';
import { guardedMatcher } from '../gate/paths';
import { isWorktreeDir, nestedRepos, projectPrefix, repoIdentity, repoOrigin, type NestedRepo } from '../gate/worktrees';
import type { BaselineRecord, Store } from '../store/store';
import type { ShadowRepo, StoredBlob } from './shadow';

export const EXCLUDED_DIRS = ['node_modules', '.venv', 'venv', '__pycache__'];

const GIT_BUFFER = 256 * 1024 * 1024;
const SEEDED_KEY = 'baselines.seeded';
const NESTED_KEY = 'baselines.nested';

export class ScanError extends Error {}

export interface ScanCache { stats: Map<string, string>; ignored: string[] | null; nestedIgnored?: Map<string, string[]> }
export const newScanCache = (): ScanCache => ({ stats: new Map(), ignored: null, nestedIgnored: new Map() });
const STAT_LANES = 32;

export interface Drift { path: string; before: BaselineRecord | null; after: StoredBlob | null }
export interface ScanResult { seeded: boolean; drift: Drift[]; unreadable: string[] }

export class Baselines {
  private readonly map = new Map<string, BaselineRecord>();

  constructor(private readonly store: Store) {
    for (const row of store.baselines()) this.map.set(row.path, row);
  }

  get(rel: string): BaselineRecord | undefined { return this.map.get(rel); }

  paths(): string[] { return [...this.map.keys()]; }

  meta(key: string): string | null { return this.store.meta(key); }

  setMeta(key: string, value: string): void { this.store.setMeta(key, value); }

  set(record: BaselineRecord): void {
    this.store.saveBaselines([record], []);
    this.map.set(record.path, record);
  }

  remove(rel: string): void {
    this.store.saveBaselines([], [rel]);
    this.map.delete(rel);
  }

  remember(records: BaselineRecord[], removed: string[]): void {
    for (const path of removed) this.map.delete(path);
    for (const record of records) this.map.set(record.path, record);
  }

  setMany(records: BaselineRecord[], removed: string[] = []): void {
    this.store.saveBaselines(records, removed);
    for (const path of removed) this.map.delete(path);
    for (const record of records) this.map.set(record.path, record);
  }
}

const excluded = (rel: string, guarded: (rel: string) => boolean): boolean => {
  const parts = rel.split('/');
  if (parts.some((part) => EXCLUDED_DIRS.includes(part))) return true;
  return parts[0] === '.git' && !guarded(rel);
};

function lsFiles(root: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, 'ls-files', ...args, '-z'], { maxBuffer: GIT_BUFFER, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.split('\0').filter(Boolean));
    });
  });
}

async function walk(root: string, dir: string, skip: (rel: string) => boolean, out: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (skip(rel)) continue;
    if (entry.isDirectory()) await walk(root, rel, skip, out);
    else out.push(rel);
  }
}

function gitPath(root: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', name], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function gitInternals(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const config = await gitPath(root, 'config');
  if (await lstat(config).then((s) => s.isFile(), () => false)) out.set('.git/config', config);
  for (const name of ['hooks', 'info']) {
    const dir = await gitPath(root, name);
    const files: string[] = [];
    await walk(dir, '', () => false, files);
    for (const rel of files) out.set(`.git/${name}/${rel}`, join(dir, rel));
  }
  return out;
}

// What the IDE saw at a nested worktree: its .git (inode and birth) and its git dir and HEAD; id null once it is gone.
interface NestedMark { id: string | null; origin: string | null }
interface NestedSeen { dir: string; mark: NestedMark }
interface Candidates { rels: string[]; abs: Map<string, string>; nested: NestedSeen[] }

function markOf(abs: string): NestedMark | null {
  const id = repoIdentity(abs);
  return id === null ? null : { id, origin: repoOrigin(abs) };
}

// "git worktree repair" rewrites the .git file: the same git dir and HEAD still name the same worktree.
const sameMark = (seen: NestedMark | undefined, now: NestedMark): boolean =>
  seen !== undefined && seen.id !== null && (seen.id === now.id || (seen.origin !== null && seen.origin === now.origin));

function seenNested(baselines: Baselines): Map<string, NestedMark> {
  try {
    const parsed: unknown = JSON.parse(baselines.meta(NESTED_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>).map(([dir, value]): [string, NestedMark] => {
      const mark = typeof value === 'object' && value !== null ? (value as Partial<NestedMark>) : {};
      return [dir, { id: typeof mark.id === 'string' ? mark.id : null, origin: typeof mark.origin === 'string' ? mark.origin : null }];
    }));
  } catch {
    return new Map();
  }
}

function saveNested(baselines: Baselines, seen: Map<string, NestedMark>): void {
  const value = JSON.stringify(Object.fromEntries([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  if (value !== baselines.meta(NESTED_KEY)) baselines.setMeta(NESTED_KEY, value);
}

function rememberNested(baselines: Baselines, nested: NestedSeen[]): void {
  const seen = seenNested(baselines);
  for (const repo of nested) seen.set(repo.dir, repo.mark);
  saveNested(baselines, seen);
}

export function knownNested(baselines: Baselines, repo: NestedRepo): boolean {
  const mark = markOf(repo.abs);
  return mark !== null && sameMark(seenNested(baselines).get(repo.dir), mark);
}

// A nested worktree the IDE saw that is no longer one (removed, moved, replaced by another repository): nobody the IDE
// answers for deleted its files, so their baselines go silently and its paths are not tracked while the directory stays.
// Returns the "<dir>/" prefixes of such worktrees among the ones `wanted` names.
export function forgetGoneNested(root: string, baselines: Baselines, wanted: (dir: string) => boolean = () => true): string[] {
  const seen = seenNested(baselines);
  const gone: string[] = [];
  for (const [dir, mark] of seen) {
    if (!wanted(dir) || isWorktreeDir(root, dir) !== false) continue;
    gone.push(`${dir}/`);
    if (!existsSync(join(root, dir))) seen.delete(dir);
    else if (mark.id !== null) seen.set(dir, { id: null, origin: null });
  }
  if (gone.length === 0) return gone;
  const dropped = baselines.paths().filter((path) => gone.some((prefix) => path.startsWith(prefix)));
  if (dropped.length > 0) baselines.setMany([], dropped);
  saveNested(baselines, seen);
  return gone;
}

async function liveNested(root: string, known: Iterable<string>): Promise<(NestedSeen & { repo: NestedRepo })[]> {
  const live: (NestedSeen & { repo: NestedRepo })[] = [];
  for (const repo of await nestedRepos(root, known)) {
    const mark = markOf(repo.abs);
    if (mark !== null) live.push({ dir: repo.dir, mark, repo });
  }
  return live;
}

// The candidate files of a nested worktree, by their path from the project root; only its part that holds the project.
async function nestedFiles(root: string, repo: NestedRepo, isGuarded: (rel: string) => boolean, kept?: string[]): Promise<{ listed: string[]; ignored: string[] }> {
  const prefix = projectPrefix(root);
  const base = join(repo.abs, prefix);
  const prefixed = (inner: string): string => `${repo.dir}/${prefix}${inner}`;
  const listed = (await lsFiles(base, ['-c', '-o', '--exclude-standard'])).map(prefixed);
  const ignored = kept ?? (await lsFiles(base, ['-o', '-i', '--exclude-standard'])).filter((inner) => isGuarded(inner) || isGuarded(prefixed(inner))).map(prefixed);
  return { listed, ignored };
}

async function nestedCandidates(root: string, known: Iterable<string>, isGuarded: (rel: string) => boolean, cache: ScanCache | undefined, refresh: boolean): Promise<{ rels: string[]; nested: NestedSeen[] }> {
  const rels: string[] = [];
  const nested: NestedSeen[] = [];
  for (const { repo, dir, mark } of await liveNested(root, known)) {
    try {
      const kept = cache?.nestedIgnored?.get(dir);
      const { listed, ignored } = await nestedFiles(root, repo, isGuarded, kept && !refresh ? kept : undefined);
      cache?.nestedIgnored?.set(dir, ignored);
      for (const rel of [...listed, ...ignored]) rels.push(rel);
      nested.push({ dir, mark });
    } catch {
      // A worktree removed while it was listed has nothing left to compare.
    }
  }
  return { rels, nested };
}

async function gitCandidates(root: string, policy: Policy, known: Iterable<string>, cache?: ScanCache, refresh = false): Promise<Candidates | null> {
  if (!existsSync(join(root, '.git'))) return null;
  const guarded = guardedMatcher(policy);
  const isGuarded = (rel: string): boolean => guarded.ignores(rel);
  try {
    const tracked = await lsFiles(root, ['-c', '-o', '--exclude-standard']);
    const ignored = cache?.ignored && !refresh
      ? cache.ignored
      : (await lsFiles(root, ['-o', '-i', '--exclude-standard'])).filter((rel) => !excluded(rel, isGuarded) && isGuarded(rel));
    if (cache) cache.ignored = ignored;
    const internals = await gitInternals(root);
    const abs = new Map([...internals].filter(([rel]) => isGuarded(rel)));
    const nested = await nestedCandidates(root, known, isGuarded, cache, refresh);
    const rels = [...new Set([...tracked, ...ignored, ...abs.keys(), ...nested.rels])].filter((rel) => !excluded(rel, isGuarded)).sort();
    return { rels, abs, nested: nested.nested };
  } catch (error) {
    throw new ScanError(`git ls-files failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function walkCandidates(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, '', (rel) => rel.split('/').some((part) => EXCLUDED_DIRS.includes(part)) || rel === '.git', out);
  return out.sort();
}

export async function hashCandidates(
  root: string,
  shadow: ShadowRepo,
  rels: string[],
  abs: ReadonlyMap<string, string> = new Map(),
): Promise<{ blobs: Map<string, StoredBlob>; unreadable: string[] }> {
  const hashed = await shadow.putMany(rels.map((rel) => abs.get(rel) ?? join(root, rel)));
  const blobs = new Map<string, StoredBlob>();
  const unreadable: string[] = [];
  for (const rel of rels) {
    const blob = hashed.get(abs.get(rel) ?? join(root, rel)) ?? null;
    if (blob) {
      blobs.set(rel, blob);
      continue;
    }
    const stat = await lstat(abs.get(rel) ?? join(root, rel)).catch(() => null);
    if (stat && (stat.isFile() || stat.isSymbolicLink())) unreadable.push(rel);
  }
  return { blobs, unreadable };
}

const record = (path: string, blob: StoredBlob): BaselineRecord => ({ path, hash: blob.hash, stored: blob.stored, size: blob.size, mode: blob.mode });

const RACY_MS = 2_000;

async function signatures(root: string, rels: string[], abs: ReadonlyMap<string, string>, now: number, racyMs: number): Promise<{ sigs: Map<string, string>; settled: Set<string> }> {
  const sigs = new Map<string, string>();
  const settled = new Set<string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(STAT_LANES, rels.length) }, async () => {
    while (next < rels.length) {
      const rel = rels[next++]!;
      const stat = await lstat(abs.get(rel) ?? join(root, rel), { bigint: true }).catch(() => null);
      if (!stat) continue;
      sigs.set(rel, `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`);
      if (now - Number(stat.mtimeMs) >= racyMs && now - Number(stat.ctimeMs) >= racyMs) settled.add(rel);
    }
  }));
  return { sigs, settled };
}

export async function scanTree(
  root: string,
  policy: Policy,
  shadow: ShadowRepo,
  baselines: Baselines,
  cache?: ScanCache,
  options: { refresh?: boolean; racyMs?: number; unsighted?: (rels: string[]) => void } = {},
): Promise<ScanResult> {
  const gone = forgetGoneNested(root, baselines);
  const isGone = (path: string): boolean => gone.some((prefix) => path.startsWith(prefix));
  const seen = seenNested(baselines);
  const found = (await gitCandidates(root, policy, seen.keys(), cache, options.refresh))
    ?? { rels: await walkCandidates(root), abs: new Map<string, string>(), nested: (await liveNested(root, seen.keys())).map(({ dir, mark }) => ({ dir, mark })) };
  const seeding = baselines.meta(SEEDED_KEY) === null;
  const { sigs, settled } = cache ? await signatures(root, found.rels, found.abs, Date.now(), options.racyMs ?? RACY_MS) : { sigs: new Map<string, string>(), settled: new Set<string>() };
  const trusted = (): Map<string, string> => new Map([...sigs].filter(([rel]) => settled.has(rel)));
  const toHash = cache && !seeding ? found.rels.filter((rel) => sigs.get(rel) !== cache.stats.get(rel)) : found.rels;
  const hashing = new Set(toHash);
  const { blobs, unreadable } = await hashCandidates(root, shadow, toHash, found.abs);
  if (seeding) {
    for (const path of baselines.paths()) if (!blobs.has(path)) baselines.remove(path);
    baselines.setMany([...blobs].map(([path, blob]) => record(path, blob)));
    baselines.setMeta(SEEDED_KEY, '1');
    rememberNested(baselines, found.nested);
    for (const rel of unreadable) sigs.delete(rel);
    if (cache) cache.stats = trusted();
    return { seeded: true, drift: [], unreadable };
  }
  const skipped = new Set(unreadable);
  // A nested worktree seen for the first time is taken as it is: its files are not changes made while nobody watched.
  // A file written just now is left to its watcher event, which knows its git version as the before-image.
  const fresh = found.nested.filter((repo) => !sameMark(seen.get(repo.dir), repo.mark)).map((repo) => `${repo.dir}/`);
  const isFresh = (path: string): boolean => fresh.some((prefix) => path.startsWith(prefix));
  const quiet: BaselineRecord[] = [];
  const unsighted: string[] = [];
  const dropped: string[] = [];
  const drift: Drift[] = [];
  for (const [path, blob] of blobs) {
    const before = baselines.get(path) ?? null;
    if (isGone(path)) continue;
    if (isFresh(path)) {
      if (cache && !settled.has(path)) unsighted.push(path);
      else if (before?.hash !== blob.hash) quiet.push(record(path, blob));
    } else if (!before || before.hash !== blob.hash) {
      drift.push({ path, before, after: blob });
    }
  }
  for (const path of baselines.paths()) {
    if (blobs.has(path) || skipped.has(path) || (cache && !hashing.has(path) && sigs.has(path))) continue;
    if (await lstat(found.abs.get(path) ?? join(root, path)).then(() => true, () => false)) continue;
    if (isFresh(path)) dropped.push(path);
    else drift.push({ path, before: baselines.get(path) ?? null, after: null });
  }
  if (quiet.length > 0 || dropped.length > 0) baselines.setMany(quiet, dropped);
  if (unsighted.length > 0) options.unsighted?.(unsighted);
  rememberNested(baselines, found.nested);
  if (cache) {
    for (const d of drift) sigs.delete(d.path);
    for (const rel of hashing) if (!blobs.has(rel)) sigs.delete(rel);
    cache.stats = trusted();
  }
  return { seeded: false, drift, unreadable };
}

// The first sight of a nested worktree while the IDE runs: its files as they are now become its baselines, as a scan
// would take them. The paths in hand and the files written just now are left to their watcher events; returned.
export async function seedNested(
  root: string,
  policy: Policy,
  shadow: ShadowRepo,
  baselines: Baselines,
  repo: NestedRepo,
  pending: ReadonlySet<string>,
  racyMs = RACY_MS,
): Promise<string[]> {
  const mark = markOf(repo.abs);
  if (mark === null) return [];
  const guarded = guardedMatcher(policy);
  const isGuarded = (rel: string): boolean => guarded.ignores(rel);
  let files: { listed: string[]; ignored: string[] };
  try {
    files = await nestedFiles(root, repo, isGuarded);
  } catch {
    return [];
  }
  const rels = [...files.listed, ...files.ignored].filter((rel) => !pending.has(rel) && !excluded(rel, isGuarded));
  const { settled } = await signatures(root, rels, new Map(), Date.now(), racyMs);
  const { blobs } = await hashCandidates(root, shadow, rels.filter((rel) => settled.has(rel)));
  const prefix = `${repo.dir}/`;
  // Baselines of an earlier repository at this place say nothing about this one.
  const stale = baselines.paths().filter((path) => path.startsWith(prefix) && !blobs.has(path));
  baselines.setMany([...blobs].map(([path, blob]) => record(path, blob)), stale);
  rememberNested(baselines, [{ dir: repo.dir, mark }]);
  return [...pending, ...rels.filter((rel) => !blobs.has(rel))];
}
