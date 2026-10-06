import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { FileDiff, GitBranch, GitSide, GitStatus } from '@ide/protocol';
import type { IdeWrites } from '../history/ide-writes';
import { EMPTY_DIFF, parseHunks } from '../history/unified-diff';
import { createRun, GitError, type GitRun } from './git-run';
import { parseStatus } from './status-parse';

const COMMIT_TIMEOUT_MS = 120_000;
const BATCH = 200;
const NO_REPO: GitStatus = { repo: false, branch: null, detached: false, sha: null, upstream: null, ahead: 0, behind: 0, files: [], operation: null, busy: null, problem: null };

export interface GitServiceOptions {
  root: string;
  ideWrites: Pick<IdeWrites, 'expect'>;
  agentBusy: () => string | null;
  git?: string;
  debounceMs?: number;
}

interface Place {
  top: string;
  // The project root relative to the repository top, with a trailing slash; empty when they are the same folder.
  prefix: string;
  gitDir: string;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function checkPaths(paths: string[]): void {
  for (const path of paths) {
    if (path === '' || path.includes('\0') || posix.isAbsolute(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git')) {
      throw new GitError(`"${path}" is not a path inside the project.`);
    }
  }
}

function* chunks<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += BATCH) yield items.slice(i, i + BATCH);
}

function operationOf(gitDir: string): GitStatus['operation'] {
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}

async function diffOf(run: GitRun, tail: string[]): Promise<FileDiff> {
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
  const read = { readOnly: true, okCodes: [1] };
  const [numstat] = (await run(['diff', ...flags, '--numstat', ...tail], read)).split('\n');
  if (!numstat) return { ...EMPTY_DIFF };
  const [added, removed] = numstat.split('\t');
  if (added === '-' || removed === '-') return { ...EMPTY_DIFF, binary: true };
  const { hunks, truncated } = parseHunks(await run(['diff', ...flags, '--unified=3', ...tail], read));
  return { binary: false, truncated, missing: false, added: Number(added), removed: Number(removed), hunks };
}

export class GitService {
  private last: GitStatus | null = null;
  private readonly listeners = new Set<(status: GitStatus) => void>();
  private running: Promise<unknown> = Promise.resolve();
  private queued: Promise<GitStatus> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: GitServiceOptions) {}

  snapshot(): GitStatus | null {
    return this.last;
  }

  onStatus(listener: (status: GitStatus) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async locate(): Promise<Place | null> {
    try {
      const out = await createRun(this.o.root, this.o.git)(['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'], { readOnly: true });
      const [top, prefix, gitDir] = out.split('\n');
      return { top: top!, prefix: prefix!, gitDir: gitDir! };
    } catch (error) {
      if (error instanceof GitError && /not a git repository/i.test(error.message)) return null;
      throw error;
    }
  }

  private async need(): Promise<{ run: GitRun; place: Place }> {
    const place = await this.locate();
    if (!place) throw new GitError('This folder is not a git repository.');
    return { run: createRun(place.top, this.o.git), place };
  }

  private async checkName(run: GitRun, name: string): Promise<void> {
    try {
      await run(['check-ref-format', '--branch', name], { readOnly: true });
    } catch {
      throw new GitError(`"${name}" is not a valid branch name.`);
    }
  }

  async status(): Promise<GitStatus> {
    const busy = this.o.agentBusy();
    try {
      const place = await this.locate();
      if (!place) return { ...NO_REPO, busy };
      const out = await createRun(place.top, this.o.git)(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { readOnly: true });
      return { repo: true, ...parseStatus(out), operation: operationOf(place.gitDir), busy, problem: null };
    } catch (error) {
      return { ...NO_REPO, busy, problem: describe(error) };
    }
  }

  // A computation that has not started yet sees the newest state, so callers that arrive meanwhile share it; one that is running is followed by another.
  refresh(): Promise<GitStatus> {
    if (this.queued) return this.queued;
    const next = this.running.then(() => {
      this.queued = null;
      return this.compute();
    });
    this.queued = next;
    this.running = next.catch(() => undefined);
    return next;
  }

  private async compute(): Promise<GitStatus> {
    const status = await this.status();
    if (!this.closed && JSON.stringify(status) !== JSON.stringify(this.last)) {
      this.last = status;
      for (const listener of this.listeners) {
        try {
          listener(status);
        } catch (error) {
          console.error('git: a status listener failed', error);
        }
      }
    }
    return status;
  }

  async branches(): Promise<GitBranch[]> {
    const { run } = await this.need();
    const out = await run(['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)\t%(refname:short)\t%(upstream:short)\t%(objectname:short)', 'refs/heads'], { readOnly: true });
    return out.split('\n').filter(Boolean).map((line) => {
      const [head, name, upstream, sha] = line.split('\t');
      return { name: name!, current: head === '*', upstream: upstream || null, sha: sha! };
    });
  }

  async diff(path: string, side: GitSide): Promise<FileDiff> {
    checkPaths([path]);
    const status = await this.refresh();
    const { run } = await this.need();
    const file = status.files.find((f) => f.path === path);
    if (side === 'unstaged' && file?.worktree === 'untracked') return diffOf(run, ['--no-index', '--', '/dev/null', path]);
    if (side === 'unstaged') return diffOf(run, ['--', path]);
    return diffOf(run, ['--cached', '-M', '--', ...(file?.origPath ? [path, file.origPath] : [path])]);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async hasHead(run: GitRun): Promise<boolean> {
    return (await run(['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1], readOnly: true })).trim() !== '';
  }

  async init(): Promise<void> {
    await this.serial(async () => {
      await createRun(this.o.root, this.o.git)(['init', '-q']);
    });
  }

  async stage(paths: string[] | 'all'): Promise<void> {
    if (paths !== 'all') checkPaths(paths);
    await this.serial(async () => {
      const { run } = await this.need();
      if (paths === 'all') await run(['add', '-A']);
      else for (const batch of chunks(paths)) await run(['add', '-A', '--', ...batch]);
    });
  }

  async unstage(paths: string[] | 'all'): Promise<void> {
    if (paths !== 'all') checkPaths(paths);
    await this.serial(async () => {
      const { run } = await this.need();
      if (await this.hasHead(run)) {
        if (paths === 'all') await run(['reset', '-q']);
        else for (const batch of chunks(paths)) await run(['reset', '-q', '--', ...batch]);
        return;
      }
      // With no commit there is nothing to reset to: unstaging is dropping the paths from the index.
      const targets = paths === 'all' ? (await run(['ls-files', '-z'], { readOnly: true })).split('\0').filter(Boolean) : paths;
      for (const batch of chunks(targets)) await run(['rm', '--cached', '-r', '-q', '--', ...batch]);
    });
  }

  async commit(message: string): Promise<void> {
    if (message.trim() === '') throw new GitError('The commit message is empty.');
    await this.serial(async () => {
      const { run } = await this.need();
      if ((await run(['diff', '--cached', '--name-only', '-z'], { readOnly: true })) === '') throw new GitError('Nothing is staged.');
      await run(['commit', '-q', '-F', '-'], { input: message, timeoutMs: COMMIT_TIMEOUT_MS });
    });
  }

  async branchDelete(name: string): Promise<void> {
    await this.serial(async () => {
      const { run } = await this.need();
      await this.checkName(run, name);
      await run(['branch', '-d', '--', name]);
    });
  }
}
