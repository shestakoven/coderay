import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const FAKE_CLAUDE = join(REPO, 'packages/core/test/fake-claude/fake-claude.mjs');
const FAKE_CODEX = join(REPO, 'packages/core/test/fake-codex/fake-codex.mjs');
const FAKE_OPENCODE = join(REPO, 'packages/core/test/fake-opencode/fake-opencode.mjs');
export const MODELS_CACHE = join(REPO, 'node_modules/.cache/ide-e2e/models');
const stream = (scenario: string): string => join(REPO, `packages/core/test/fixtures/stream/${scenario}.jsonl`);

export interface Core {
  url: string;
  file(rel: string): string;
  root: string;
  // Where claude keeps the transcripts of the project's conversations, as the core looks for them.
  transcripts: string;
  record: string;
  stop(): Promise<void>;
}

export interface Hub {
  url: string;
  // The absolute path of a scratch project, by folder name.
  root(name: string): string;
  // A new scratch project the hub has not opened.
  addProject(name: string): string;
  // Processes whose command line names the project: its project core, once the hub runs one.
  coresOf(root: string): number[];
  stop(): Promise<void>;
}

export interface Launcher {
  url: string;
  home: string;
  userHome: string;
  stop(): Promise<void>;
}

const userHomeOf = (base: string): string => join(base, 'user-home');

// Every core's XDG homes are the scratch dir's: an opencode it starts never reads or writes the user's.
const xdgHomes = (base: string): Record<string, string> =>
  Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map((name) => [name, join(base, 'xdg', name.toLowerCase())]));

// Unless a spec shows the first-run screen, the background AI is Off and answered, so no fake engine gets a background call.
function prepareHome(base: string, { onboarded = true }: { onboarded?: boolean } = {}): { home: string; bin: string } {
  const home = join(base, 'home');
  mkdirSync(MODELS_CACHE, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (onboarded) writeFileSync(join(home, 'background-ai.json'), '{"choice":{"mode":"off"},"onboarded":true}\n');
  symlinkSync(MODELS_CACHE, join(home, 'models'));
  // A claude that always fails, first in PATH, so a map change can never call the real Haiku.
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { home, bin };
}

async function spawnCore(base: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string; exited: Promise<void> }> {
  // The folder browser and the start screen start from the user's home: a failing test must never write into the real one.
  const userHome = userHomeOf(base);
  mkdirSync(userHome, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'packages/core/src/main.ts'), ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: userHome, IDE_DEFAULT_MODEL: 'sonnet', ...xdgHomes(base), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = '';
    let settled = false;
    const fail = async (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // The core still writes to its home while it shuts down.
      await exited;
      rmSync(base, { recursive: true, force: true });
      reject(new Error(`${reason}:\n${output}`));
    };
    const timer = setTimeout(() => void fail('the core printed no address'), 60_000);
    const read = (chunk: Buffer) => {
      output += String(chunk);
      const match = /open: (http:\/\/\S+)/.exec(output);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolveUrl(match[1]!);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    void exited.then(() => fail('the core exited'));
  });
  return { child, url, exited };
}

