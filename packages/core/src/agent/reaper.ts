import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, parseJson } from '../json';
import { writeFileNoFollow } from '../mcp/config';
import { commandLine, descendants, isAlive, reaches, signal, signalGroup } from '../os-process';

const PID_FILE = /^claude-\d+\.pid\.json$/;
const PRIVATE_FILE_MODE = 0o600;
const POLL_MS = 50;

interface ClaudeRecord {
  pid: number;
  command: string;
  owner: number;
  ownerCommand: string;
}

let coreCommand = '';

// Read once: the core's command line does not change, and a failed read is retried at the next claude.
function ownerCommandLine(owner: number): string {
  if (owner !== process.pid) return commandLine(owner)?.trim() ?? '';
  coreCommand ||= commandLine(owner)?.trim() ?? '';
  return coreCommand;
}

// Command lines identify the processes, so a pid the system has since given to another program is never trusted.
export function recordClaude(dir: string, pid: number, owner = process.pid): string | null {
  const command = commandLine(pid)?.trim();
  const ownerCommand = ownerCommandLine(owner);
  // A record without the owner's command line would take a live core for dead.
  if (!command || !ownerCommand) return null;
  const file = join(dir, `claude-${pid}.pid.json`);
  try {
    writeFileNoFollow(file, JSON.stringify({ pid, command, owner, ownerCommand }), PRIVATE_FILE_MODE);
    return file;
  } catch (error) {
    console.error('agent: could not write the pid file of claude', error);
    return null;
  }
}

// A file that cannot be removed must not fail a core's start or the exit listener of a claude.
export function removePidFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // It stays for the next core to find.
  }
}

// A core killed while claude ran a tool leaves claude and the tool running (spike E10); the next core of any project stops them.
export async function reapOrphans(dir: string, graceMs: number): Promise<number[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => PID_FILE.test(name));
  } catch {
    return [];
  }
  const orphans: { pid: number; file: string }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const record = readRecord(file);
    if (record && running(record.owner, record.ownerCommand)) continue;
    if (record && record.pid !== process.pid && running(record.pid, record.command)) {
      // A core that a claude's tool started cannot stop that claude without stopping itself; the file stays for a core outside it.
      if (!reaches(record.pid, process.pid)) orphans.push({ pid: record.pid, file });
      continue;
    }
    removePidFile(file);
  }
  // The file goes once its claude is stopped, so a core that dies meanwhile leaves the orphan to the next one.
  await Promise.all(orphans.map(async ({ pid, file }) => {
    await stop(pid, graceMs);
    removePidFile(file);
  }));
  return orphans.map(({ pid }) => pid);
}

const running = (pid: number, command: string): boolean => isAlive(pid) && commandLine(pid)?.trim() === command;

function readRecord(file: string): ClaudeRecord | null {
  let value: unknown;
  try {
    value = parseJson(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.pid !== 'number' || typeof value.command !== 'string' || typeof value.owner !== 'number' || typeof value.ownerCommand !== 'string') return null;
  return { pid: value.pid, command: value.command, owner: value.owner, ownerCommand: value.ownerCommand };
}

// claude's SIGTERM handler stops its tools; what is left after the grace time dies with the group, and children that left the group by name.
async function stop(pid: number, graceMs: number): Promise<void> {
  const tree = descendants(pid);
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  signalGroup(pid, 'SIGKILL');
  for (const child of tree) signal(child, 'SIGKILL');
}
