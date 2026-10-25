import { spawnClaude, type ProcessExit } from '../claude-process';
import { codexEnv, type CodexCommand } from './command';
import type { InitializeResponse } from './protocol';
import { JsonRpc, type Incoming, type IncomingRequest } from './rpc';

/** On every app-server CodeRay starts: the user's hooks and notify program never run inside CodeRay. */
export const APP_SERVER_FLAGS = ['-c', 'features.hooks=false', '-c', 'notify=[]'];

const CLIENT_INFO = { name: 'coderay', title: 'CodeRay', version: '1.0.0' };
const PROBE_TIMEOUT_MS = 20_000;
const NOT_HANDLED = -32601;

export interface AppServer {
  readonly pid: number | undefined;
  readonly rpc: JsonRpc;
  readonly exited: Promise<ProcessExit>;
  kill(): Promise<ProcessExit>;
}

export interface AppServerOptions {
  cwd: string;
  env?: Record<string, string>;
  pidDir?: string;
  killGraceMs?: number;
  onNotification?: (message: Incoming) => void;
  onRequest?: (message: IncomingRequest) => void;
}

// The pinned binary, never `app-server proxy`: a machine-wide daemon of another version may answer that.
export function startAppServer(command: CodexCommand, options: AppServerOptions): AppServer {
  const spawned = spawnClaude(
    command.command, [...command.args, 'app-server', ...(command.flags ?? []), ...APP_SERVER_FLAGS], options.cwd, codexEnv(command, options.env),
    { killGraceMs: options.killGraceMs, pidDir: options.pidDir, pidName: 'codex' },
  );
  const rpc: JsonRpc = new JsonRpc(spawned.child.stdout, spawned.child.stdin, {
    notification: (message) => options.onNotification?.(message),
    request: (message) => (options.onRequest ? options.onRequest(message) : rpc.fail(message.id, NOT_HANDLED, `CodeRay does not handle ${message.method}.`)),
  });
  // Its stdout closes before the exit is reported: the requests still waiting get the exit's reason and stderr, not a closed pipe.
  void spawned.exited.then((exit) => {
    const last = exit.stderr.trim().split('\n').at(-1);
    rpc.end(new Error(`codex app-server exited (${exit.error ?? exit.signal ?? `code ${exit.code}`})${last ? `: ${last}` : ''}`));
  });
  return { pid: spawned.child.pid, rpc, exited: spawned.exited, kill: () => spawned.kill() };
}

export async function handshake(rpc: JsonRpc): Promise<InitializeResponse> {
  const answer = await rpc.request<InitializeResponse>('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
  rpc.notify('initialized');
  return answer;
}

/** A short-lived app-server for one question (status, models, sign-out), stopped afterwards whatever happens. */
export async function withAppServer<T>(command: CodexCommand, cwd: string, ask: (rpc: JsonRpc, hello: InitializeResponse) => Promise<T>, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const server = startAppServer(command, { cwd });
  const timer = setTimeout(() => {
    server.rpc.end(new Error(`codex app-server did not answer in ${timeoutMs / 1000} s.`));
    void server.kill();
  }, timeoutMs);
  try {
    return await ask(server.rpc, await handshake(server.rpc));
  } finally {
    clearTimeout(timer);
    await server.kill();
  }
}
