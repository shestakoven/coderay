import { spawn } from 'node:child_process';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { forceKill, isAlive, reaches, signal, signalGroup } from '../src/os-process';

describe('process control', () => {
  it('never signals a pid that is not a whole number above 1', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    onTestFinished(() => kill.mockRestore());
    const invalid = [-1, 0, 1, 1.5, Number.NaN];

    for (const pid of invalid) {
      signal(pid, 'SIGKILL');
      signalGroup(pid, 'SIGKILL');
      forceKill(pid);
    }

    expect(invalid.map(isAlive)).toEqual([false, false, false, false, false]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('sees its own process as alive', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('knows whether a signal to the tree or the group of a process reaches another, and assumes it does when the process table is unreadable', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const leader = spawn('sh', ['-c', 'sleep 300 </dev/null >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const left = new Promise((resolve) => leader.once('exit', resolve));
    const member = Number(await new Promise<string>((resolve) => leader.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))));
    onTestFinished(() => {
      signal(unrelated.pid ?? -1, 'SIGKILL');
      signal(member, 'SIGKILL');
    });
    await left;

    expect(reaches(process.ppid, process.pid)).toBe(true);
    expect(reaches(unrelated.pid ?? -1, process.pid)).toBe(false);
    expect(reaches(leader.pid ?? -1, member)).toBe(true);
    vi.stubEnv('PATH', '');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    expect(reaches(unrelated.pid ?? -1, process.pid)).toBe(true);
  });
});
