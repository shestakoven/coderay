import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const FAKE_CLAUDE = join(REPO, 'packages/core/test/fake-claude/fake-claude.mjs');
const MODELS_CACHE = join(REPO, 'node_modules/.cache/ide-e2e/models');

export interface Core {
  url: string;
  file(rel: string): string;
  stop(): Promise<void>;
}

export async function startCore(scenario: string): Promise<Core> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ide-e2e-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  cpSync(join(REPO, 'e2e/fixtures/tiny'), root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(MODELS_CACHE, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(MODELS_CACHE, join(home, 'models'));
  // A claude that always fails, first in PATH, so a map change can never call the real Haiku.
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(REPO, 'packages/core/src/main.ts'), '--project', root, '--ide-home', home, '--port', '0', '--ui', join(REPO, 'packages/ui/dist'), '--claude', FAKE_CLAUDE],
    {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: join(REPO, `packages/core/test/fixtures/stream/${scenario}.jsonl`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`the core printed no address:\n${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += String(chunk);
      const match = /open: (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]!);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    void exited.then(() => reject(new Error(`the core exited:\n${output}`)));
  });
  return {
    url,
    file: (rel) => readFileSync(join(root, rel), 'utf8'),
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
      rmSync(base, { recursive: true, force: true });
    },
  };
}
