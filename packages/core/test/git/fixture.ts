import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, onTestFinished } from 'vitest';
import { GitService, type GitServiceOptions } from '../../src/git/git-service';
import { IdeWrites } from '../../src/history/ide-writes';
import { tempDir } from '../helpers';

const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

// Call at the top of a test file: git then reads none of the config of the machine the tests run on.
export function isolateGit(): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(ISOLATION)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const key of Object.keys(ISOLATION)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

export const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

export const hashOf = (cwd: string, rel: string): string => sh(cwd, 'hash-object', rel).trim();

export async function put(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}

export async function makeRepo(files: Record<string, string> = {}, commit = true): Promise<string> {
  const root = tempDir('git-');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.name', 'Test');
  sh(root, 'config', 'user.email', 'test@example.com');
  await put(root, files);
  if (commit && Object.keys(files).length > 0) {
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'init');
  }
  return root;
}

export function service(root: string, over: Partial<GitServiceOptions> = {}) {
  const busy: { reason: string | null } = { reason: null };
  const ideWrites = new IdeWrites();
  const git = new GitService({ root, ideWrites, agentBusy: () => busy.reason, ...over });
  onTestFinished(() => git.close());
  return { git, busy, ideWrites };
}
