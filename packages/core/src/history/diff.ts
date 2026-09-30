import { posix } from 'node:path';
import type { ChangeView, FileDiff } from '@ide/protocol';
import type { Baselines } from './baselines';
import type { Checkpoints } from './checkpoints';
import type { ShadowRepo } from './shadow';

const CACHE_SIZE = 200;

export class DiffError extends Error {}

export interface DiffServiceOptions {
  shadow: ShadowRepo;
  changes: () => ChangeView[];
  baselines: Baselines;
  checkpoints: Pick<Checkpoints, 'manifests'>;
  cacheSize?: number;
}

const validPath = (path: string): boolean =>
  path !== '' && !path.includes('\0') && !path.includes('\\') && !posix.isAbsolute(path) && posix.normalize(path) === path && path !== '.' && !path.startsWith('../') && path !== '..' && !path.endsWith('/');

export class DiffService {
  private readonly cache = new Map<string, Promise<FileDiff>>();
  private gitCalls = 0;

  constructor(private readonly o: DiffServiceOptions) {}

  stats(): { gitCalls: number } { return { gitCalls: this.gitCalls }; }

  async diff(path: string, before: string | null, after: string | null): Promise<FileDiff> {
    if (!validPath(path)) throw new DiffError('not a project-relative path');
    const allowed = new Set<string | null | undefined>([null, this.o.baselines.get(path)?.hash]);
    for (const c of this.o.changes()) if (c.path === path) { allowed.add(c.beforeHash); allowed.add(c.afterHash); }
    if (!allowed.has(before) || !allowed.has(after)) throw new DiffError('no recorded version of this path has that content');
    if (before === after) return { binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] };
    const key = `${before ?? ''}:${after ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    this.gitCalls += 1;
    const pending = this.o.shadow.diff(before, after);
    this.cache.set(key, pending);
    pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); });
    if (this.cache.size > (this.o.cacheSize ?? CACHE_SIZE)) this.cache.delete(this.cache.keys().next().value as string);
    return pending;
  }

  async netDiff(path: string): Promise<FileDiff | null> {
    const own = this.o.changes().filter((c) => c.path === path);
    if (own.length === 0) return null;
    return this.diff(path, own[0]!.beforeHash, own[own.length - 1]!.afterHash);
  }

  async stepDiff(planId: string, stepKey: string, path: string): Promise<FileDiff | null> {
    const record = this.o.checkpoints.manifests(planId, stepKey);
    if (!record || !(path in record.before || path in record.after)) return null;
    return this.diff(path, record.before[path] ?? null, record.after[path] ?? null);
  }
}
