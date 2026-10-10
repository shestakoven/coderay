import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { reapOrphans, recordClaude } from '../../src/agent/reaper';
import { commandLine, isAlive, signal } from '../../src/os-process';
import { FAKE_CLAUDE, readRecords, writePidRecord } from '../fake-claude/fake';
import { fixture, tempDir, waitFor } from '../helpers';

const CRASHING_HOST = fileURLToPath(new URL('../fake-claude/crashing-host.ts', import.meta.url));

function sleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  child.unref();
  onTestFinished(() => signal(child.pid ?? -1, 'SIGKILL'));
  return child.pid ?? -1;
}

async function stubbornSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  onTestFinished(() => signal(child.pid ?? -1, 'SIGKILL'));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return child.pid ?? -1;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid ?? -1;
}

describe('recordClaude', () => {
  it("names the core by its own command line, and writes nothing when the owner's cannot be read", async () => {
    const dir = tempDir('ide-run-');
    const pid = sleeper();
    expect(recordClaude(dir, pid, await deadPid())).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const file = recordClaude(dir, pid) ?? '';
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid, owner: process.pid, ownerCommand: commandLine(process.pid)?.trim() });
  });
});

describe('reapOrphans', () => {
  it('stops a claude whose core was killed mid-tool, and the tool, when the next core starts', async () => {
    const dir = tempDir('ide-run-');
    const records = join(tempDir('ide-fake-'), 'record.jsonl');
    const host = spawn(process.execPath, ['--import', 'tsx', CRASHING_HOST, FAKE_CLAUDE, fixture('stream/orphan-mid-tool.jsonl'), records, tempDir('ide-cwd-'), dir], { stdio: 'ignore' });
    const claude = await waitFor(() => readRecords(records).find((r) => r.argv)?.pid, 'claude started');
    const tool = await waitFor(() => readRecords(records).find((r) => r.sleeperPid)?.sleeperPid, 'tool started');
    onTestFinished(() => {
      signal(claude, 'SIGKILL');
      signal(tool, 'SIGKILL');
    });
    await waitFor(() => readdirSync(dir).some((name) => name.endsWith('.pid.json')), 'pid file written');
    host.kill('SIGKILL');
    await new Promise((resolve) => host.once('exit', resolve));
    expect([isAlive(claude), isAlive(tool)]).toEqual([true, true]);

    expect(await reapOrphans(dir, 200)).toEqual([claude]);
    await waitFor(() => !isAlive(claude) && !isAlive(tool), 'claude and its tool stopped');
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves a claude whose core is alive, this core's or another project's", async () => {
    const dir = tempDir('ide-run-');
    const pid = sleeper();
    recordClaude(dir, pid);
    expect(await reapOrphans(dir, 200)).toEqual([]);
    expect([isAlive(pid), readdirSync(dir).length]).toEqual([true, 1]);
  });

  it('takes a core whose pid now runs another program for dead', async () => {
    const dir = tempDir('ide-run-');
    const pid = sleeper();
    writePidRecord(dir, pid, sleeper(), 'node /gone/core/main.ts --project /gone');
    expect(await reapOrphans(dir, 200)).toEqual([pid]);
    await waitFor(() => !isAlive(pid), 'orphan stopped');
  });

  it('never signals a process whose command line is not the recorded one, and forgets its file', async () => {
    const dir = tempDir('ide-run-');
    const pid = sleeper();
    mkdirSync(join(dir, 'claude-7.pid.json'));
    const file = writePidRecord(dir, pid, await deadPid(), 'node /gone/core/main.ts', 'claude --session-id=gone');
    expect(await reapOrphans(dir, 200)).toEqual([]);
    expect([isAlive(pid), existsSync(file)]).toEqual([true, false]);
  });

  it('never signals the core itself, nor a claude that holds it, and keeps that claude recorded', async () => {
    const dir = tempDir('ide-run-');
    const owner = await deadPid();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    onTestFinished(() => kill.mockRestore());
    const own = writePidRecord(dir, process.pid, owner, 'node /gone/core/main.ts');
    const holding = writePidRecord(dir, process.ppid, owner, 'node /gone/core/main.ts');
    expect(await reapOrphans(dir, 100)).toEqual([]);
    expect([kill.mock.calls.filter(([, name]) => name !== 0), existsSync(own), existsSync(holding)]).toEqual([[], false, true]);
  });

  it('gives all orphans the grace time together, not one after another', async () => {
    const dir = tempDir('ide-run-');
    const orphans = [await stubbornSleeper(), await stubbornSleeper()];
    for (const pid of orphans) writePidRecord(dir, pid, await deadPid(), 'node /gone/core/main.ts');
    const started = Date.now();
    const reaping = reapOrphans(dir, 500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readdirSync(dir)).toHaveLength(2);
    expect((await reaping).sort()).toEqual([...orphans].sort());
    expect(Date.now() - started).toBeLessThan(900);
    expect(readdirSync(dir)).toEqual([]);
    await waitFor(() => orphans.every((pid) => !isAlive(pid)), 'orphans stopped');
  });
});
