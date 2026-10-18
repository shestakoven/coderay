import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord } from '../../json';
import { writeFileNoFollow } from '../../mcp/config';
import { descendants, isAlive, signal } from '../../os-process';
import { spawnClaude, type ProcessExit, type SpawnedClaude } from '../claude-process';
import { isOlderVersion, MIN_OPENCODE_VERSION } from '../tools';
import { ApiError, opencodeClient, type OpencodeClient } from './api';
import { opencodeEnv, type OpencodeCommand } from './command';

/** On every server CodeRay starts: no project config, no plugins, no Claude Code prompt or skills. */
export const HARDENING_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
});

const LISTENING = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
const LISTEN_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const DISPOSE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 20_000;
const GONE_WAIT_MS = 1_000;
const POLL_MS = 20;
// What the server's own environment holds and the model's shell must not see (Q7).
const SECRETS = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PID'];
const PLAIN_PATH = /^[\w./+-]+$/;

/** The shell wrapper of Q7, written 0755 under `<runDir>/opencode-shell/<basename of the user's shell>`; it drops the server's secrets and execs the user's shell. */
export function shellWrapper(runDir: string, userShell = process.env.SHELL || '/bin/zsh'): string {
  // opencode takes only an absolute path to an existing file as its shell.
  const shell = isAbsolute(userShell) ? userShell : '/bin/zsh';
  const dir = join(runDir, 'opencode-shell');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Named as the user's shell: opencode picks the shell's arguments by its name.
  const path = join(dir, basename(shell));
  const quoted = PLAIN_PATH.test(shell) ? shell : `'${shell.replaceAll("'", "'\\''")}'`;
  // Renamed into place: another chat's server may be running a command through the wrapper right now.
  const staged = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileNoFollow(staged, `#!/bin/sh\nexec env ${SECRETS.map((name) => `-u ${name}`).join(' ')} ${quoted} "$@"\n`, 0o755);
  renameSync(staged, path);
  return path;
}

export interface OpencodeServer {
  readonly pid: number | undefined;
  /** Resolves with the base URL once the listening line, health and version check passed; rejects with the reason (stderr's last line) and the process stopped otherwise. */
  readonly ready: Promise<{ base: string; client: OpencodeClient; version: string }>;
  readonly exited: Promise<ProcessExit>;
  kill(): Promise<ProcessExit>;
}

export interface ServerOptions {
  cwd: string;
  env?: Record<string, string>;
  configContent?: string;
  pidDir?: string;
  killGraceMs?: number;
  listenTimeoutMs?: number;
}

// Q6: 1.19 prints the line on stdout; stderr is read too, and its last line explains a server that never got there.
function listening(spawned: SpawnedClaude, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let last = '';
    const tail = (): string => (last === '' ? '' : `: ${last}`);
    const timer = setTimeout(() => reject(new Error(`opencode did not say where it listens within ${timeoutMs / 1000} s${tail()}`)), timeoutMs);
    const read = (line: string): void => {
      const base = LISTENING.exec(line)?.[1];
      if (base === undefined) return;
      clearTimeout(timer);
      resolve(base);
    };
    createInterface({ input: spawned.child.stdout }).on('line', read);
    createInterface({ input: spawned.child.stderr }).on('line', (line) => {
      if (line.trim() !== '') last = line.trim();
      read(line);
    });
    void spawned.exited.then((exit) => {
      clearTimeout(timer);
      reject(new Error(`opencode exited before it said where it listens (${exit.error ?? exit.signal ?? `code ${exit.code}`})${tail()}`));
    });
  });
}

async function checkHealth(client: OpencodeClient): Promise<string> {
  let health: unknown;
  try {
    health = await client.get('/global/health', HEALTH_TIMEOUT_MS);
  } catch (error) {
    throw new Error(error instanceof ApiError ? `opencode's health check failed (${error.status})` : `opencode's health check failed: ${(error as Error).message}`);
  }
  if (!isRecord(health) || health.healthy !== true || typeof health.version !== 'string') throw new Error("opencode's health check did not say it is healthy and which version it is");
  if (isOlderVersion(health.version, MIN_OPENCODE_VERSION)) {
    throw new Error(`opencode ${health.version} is older than ${MIN_OPENCODE_VERSION}, the version CodeRay was verified with: update opencode to run it in CodeRay.`);
  }
  return health.version;
}

/** Spawns `serve --port 0` at once (the pid is known synchronously); every inherited `OPENCODE_*` is removed from its environment first. */
export function startServer(command: OpencodeCommand, options: ServerOptions): OpencodeServer {
  const password = randomBytes(32).toString('hex');
  // Nothing passed in brings its own OPENCODE_* or weakens the hardening.
  const env = opencodeEnv(command, {
    ...Object.fromEntries(Object.entries(options.env ?? {}).filter(([name]) => !name.startsWith('OPENCODE_'))),
    ...HARDENING_ENV,
    OPENCODE_SERVER_PASSWORD: password,
    ...(options.configContent === undefined ? {} : { OPENCODE_CONFIG_CONTENT: options.configContent }),
  });
  const spawned = spawnClaude(command.command, [...command.args, 'serve', '--port', '0', '--hostname', '127.0.0.1'], options.cwd, env, {
    killGraceMs: options.killGraceMs, pidDir: options.pidDir, pidName: 'opencode',
  });
  const running = (): boolean => spawned.child.exitCode === null && spawned.child.signalCode === null;
  const tree = (): number[] => (spawned.child.pid !== undefined && running() ? descendants(spawned.child.pid) : []);
  let client: OpencodeClient | null = null;
  let stopping: Promise<ProcessExit> | null = null;

  // A shell command runs in its own process group: SIGTERM alone orphans it, and a dispose that hangs never stops it.
  async function stop(): Promise<ProcessExit> {
    const left = new Set(tree());
    if (client !== null) await client.post('/global/dispose', undefined, DISPOSE_TIMEOUT_MS).catch(() => undefined);
    for (const pid of tree()) left.add(pid);
    const exit = await spawned.kill();
    for (const pid of left) if (isAlive(pid)) signal(pid, 'SIGKILL');
    const deadline = Date.now() + GONE_WAIT_MS;
    while ([...left].some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    return exit;
  }
  const kill = (): Promise<ProcessExit> => (stopping ??= stop());

  const ready = (async () => {
    try {
      const base = await listening(spawned, options.listenTimeoutMs ?? LISTEN_TIMEOUT_MS);
      const probe = opencodeClient(base, password, options.cwd);
      const version = await checkHealth(probe);
      client = probe;
      return { base, client: probe, version };
    } catch (error) {
      await kill();
      throw error;
    }
  })();
  // A caller that stops the server before it asks must not leave an unhandled rejection behind.
  ready.catch(() => {});
  return { pid: spawned.child.pid, ready, exited: spawned.exited, kill };
}

/** A short-lived server for one question (status, models, providers), stopped afterwards whatever happens. */
export async function withServer<T>(
  command: OpencodeCommand, cwd: string, ask: (client: OpencodeClient, version: string) => Promise<T>, options: Omit<ServerOptions, 'cwd'> = {}, timeoutMs = PROBE_TIMEOUT_MS,
): Promise<T> {
  const server = startServer(command, { ...options, cwd });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`opencode did not answer in ${timeoutMs / 1000} s.`)), timeoutMs);
  });
  try {
    const { client, version } = await Promise.race([server.ready, deadline]);
    return await Promise.race([ask(client, version), deadline]);
  } finally {
    clearTimeout(timer);
    await server.kill();
  }
}
