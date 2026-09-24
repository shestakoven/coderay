import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { forceKill, signal } from '../os-process';

export interface ClaudeCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stderr: string;
}

export interface ClaudeProcessOptions {
  killGraceMs?: number;
}

export interface ClaudeProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessExit>;
  write(message: object): void;
  kill(): Promise<ProcessExit>;
}

const STDERR_TAIL_CHARS = 2000;
export const KILL_GRACE_MS = 3000;
const CLOSE_AFTER_EXIT_MS = 1000;

export function startClaude(
  command: ClaudeCommand, args: string[], cwd: string, onLine: (line: string) => void, options: ClaudeProcessOptions = {},
): ClaudeProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...command.env };
  // claude refuses to start inside another Claude Code session, which is where this core runs when an agent launches it.
  delete env.CLAUDECODE;
  // Detached so that Ctrl+C in the core's terminal reaches the core only; the core stops claude itself.
  const child = spawn(command.command, [...command.args, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  let error: string | null = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  // Writes after claude has exited fail with EPIPE; the exit itself is reported through `exited`.
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', onLine);
  child.once('error', (spawnError) => {
    error = spawnError.message;
  });
  // A core that dies without its shutdown path must not leave the unguarded agent running; claude's SIGTERM handler stops its tools.
  const onCoreExit = (): void => {
    if (child.pid !== undefined) signal(child.pid, 'SIGTERM');
  };
  // A failed spawn emits 'error' and 'close' but never 'exit', which would leave the listener behind.
  if (child.pid !== undefined) process.on('exit', onCoreExit);
  const exited = new Promise<ProcessExit>((resolve) => {
    let fallback: NodeJS.Timeout | undefined;
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      clearTimeout(fallback);
      resolve({ code, signal: exitSignal, error, stderr });
    };
    child.once('close', finish);
    child.once('exit', (code, exitSignal) => {
      process.removeListener('exit', onCoreExit);
      // A process that inherited stdout can hold 'close' back; 'exit' alone means claude itself is gone.
      fallback = setTimeout(() => finish(code, exitSignal), CLOSE_AFTER_EXIT_MS);
    });
  });

  return {
    pid: child.pid,
    exited,
    write(message) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    kill() {
      const pid = child.pid;
      if (child.exitCode === null && child.signalCode === null && pid !== undefined) {
        signal(pid, 'SIGTERM');
        const force = setTimeout(() => forceKill(pid), options.killGraceMs ?? KILL_GRACE_MS);
        child.once('exit', () => clearTimeout(force));
      }
      return exited;
    },
  };
}
