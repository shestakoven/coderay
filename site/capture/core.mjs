// Starts a CodeRay core on a fresh copy of the demo project, the way e2e/core.ts does, with a scripted agent.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
const FAKE_CLAUDE = join(REPO, 'packages/core/test/fake-claude/fake-claude.mjs');
const DEMO = join(HERE, 'demo-project');
// The main checkout's e2e cache, when there is one: saves the 34 MB embedding model download.
const MODEL_CACHES = [join(REPO, 'node_modules/.cache/ide-e2e/models'), resolve(REPO, '../../node_modules/.cache/ide-e2e/models')];

export const BASE = '/tmp/coderay-demo';
export const PROJECT = 'acme-signup';

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Acme Dev',
      GIT_AUTHOR_EMAIL: 'dev@acme.dev',
      GIT_COMMITTER_NAME: 'Acme Dev',
      GIT_COMMITTER_EMAIL: 'dev@acme.dev',
      GIT_AUTHOR_DATE: '2026-10-12T10:24:00+02:00',
      GIT_COMMITTER_DATE: '2026-10-12T10:24:00+02:00',
    },
  });

// The overview is a background model's answer; the demo ships it, keyed the way the core keys its cache (map/overview.ts).
function seedOverview(home, root) {
  const seed = JSON.parse(readFileSync(join(HERE, 'overview-answer.json'), 'utf8'));
  const version = Number(/const PROMPT_VERSION = (\d+);/.exec(readFileSync(join(REPO, 'packages/core/src/map/overview.ts'), 'utf8'))[1]);
  const manual = JSON.parse(readFileSync(join(root, '.ide/map.json'), 'utf8')).manual;
  const keyOf = (components) =>
    createHash('sha256').update(JSON.stringify([version, PROJECT, components.map((c) => [c.id, c.name])])).digest('hex').slice(0, 24);
  const before = manual.filter((c) => !seed.createdBy.includes(c.id));
  const entries = Object.fromEntries([before, manual].map((components) => [keyOf(components), { answer: seed.answer, at: '2026-10-12T08:30:00.000Z' }]));
  const dir = join(home, 'projects', createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'overview-cache.json'), JSON.stringify({ version, entries }));
}

function prepare() {
  rmSync(BASE, { recursive: true, force: true });
  const root = join(BASE, PROJECT);
  cpSync(DEMO, root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Sign-up service with welcome email');
  const home = join(BASE, '.coderay');
  mkdirSync(home, { recursive: true });
  const cache = MODEL_CACHES.find((dir) => existsSync(dir));
  if (cache) cpSync(cache, join(home, 'models'), { recursive: true });
  seedOverview(home, root);
  // The background models' claude, first in PATH: it answers change summaries and fails the rest, so nothing reaches the real one.
  const bin = join(BASE, '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fake-model.mjs')}" "$@"\n`, { mode: 0o755 });
  const userHome = join(BASE, '.home');
  mkdirSync(userHome, { recursive: true });
  return { root, home, bin, userHome };
}

export async function startCore(scenario) {
  const { root, home, bin, userHome } = prepare();
  const record = join(BASE, '.fake-claude-record.jsonl');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(REPO, 'packages/core/src/main.ts'), '--project', root, '--ide-home', home, '--port', '0', '--ui', join(REPO, 'packages/ui/dist'), '--claude', FAKE_CLAUDE],
    {
      cwd: REPO,
      env: { ...process.env, HOME: userHome, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_RECORD: record },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const exited = new Promise((done) => child.once('exit', done));
  const url = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the core printed no address:\n${output}`)), 90_000);
    const read = (chunk) => {
      output += String(chunk);
      const match = /open: (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    void exited.then(() => fail(new Error(`the core exited:\n${output}`)));
  });
  return {
    url,
    root,
    record,
    log: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
      // A project switch leaves a detached successor; anything still running from the scratch dir is ours.
      try {
        execFileSync('pkill', ['-f', BASE]);
      } catch {}
      rmSync(BASE, { recursive: true, force: true });
    },
  };
}
