import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type AddressInfo } from 'node:net';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { coreEnv, nodeExecutable } from '../node-exec';
import { descendants, forceKill, isAlive, signal } from '../os-process';
import { projectBusy } from '../project/switch';
import type { CoreChild, CoreExit, SupervisorDeps } from './supervisor';

const HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1000;
const STDERR_DRAIN_MS = 500;

export interface ChildCoreFlags {
  claude: string;
  noMapMcp: boolean;
  noAgentSearch: boolean;
  allowedOrigins: string[];
}

export interface ChildCoreTarget {
  root: string;
  port: number;
  home: string;
  hubPort: number;
}

export function childCoreArgs({ root, port, home, hubPort }: ChildCoreTarget, flags: ChildCoreFlags): string[] {
  // The UI the hub serves connects to every project core straight from the hub's own origin.
  const origins = [...new Set([...flags.allowedOrigins, `http://127.0.0.1:${hubPort}`, `http://localhost:${hubPort}`])];
  return [
    '--project', root,
    '--port', String(port),
    '--token-stdin',
    '--exit-with-parent',
    '--ide-home', home,
    '--claude', flags.claude,
    ...(flags.noMapMcp ? ['--no-map-mcp'] : []),
    ...(flags.noAgentSearch ? ['--no-agent-search'] : []),
    ...origins.flatMap((origin) => ['--allow-origin', origin]),
  ];
}

export function spawnCore(args: string[], token: string, label: string): CoreChild {
  // Detached: a Ctrl+C in the hub's terminal reaches only the hub, which then stops each core in order.
  const child = spawn(nodeExecutable(), [...process.execArgv, process.argv[1] ?? '', ...args], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: coreEnv() });
  const stderrListeners: ((text: string) => void)[] = [];
  const exitListeners: ((exit: CoreExit) => void)[] = [];
  let result: CoreExit | undefined;
  let tree: number[] = [];

  const finish = (exit: CoreExit): void => {
    if (result) return;
    result = exit;
    // Whatever the core started and did not stop itself on the way out would be orphaned.
    for (const pid of tree) if (isAlive(pid)) signal(pid, 'SIGKILL');
    for (const listener of exitListeners) listener(exit);
  };
  // The last stderr lines (the reason a core gave up) can arrive after 'exit'; a grandchild holding the pipe must not delay the report.
  child.on('exit', (code, name) => {
    const report = (): void => finish({ code, signal: name });
    if (child.stderr.readableEnded) {
      report();
      return;
    }
    child.stderr.once('end', report);
    setTimeout(report, STDERR_DRAIN_MS);
  });
  child.on('error', (error) => {
    if (child.pid === undefined) finish({ error });
    else console.error(`hub: ${label}: ${error.message}`);
  });
  // The pipe stays open on purpose: its end is how the core learns the hub is gone.
  child.stdin.on('error', () => {});
  child.stdin.write(`${token}\n`);
  forwardLines(child.stdout, process.stdout, label);
  forwardLines(child.stderr, process.stderr, label, (text) => {
    for (const listener of stderrListeners) listener(text);
  });

  return {
    onStderr: (listener) => stderrListeners.push(listener),
    onExit: (listener) => {
      if (result) listener(result);
      else exitListeners.push(listener);
    },
    kill: (name) => {
      const pid = child.pid;
      if (result || pid === undefined) return;
      if (name === 'SIGKILL') {
        forceKill(pid);
        return;
      }
      tree = [...new Set([...tree, ...descendants(pid)])];
      signal(pid, name);
    },
  };
}

function forwardLines(from: Readable, to: NodeJS.WriteStream, label: string, onText?: (text: string) => void): void {
  let partial = '';
  from.setEncoding('utf8');
  from.on('data', (text: string) => {
    onText?.(text);
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) to.write(`[${label}] ${line}\n`);
  });
  from.on('end', () => {
    if (partial) to.write(`[${label}] ${partial}\n`);
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function listens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: HOST });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function coreProcessDeps(home: string, hubPort: () => number, flags: ChildCoreFlags): SupervisorDeps {
  return {
    spawn: ({ root, port, token }) => spawnCore(childCoreArgs({ root, port, home, hubPort: hubPort() }, flags), token, basename(root)),
    freePort,
    listens,
    busy: (root) => {
      try {
        return projectBusy(home, root);
      } catch (error) {
        return `Could not check whether another IDE core has that project open: ${(error as Error).message}`;
      }
    },
    newToken: () => randomBytes(24).toString('base64url'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
