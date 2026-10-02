import { spawn, type ChildProcess } from 'node:child_process';
import { projectNameFromUrl, type ClonePhase } from '@ide/protocol';
import { gitErrorMessage } from './git';
import { discardTarget, prepareTarget, type ProjectResult } from './target';

export const CLONE_CANCELLED = 'Clone cancelled.';
const KILL_AFTER_MS = 3000;

export interface CloneProgress {
  phase: ClonePhase;
  percent: number;
}

export interface CloneOptions {
  url: string;
  parent: string;
  name: string | null;
  git?: string;
  killAfterMs?: number;
  onProgress: (progress: CloneProgress) => void;
}

export interface CloneHandle {
  done: Promise<ProjectResult>;
  cancel(): void;
}

const PHASES: Record<string, ClonePhase> = {
  'Enumerating objects': 'counting',
  'Counting objects': 'counting',
  'Compressing objects': 'compressing',
  'Receiving objects': 'receiving',
  'Resolving deltas': 'resolving',
  'Updating files': 'checking-out',
  'Checking out files': 'checking-out',
};
const PROGRESS = new RegExp(`^(?:remote: )?(${Object.keys(PHASES).join('|')}):\\s+(\\d+)%`);

export function parseCloneProgress(line: string): CloneProgress | null {
  const match = PROGRESS.exec(line.trim());
  const phase = match?.[1] ? PHASES[match[1]] : undefined;
  return match && phase ? { phase, percent: Number(match[2]) } : null;
}

export function startClone({ url, parent, name, git = 'git', killAfterMs = KILL_AFTER_MS, onProgress }: CloneOptions): CloneHandle {
  let cancelled = false;
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  const cancel = (): void => {
    cancelled = true;
    if (exited || killTimer || !child?.pid) return;
    const pid = child.pid;
    killGroup(pid, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), killAfterMs);
    killTimer.unref();
  };
  // A process group id is only ours while the child is alive: afterwards the pid may belong to someone else.
  const markExited = (): void => {
    exited = true;
    clearTimeout(killTimer);
  };
  return { done: run(), cancel };

  async function run(): Promise<ProjectResult> {
    const address = url.trim();
    if (address === '') return { error: 'Enter a repository URL.' };
    if (address.startsWith('-')) return { error: 'That is not a repository URL.' };
    const target = prepareTarget(parent, name ?? projectNameFromUrl(address));
    if ('error' in target) return target;
    if (cancelled) return { error: CLONE_CANCELLED };

    // Own process group, so that cancelling takes ssh and the other helpers of git down with it.
    let proc: ChildProcess;
    try {
      proc = spawn(git, ['clone', '--progress', '--', address, target.path], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git:file' },
      });
    } catch (error) {
      return { error: gitErrorMessage(error, '') };
    }
    child = proc;
    let tail = '';
    let lastLine = '';
    let last: CloneProgress | undefined;
    const handle = (line: string): void => {
      const text = line.trim();
      if (text === '') return;
      const progress = parseCloneProgress(text);
      if (!progress) {
        lastLine = text;
        return;
      }
      if (last?.phase === progress.phase && last.percent === progress.percent) return;
      last = progress;
      onProgress(progress);
    };
    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = (tail + String(chunk)).split(/[\r\n]+/);
      tail = lines.pop() ?? '';
      lines.forEach(handle);
    });
    const outcome = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
      proc.once('error', (spawnError) => {
        markExited();
        resolve({ code: null, spawnError });
      });
      proc.once('close', (code) => {
        markExited();
        resolve({ code });
      });
    });
    handle(tail);
    if (outcome.spawnError) return { error: gitErrorMessage(outcome.spawnError, '') };
    if (cancelled) {
      discardTarget(target);
      return { error: CLONE_CANCELLED };
    }
    if (outcome.code !== 0) {
      discardTarget(target);
      return { error: lastLine || `git clone exited with code ${outcome.code}.` };
    }
    return { root: target.path };
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