const listeners = (port: string): string[] => {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const commandOf = (pid: string): string => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
  } catch {
    return '';
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

async function untilGone(pids: number[], attempts: number): Promise<number[]> {
  let left = pids.filter(alive);
  for (let attempt = 0; attempt < attempts && left.length > 0; attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
    left = left.filter(alive);
  }
  return left;
}

// A project switch or close leaves a detached successor on the port; it still writes to its home while it exits.
async function stopSuccessor(url: string, base: string): Promise<void> {
  const pids = listeners(new URL(url).port).filter((pid) => commandOf(pid).includes(base)).map(Number);
  for (const pid of pids) signal(pid, 'SIGTERM');
  const stuck = await untilGone(pids, 100);
  for (const pid of stuck) signal(pid, 'SIGKILL');
  const left = await untilGone(stuck, 30);
  if (left.length > 0) throw new Error(`the core successor did not exit: ${left.join(', ')}`);
}

const processesMatching = (text: string, except: number[] = []): number[] => {
  try {
    return execFileSync('pgrep', ['-f', text], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((pid) => !except.includes(pid));
  } catch {
    return [];
  }
};

function scratchProject(base: string, name: string): string {
  const root = join(base, name);
  cpSync(join(REPO, 'e2e/fixtures/tiny'), root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

export async function startHub(names: string[]): Promise<Hub> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ide-e2e-')));
  const roots = names.map((name) => scratchProject(base, name));
  const { home, bin } = prepareHome(base);
  const hub = await spawnCore(
    base,
    ['--hub', ...roots.flatMap((root) => ['--project', root]), '--ide-home', home, '--port', '0', '--ui', join(REPO, 'packages/ui/dist'), '--claude', FAKE_CLAUDE, '--no-codex', '--no-opencode'],
    { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: stream('text-then-wait') },
  );
  const hubPid = hub.child.pid ?? -1;
  return {
    url: hub.url,
    root: (name) => join(base, name),
    addProject: (name) => scratchProject(base, name),
    coresOf: (root) => processesMatching(root, [hubPid]),
    stop: async () => {
      hub.child.kill('SIGTERM');
      await hub.exited;
      // The hub stops its project cores before it exits: any process left in the scratch dir is an orphan.
      const orphans = await untilGone(processesMatching(base), 100);
      const commands = orphans.map((pid) => commandOf(String(pid)).trim());
      for (const pid of orphans) signal(pid, 'SIGKILL');
      await untilGone(orphans, 30);
      rmSync(base, { recursive: true, force: true });
      if (orphans.length > 0) throw new Error(`project cores outlived the hub: ${commands.join('; ')}`);
    },
  };
}

// `codex` and `opencode` name a scenario of their fake; null runs the core without that engine.
export async function startCore(scenario: string, env: NodeJS.ProcessEnv = {}, fixture = 'tiny', codex: string | null = null, opencode: string | null = null): Promise<Core> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ide-e2e-')));
  const root = join(base, 'project');
  cpSync(join(REPO, 'e2e/fixtures', fixture), root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { home, bin } = prepareHome(base);
  const record = join(base, 'fake-claude-record.jsonl');
  const core = await spawnCore(
    base,
    [
      '--project', root, '--ide-home', home, '--port', '0', '--ui', join(REPO, 'packages/ui/dist'), '--claude', FAKE_CLAUDE,
      ...(codex === null ? ['--no-codex'] : ['--codex', FAKE_CODEX]), ...(opencode === null ? ['--no-opencode'] : ['--opencode', FAKE_OPENCODE]),
    ],
    {
      PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_SCENARIO: stream(scenario),
      ...(codex === null ? {} : { FAKE_CODEX_SCENARIO: join(REPO, 'packages/core/test/fixtures/codex', `${codex}.jsonl`), FAKE_CODEX_RECORD: join(base, 'fake-codex-record.jsonl') }),
      ...(opencode === null ? {} : { FAKE_OPENCODE_SCENARIO: join(REPO, 'packages/core/test/fixtures/opencode', `${opencode}.jsonl`), FAKE_OPENCODE_RECORD: join(base, 'fake-opencode-record.jsonl') }),
      ...env,
    },
  );
  return {
    url: core.url,
    record,
    root,
    transcripts: join(userHomeOf(base), '.claude/projects', root.replace(/[^A-Za-z0-9]/g, '-')),
    file: (rel) => readFileSync(join(root, rel), 'utf8'),
    stop: async () => {
      core.child.kill('SIGTERM');
      await core.exited;
      await stopSuccessor(core.url, base);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export async function startLauncher(): Promise<Launcher> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ide-e2e-')));
  const { home, bin } = prepareHome(base);
  const core = await spawnCore(
    base,
    ['--ide-home', home, '--port', '0', '--ui', join(REPO, 'packages/ui/dist'), '--claude', FAKE_CLAUDE, '--no-codex', '--no-opencode'],
    { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: stream('text-then-wait') },
  );
  return {
    url: core.url,
    home,
    userHome: userHomeOf(base),
    stop: async () => {
      core.child.kill('SIGTERM');
      await core.exited;
      await stopSuccessor(core.url, base);
      rmSync(base, { recursive: true, force: true });
    },
  };
}
