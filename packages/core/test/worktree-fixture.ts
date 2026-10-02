import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { tempDir, writeTree } from './helpers';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

// For git commands that are expected to fail (a merge that conflicts).
export function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // The caller looks at the state git left behind.
  }
}

export const COMMITTED = {
  '.gitignore': '.worktrees/\ndist/\n',
  'backend/src/a.py': 'a = 1\n',
  'backend/src/other.py': 'other = 1\n',
  'README.md': 'readme\n',
};

export interface WorktreeProject {
  root: string;
  wt: string;
}

// A project whose .gitignore hides ".worktrees/", with one linked worktree of its own commit in it ("wt1" unless named).
// `configure` runs on the new repository before its files are committed (git config, submodules).
export async function projectWithWorktree(files: Record<string, string> = {}, dir = '.worktrees/wt1', configure?: (root: string) => void): Promise<WorktreeProject> {
  const root = tempDir('wt-root-');
  git(root, 'init', '-q');
  configure?.(root);
  await writeTree(root, { ...COMMITTED, ...files });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'worktree', 'add', '-q', dir);
  return { root, wt: join(root, dir) };
}

export interface MonorepoProject extends WorktreeProject {
  repo: string;
}

// A project that is the directory "packages/app" of a larger repository; its worktree "wt1" is a checkout of the whole repository.
export async function monorepoWithWorktree(): Promise<MonorepoProject> {
  const repo = tempDir('wt-mono-');
  git(repo, 'init', '-q');
  await writeTree(repo, {
    '.gitignore': '.worktrees/\ndist/\n',
    'packages/app/src/a.py': 'a = 1\n',
    'packages/app/src/other.py': 'other = 1\n',
    'packages/other/x.py': 'x = 1\n',
    'README.md': 'readme\n',
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', 'packages/app/.worktrees/wt1');
  return { repo, root: join(repo, 'packages/app'), wt: join(repo, 'packages/app/.worktrees/wt1') };
}

// A repository with one commit, to be added to a project as a submodule.
export async function submoduleSource(): Promise<string> {
  const lib = tempDir('wt-lib-');
  git(lib, 'init', '-q');
  await writeTree(lib, { 'lib.py': 'lib\n' });
  git(lib, 'add', '-A');
  git(lib, 'commit', '-q', '-m', 'lib');
  return lib;
}

export const addSubmodule = (cwd: string, source: string, path: string): string =>
  git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, path);

// What "git worktree repair" does to a worktree: its .git file is written anew, with the same content.
export function rewriteDotGit(wt: string): void {
  const dotgit = join(wt, '.git');
  writeFileSync(`${dotgit}.new`, readFileSync(dotgit));
  renameSync(`${dotgit}.new`, dotgit);
}

// The tests build their own repositories, so the developer's global git settings (excludes, hooks, identity) must not reach them.
export function isolateGit(): void {
  const saved: Record<string, string | undefined> = {};
  const isolation = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  beforeAll(() => { for (const [k, v] of Object.entries(isolation)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterAll(() => { for (const k of Object.keys(isolation)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}
