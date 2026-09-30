import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliModel, removeStaleModelDirs } from '../../src/models/claude-cli';
import { tempDir, waitFor } from '../helpers';

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
  grandchild?: boolean;
}

interface FakeCall {
  argv: string[];
  cwd: string;
  stdin: string;
  pid: number;
  grandchild: number | null;
}

const FAKE_CLAUDE = [
  '#!/usr/bin/env node',
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "const dir = fileURLToPath(new URL('.', import.meta.url));",
  "const responses = JSON.parse(readFileSync(dir + 'responses.json', 'utf8'));",
  "let stdin = '';",
  'for await (const chunk of process.stdin) stdin += chunk;',
  "const log = dir + 'calls.jsonl';",
  "const index = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;",
  'const response = responses[Math.min(index, responses.length - 1)];',
  "const grandchild = response.grandchild ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }).pid : null;",
  "appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, pid: process.pid, grandchild }) + '\\n');",
  'if (response.sleepMs) await new Promise((resolve) => setTimeout(resolve, response.sleepMs));',
  "process.stderr.write(response.stderr ?? '');",
  "process.stdout.write(response.stdout ?? '');",
  'process.exitCode = response.exitCode ?? 0;',
].join('\n');

async function fakeClaude(responses: FakeResponse[]) {
  const dir = tempDir('ide-fake-claude-');
  await writeFile(join(dir, 'responses.json'), JSON.stringify(responses));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(path, FAKE_CLAUDE, { mode: 0o755 });
  const calls = async (): Promise<FakeCall[]> => {
    const text = await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  };
  return { path, calls };
}

const success = (structured: unknown): FakeResponse => ({
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(structured),
    structured_output: structured,
  }),
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const newRunDir = () => join(tempDir('ide-home-'), 'run');
const request = { prompt: 'group these files', schema: { type: 'object' } };

describe('ClaudeCliModel', () => {
  it('sends the prompt on stdin to haiku with no tools, no MCP servers, no user customizations and no thinking', async () => {
    const fake = await fakeClaude([success({ ok: true })]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path });

    expect(await model.generate(request)).toEqual({ ok: true });
    const [call] = await fake.calls();
    expect(call?.stdin).toBe('group these files');
    expect(call?.argv).toEqual([
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--safe-mode',
      '--settings',
      '{"language":"english","alwaysThinkingEnabled":false}',
      '--no-session-persistence',
    ]);
  });

  it('runs every call in its own directory under the run directory and removes it afterwards', async () => {
    const runDir = newRunDir();
    const fake = await fakeClaude([success({})]);
    await new ClaudeCliModel({ model: 'haiku', runDir, claudePath: fake.path }).generate(request);

    const [call] = await fake.calls();
    expect(dirname(call!.cwd)).toBe(runDir);
    expect(await readdir(runDir)).toEqual([]);
  });

  it('keeps the run directory private to the user', async () => {
    const runDir = newRunDir();
    await mkdir(runDir, { recursive: true, mode: 0o755 });
    const fake = await fakeClaude([success({})]);
    await new ClaudeCliModel({ model: 'haiku', runDir, claudePath: fake.path }).generate(request);

    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
  });

  it('retries a failed call and returns the next successful answer', async () => {
    const fake = await fakeClaude([{ exitCode: 1, stderr: 'rate limited' }, success({ ok: 2 })]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, retryDelaysMs: [0] });

    expect(await model.generate(request)).toEqual({ ok: 2 });
    expect(await fake.calls()).toHaveLength(2);
  });

  it('gives up after the last retry with the CLI error', async () => {
    const fake = await fakeClaude([{ exitCode: 1, stderr: 'not logged in' }]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, retryDelaysMs: [0, 0] });

    await expect(model.generate(request)).rejects.toThrow('not logged in');
    expect(await fake.calls()).toHaveLength(3);
  });

  it('reports the error that the CLI prints as a JSON result when it exits with an error', async () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' });
    const fake = await fakeClaude([{ exitCode: 1, stdout, stderr: '' }]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, retryDelaysMs: [] });

    await expect(model.generate(request)).rejects.toThrow('claude exited with code 1: Credit balance is too low');
  });

  it('treats an answer without structured output as a failure', async () => {
    const fake = await fakeClaude([{ stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }) }]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, retryDelaysMs: [] });

    await expect(model.generate(request)).rejects.toThrow('no structured output');
  });

  it('kills a call that runs past its timeout', async () => {
    const fake = await fakeClaude([{ ...success({}), sleepMs: 60_000 }]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, timeoutMs: 5000, retryDelaysMs: [] });

    await expect(model.generate(request)).rejects.toThrow('timed out after 5000 ms');
    const call = await waitFor(async () => (await fake.calls())[0], 'the fake claude to have started', 30_000);
    await waitFor(() => !isAlive(call.pid), 'timed-out claude killed', 30_000);
  });

  it('kills the running call and every process it started when it is cancelled', async () => {
    const runDir = newRunDir();
    const fake = await fakeClaude([{ ...success({}), sleepMs: 5000, grandchild: true }]);
    const model = new ClaudeCliModel({ model: 'haiku', runDir, claudePath: fake.path });
    const controller = new AbortController();

    const pending = model.generate(request, { signal: controller.signal });
    const [call] = await waitFor(async () => {
      const calls = await fake.calls();
      return calls.length === 1 && calls;
    }, 'claude started');
    controller.abort();

    await expect(pending).rejects.toThrow('claude call cancelled');
    await waitFor(() => !isAlive(call!.pid) && !isAlive(call!.grandchild!), 'cancelled claude and its child killed');
    expect(await readdir(runDir)).toEqual([]);
  });

  it('starts no retry after it is cancelled while waiting to retry', async () => {
    const fake = await fakeClaude([{ exitCode: 1, stderr: 'overloaded' }]);
    const waits: number[] = [];
    const wait = (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: fake.path, retryDelaysMs: [5000], wait });
    const controller = new AbortController();

    const pending = model.generate(request, { signal: controller.signal });
    await waitFor(() => waits.length === 1, 'waiting to retry');
    controller.abort();

    await expect(pending).rejects.toThrow('claude call cancelled');
    expect([waits, (await fake.calls()).length]).toEqual([[5000], 1]);
  });

  it('reports when the claude executable cannot be started', async () => {
    const missing = join(tempDir('ide-no-claude-'), 'claude');
    const model = new ClaudeCliModel({ model: 'haiku', runDir: newRunDir(), claudePath: missing, retryDelaysMs: [] });

    await expect(model.generate(request)).rejects.toThrow(`cannot run ${missing}`);
  });
});

describe('removeStaleModelDirs', () => {
  it('removes the call directories of processes that are gone and keeps those of live ones', async () => {
    const runDir = newRunDir();
    const live = `model-${process.pid}-abc123`;
    const gone = 'model-999999999-def456';
    await mkdir(join(runDir, live), { recursive: true });
    await mkdir(join(runDir, gone), { recursive: true });
    await mkdir(join(runDir, 'session-1'), { recursive: true });

    await removeStaleModelDirs(runDir);

    expect([existsSync(join(runDir, live)), existsSync(join(runDir, gone)), existsSync(join(runDir, 'session-1'))]).toEqual([
      true,
      false,
      true,
    ]);
  });
});
