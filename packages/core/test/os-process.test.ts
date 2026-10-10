import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { forceKill, isAlive, signal, signalGroup } from '../src/os-process';

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
});
