import { execFileSync } from 'node:child_process';

// kill(-1) signals every process of the user and kill(0) the core's own group; pid 1 is init.
const isProcessId = (pid: number): boolean => Number.isInteger(pid) && pid > 1;

export function isAlive(pid: number): boolean {
  if (!isProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function signal(pid: number, name: NodeJS.Signals): void {
  if (!isProcessId(pid)) return;
  try {
    process.kill(pid, name);
  } catch {
    // ESRCH: the process has already exited.
  }
}

export function descendants(pid: number): number[] {
  if (!isProcessId(pid)) return [];
  let table = '';
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || Number.isNaN(child) || Number.isNaN(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [...(children.get(pid) ?? [])];
  for (let index = 0; index < found.length; index += 1) found.push(...(children.get(found[index] ?? -1) ?? []));
  return found;
}

// A child whose parent already exited has been re-parented and is not found here; claude's own SIGTERM handler is what stops its tools.
export function forceKill(pid: number): void {
  const tree = descendants(pid);
  signal(pid, 'SIGKILL');
  for (const child of tree) signal(child, 'SIGKILL');
}

export function commandLine(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// A detached process leads its own group, which outlives it while any member runs, so the group id cannot be reused meanwhile.
export function signalGroup(pgid: number, name: NodeJS.Signals): void {
  if (!isProcessId(pgid)) return;
  try {
    process.kill(-pgid, name);
  } catch {
    // ESRCH: no process of the group is left.
  }
}
