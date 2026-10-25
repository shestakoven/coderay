import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, parseJson } from '../json';
import type { GenerateOptions, JsonSchema, StructuredModel, StructuredRequest } from './types';

export interface ClaudeCliOptions {
  model: string;
  runDir: string;
  claudePath?: string;
  env?: () => Readonly<Record<string, string>>;
  /** The whole environment, in place of the core's own with `env` over it. */
  baseEnv?: () => NodeJS.ProcessEnv;
  /** Arguments before claude's own, such as the active account's. */
  leadingArgs?: string[];
  timeoutMs?: number;
  retryDelaysMs?: number[];
  wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const NO_MCP_SERVERS = '{"mcpServers":{}}';
export const CLAUDE_SETTINGS = '{"language":"english","alwaysThinkingEnabled":false}';

export const claudeArgs = (model: string, schema: JsonSchema): string[] => [
  '-p',
  '--model',
  model,
  '--output-format',
  'json',
  '--json-schema',
  JSON.stringify(schema),
  '--tools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  NO_MCP_SERVERS,
  '--safe-mode',
  '--settings',
  CLAUDE_SETTINGS,
  '--no-session-persistence',
];

export async function removeStaleModelDirs(runDir: string): Promise<void> {
  const entries = await readdir(runDir).catch(() => []);
  for (const name of entries) {
    const pid = Number(/^model-(\d+)-/.exec(name)?.[1]);
    if (Number.isInteger(pid) && !isAlive(pid)) await rm(join(runDir, name), { recursive: true, force: true });
  }
}

export class ClaudeCliModel implements StructuredModel {
  private readonly model: string;
  private readonly runDir: string;
  private readonly claudePath: string;
  private readonly env: (() => Readonly<Record<string, string>>) | undefined;
  private readonly baseEnv: (() => NodeJS.ProcessEnv) | undefined;
  private readonly leadingArgs: string[];
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown>;

  constructor(options: ClaudeCliOptions) {
    this.model = options.model;
    this.runDir = options.runDir;
    this.claudePath = options.claudePath ?? 'claude';
    this.env = options.env;
    this.baseEnv = options.baseEnv;
    this.leadingArgs = options.leadingArgs ?? [];
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [2000, 8000];
    this.wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  }

  async generate(request: StructuredRequest, { signal }: GenerateOptions = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw cancelled();
      try {
        return await this.runOnce(request, signal);
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) throw error;
        try {
          await this.wait(delay, signal);
        } catch {
          throw cancelled();
        }
      }
    }
  }

  private async runOnce(request: StructuredRequest, signal: AbortSignal | undefined): Promise<unknown> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    await chmod(this.runDir, 0o700);
    const cwd = await mkdtemp(join(this.runDir, `model-${process.pid}-`));
    try {
      return structuredOutput(await this.exec(cwd, request.prompt, claudeArgs(this.model, request.schema), signal));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private exec(cwd: string, prompt: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.claudePath, [...this.leadingArgs, ...args], { cwd, env: this.baseEnv?.() ?? { ...process.env, ...this.env?.() }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      const finish = (error: Error | null, output = ''): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(output);
      };
      const cancel = (): void => {
        killGroup(child);
        finish(cancelled());
      };
      const timer = setTimeout(() => {
        killGroup(child);
        finish(new Error(`claude timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finish(new Error(`cannot run ${this.claudePath}: ${error.message}`)));
      child.on('close', (code) => {
        const output = Buffer.concat(stdout).toString('utf8');
        if (code === 0) finish(null, output);
        else finish(new Error(`claude exited with code ${code}: ${errorDetail(output, stderr)}`));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);
      if (signal?.aborted) cancel();
    });
  }
}

function structuredOutput(stdout: string): unknown {
  const result = parseJson(stdout);
  if (result === undefined) throw new Error('claude printed output that is not JSON');
  if (isRecord(result) && result.subtype === 'success' && result.is_error !== true && result.structured_output !== undefined) {
    return result.structured_output;
  }
  const detail = isRecord(result) ? `${String(result.subtype)}: ${String(result.result ?? '').slice(0, 300)}` : 'unexpected output';
  throw new Error(`claude returned no structured output (${detail})`);
}

function errorDetail(stdout: string, stderr: string): string {
  const result = parseJson(stdout);
  if (isRecord(result) && typeof result.result === 'string' && result.result !== '') return result.result.slice(0, 500);
  return stderr.trim().slice(0, 500);
}

const cancelled = (): Error => Object.assign(new Error('claude call cancelled'), { name: 'AbortError' });

// The child leads its own process group, so one signal also reaches whatever it started.
export function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
