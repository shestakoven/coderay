import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { startClaude } from '../../src/agent/claude-process';
import { isAlive, signal } from '../../src/os-process';
import { FAKE_CLAUDE, fakeClaude, readRecords } from '../fake-claude/fake';
import { fixture, tempDir, waitFor } from '../helpers';

const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
const EXITING_CORE = fileURLToPath(new URL('../fake-claude/exiting-core.ts', import.meta.url));

const userMessage = { type: 'user', message: { role: 'user', content: 'hi' } };
const recordFile = () => join(tempDir('ide-fake-'), 'record.jsonl');

describe('startClaude', () => {
  it('delivers stdout lines and writes messages to stdin as JSON lines', async () => {
    const record = recordFile();
    const lines: string[] = [];
    const claude = startClaude(fakeClaude('multi-turn', record), ['--session-id', 'abc'], tempDir('ide-cwd-'), (line) => lines.push(line));
    onTestFinished(async () => {
      await claude.kill();
    });

    claude.write(userMessage);

    await waitFor(() => lines.some((line) => line.includes('"type":"result"')), 'result line');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ type: 'system', subtype: 'init', session_id: 'abc' });
    expect(readRecords(record).flatMap((r) => (r.stdin ? [r.stdin] : []))).toEqual([userMessage]);
  });

  it('reports the exit code and the tail of stderr', async () => {
    const claude = startClaude(fakeClaude('crash-mid-turn', recordFile()), [], tempDir('ide-cwd-'), () => {});
    claude.write(userMessage);
    expect(await claude.exited).toEqual({ code: 1, signal: null, error: null, stderr: 'fatal: simulated crash\n' });
  });

  it('reports a spawn failure as an exit with an error instead of throwing', async () => {
    const claude = startClaude({ command: '/nonexistent/claude', args: [] }, [], tempDir('ide-cwd-'), () => {});
    expect((await claude.exited).error).toContain('ENOENT');
  });

  it('leaves no exit listener on the core process once claude exits or fails to start', async () => {
    const before = process.listenerCount('exit');
    await startClaude({ command: '/nonexistent/claude', args: [] }, [], tempDir('ide-cwd-'), () => {}).exited;
    const claude = startClaude(fakeClaude('crash-mid-turn', recordFile()), [], tempDir('ide-cwd-'), () => {});
    claude.write(userMessage);
    await claude.exited;
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('stops claude with SIGTERM', async () => {
    const claude = startClaude(fakeClaude('hang', recordFile()), [], tempDir('ide-cwd-'), () => {});
    expect((await claude.kill()).signal).toBe('SIGTERM');
  });

  it('kills claude and the processes it started when claude ignores SIGTERM', async () => {
    const record = recordFile();
    const claude = startClaude(fakeClaude('stubborn', record), [], tempDir('ide-cwd-'), () => {}, { killGraceMs: 200 });
    const sleeper = await waitFor(() => readRecords(record).find((r) => r.sleeperPid)?.sleeperPid, 'sleeper started');

    expect((await claude.kill()).signal).toBe('SIGKILL');
    expect(readRecords(record).some((r) => r.ignoredSignal === 'SIGTERM')).toBe(true);
    await waitFor(() => !isAlive(sleeper), 'sleeper stopped');
  });

  it('sends claude SIGTERM when the core process exits without shutting down', async () => {
    const record = recordFile();
    const core = spawn(TSX, [EXITING_CORE, FAKE_CLAUDE, fixture('stream/keeps-running.jsonl'), record, tempDir('ide-cwd-')], { stdio: 'ignore' });
    await new Promise((resolve) => core.once('exit', resolve));
    const claude = readRecords(record).find((r) => r.pid)?.pid ?? -1;
    expect(claude).toBeGreaterThan(1);
    onTestFinished(() => signal(claude, 'SIGKILL'));

    await waitFor(() => !isAlive(claude), 'claude stopped');
  });

  it("does not pass the core's CLAUDECODE variable to claude", async () => {
    vi.stubEnv('CLAUDECODE', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const record = recordFile();
    const claude = startClaude(fakeClaude('hang', record), [], tempDir('ide-cwd-'), () => {});
    onTestFinished(async () => {
      await claude.kill();
    });

    const [started] = await waitFor(() => readRecords(record).length > 0 && readRecords(record), 'claude started');
    expect(started?.claudecode).toBeNull();
  });
});
