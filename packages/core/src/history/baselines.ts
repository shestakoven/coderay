import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Policy } from '@ide/protocol';
import { guardedMatcher } from '../gate/paths';
import type { BaselineRecord, Store } from '../store/store';
import type { ShadowRepo, StoredBlob } from './shadow';

export const EXCLUDED_DIRS = ['node_modules', '.venv', 'venv', '__pycache__'];

const GIT_BUFFER = 256 * 1024 * 1024;
const SEEDED_KEY = 'baselines.seeded';

export class ScanError extends Error {}

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

interface Candidates { rels: string[]; abs: Map<string, string> }

async function gitCandidates(root: string, policy: Policy): Promise<Candidates | null> {
  if (!existsSync(join(root, '.git'))) return null;
  const guarded = guardedMatcher(policy);
  const isGuarded = (rel: string): boolean => guarded.ignores(rel);
  try {
    const tracked = await lsFiles(root, ['-c', '-o', '--exclude-standard']);
    const ignored = (await lsFiles(root, ['-o', '-i', '--exclude-standard'])).filter((rel) => !excluded(rel, isGuarded) && isGuarded(rel));
    const internals = await gitInternals(root);
    const abs = new Map([...internals].filter(([rel]) => isGuarded(rel)));
    const rels = [...new Set([...tracked, ...ignored, ...abs.keys()])].filter((rel) => !excluded(rel, isGuarded)).sort();
    return { rels, abs };
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

export async function scanTree(root: string, policy: Policy, shadow: ShadowRepo, baselines: Baselines): Promise<ScanResult> {
  const found = (await gitCandidates(root, policy)) ?? { rels: await walkCandidates(root), abs: new Map<string, string>() };
  const { blobs, unreadable } = await hashCandidates(root, shadow, found.rels, found.abs);
  if (baselines.meta(SEEDED_KEY) === null) {
    for (const path of baselines.paths()) if (!blobs.has(path)) baselines.remove(path);
    baselines.setMany([...blobs].map(([path, blob]) => record(path, blob)));
    baselines.setMeta(SEEDED_KEY, '1');
    return { seeded: true, drift: [], unreadable };
  }
  const skipped = new Set(unreadable);
  const drift: Drift[] = [];
  for (const [path, blob] of blobs) {
    const before = baselines.get(path) ?? null;
    if (!before || before.hash !== blob.hash) drift.push({ path, before, after: blob });
  }
  for (const path of baselines.paths()) {
    if (blobs.has(path) || skipped.has(path)) continue;
    if (await lstat(found.abs.get(path) ?? join(root, path)).then(() => true, () => false)) continue;
    drift.push({ path, before: baselines.get(path) ?? null, after: null });
  }
  return { seeded: false, drift, unreadable };
}
