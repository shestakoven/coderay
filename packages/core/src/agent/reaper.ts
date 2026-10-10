import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, parseJson } from '../json';
import { writeFileNoFollow } from '../mcp/config';
import { commandLine, descendants, isAlive, signal, signalGroup } from '../os-process';

const PID_FILE = /^claude-\d+\.pid\.json$/;
const PRIVATE_FILE_MODE = 0o600;
const POLL_MS = 50;

interface ClaudeRecord {
  pid: number;
  command: string;
  owner: number;
  ownerCommand: string;
}

// Command lines identify the processes, so a pid the system has since given to another program is never trusted.
export function recordClaude(dir: string, pid: number, owner = process.pid): string | null {
  const command = commandLine(pid)?.trim();
  const ownerCommand = commandLine(owner)?.trim() ?? '';
  if (!command) return null;
  const file = join(dir, `claude-${pid}.pid.json`);
  try {
    writeFileNoFollow(file, JSON.stringify({ pid, command, owner, ownerCommand }), PRIVATE_FILE_MODE);
    return file;
  } catch (error) {
    console.error('agent: could not write the pid file of claude', error);
    return null;
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
  const orphans: number[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const record = readRecord(file);
    if (record && running(record.owner, record.ownerCommand)) continue;
    if (record && record.pid !== process.pid && running(record.pid, record.command)) orphans.push(record.pid);
    rmSync(file, { force: true });
  }
  await Promise.all(orphans.map((pid) => stop(pid, graceMs)));
  return orphans;
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
