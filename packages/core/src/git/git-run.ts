import { spawn } from 'node:child_process';
import { GIT_NOT_FOUND } from '../project/git';

const READ_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const INHERITED = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|SHALLOW_FILE|GRAFT_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS)$/;

export class GitError extends Error {
  constructor(message: string, readonly code: number | null = null) {
    super(message);
  }
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  // A read must not take the index lock, so it never fights a git command the user runs at the same time.
  readOnly?: boolean;
  // Exit codes besides 0 that are an answer, not a failure (`diff --no-index` exits 1 on a difference).
  okCodes?: number[];
}

export type GitRun = (args: string[], options?: RunOptions) => Promise<string>;

function environment(readOnly: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!INHERITED.test(key)) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_MESSAGES: 'C', ...(readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}) };
}

export function createRun(cwd: string, bin = 'git'): GitRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, ['--literal-pathspecs', ...args], { cwd, env: environment(options.readOnly === true), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let tooBig = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? READ_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        tooBig = true;
        child.kill('SIGKILL');
      } else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new GitError((error as NodeJS.ErrnoException).code === 'ENOENT' ? GIT_NOT_FOUND : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (timedOut) return reject(new GitError(`git ${args[0]} timed out`));
      if (tooBig) return reject(new GitError(`The output of git ${args[0]} is too large.`));
      if (code === 0 || (code !== null && options.okCodes?.includes(code))) return resolve(stdout);
      const message = Buffer.concat(err).toString('utf8').trim() || stdout.trim();
      reject(new GitError(message || `git ${args[0]} failed (${code})`, code));
    });
    child.stdin.end(options.input);
  });
}
