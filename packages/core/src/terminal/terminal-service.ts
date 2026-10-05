import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { MAX_TERMINALS, type TerminalInfo, type TerminalKind, type TerminalServerMessage } from '@ide/protocol';
import { LAUNCH_TOKEN_ENV } from '../project/token';

export const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TERMINAL_INPUT = 65536;

const KILL_GRACE_MS = 2000;
const HIDDEN_ENV = [LAUNCH_TOKEN_ENV, 'CLAUDECODE'];

export interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal: NodeJS.Signals): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

// A program to run instead of the login shell.
export interface TerminalLaunch {
  kind: TerminalKind;
  title: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalServiceOptions {
  root: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  spawnPty?: SpawnPty;
  flushMs?: number;
  scrollbackBytes?: number;
  maxTerminals?: number;
}

interface Terminal {
  id: string;
  kind: TerminalKind;
  title: string;
  pty: PtyProcess;
  exited: boolean;
  pending: string[];
  flushTimer: NodeJS.Timeout | undefined;
  scrollback: string[];
  scrollbackLength: number;
  gone: Promise<void>;
}

// Loaded on first use: a missing prebuilt PTY binary must only disable terminals, not stop the core from starting.
export const spawnNodePty: SpawnPty = (file, args, options) => {
  const { spawn } = createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty');
  const pty = spawn(file, args, options);
  return {
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    // forkpty makes the shell a session and group leader; -pid also reaches children left in its group.
    kill: (signal) => {
      try {
        process.kill(-pty.pid, signal);
      } catch {
        pty.kill(signal);
      }
    },
  };
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.trunc(value)));
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export class TerminalService {
  private readonly terminals = new Map<string, Terminal>();
  private readonly dying = new Set<Promise<void>>();
  private readonly listeners = new Set<(message: TerminalServerMessage) => void>();
  private readonly options: TerminalServiceOptions;
  private readonly shell: string;
  private readonly spawnPty: SpawnPty;
  private readonly flushMs: number;
  private readonly scrollbackBytes: number;
  private readonly maxTerminals: number;
  private opened = 0;

  constructor(options: TerminalServiceOptions) {
    this.options = options;
    this.shell = options.shell ?? process.env.SHELL ?? '/bin/zsh';
    this.spawnPty = options.spawnPty ?? spawnNodePty;
    this.flushMs = options.flushMs ?? 8;
    this.scrollbackBytes = options.scrollbackBytes ?? 262144;
    this.maxTerminals = options.maxTerminals ?? MAX_TERMINALS;
  }

  onMessage(listener: (message: TerminalServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(id: string, cols: number, rows: number, launch?: TerminalLaunch): TerminalInfo {
    if (!TERMINAL_ID.test(id)) throw new Error('A terminal id is 1-64 letters, digits, "_" or "-".');
    if (this.terminals.has(id)) throw new Error(`Terminal "${id}" is already open.`);
    if (this.terminals.size >= this.maxTerminals) throw new Error(`At most ${this.maxTerminals} terminals can be open.`);
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), ...launch?.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const name of HIDDEN_ENV) delete env[name];
    const pty = this.spawnPty(launch?.file ?? this.shell, launch?.args ?? ['-l'], {
      name: 'xterm-256color',
      cols: clamp(cols, 2, 500),
      rows: clamp(rows, 1, 300),
      cwd: launch?.cwd ?? this.options.root,
      env,
    });
    let title = launch?.title;
    if (title === undefined) {
      this.opened += 1;
      const name = basename(this.shell);
      title = this.opened === 1 ? name : `${name} ${this.opened}`;
    }
    let exited!: () => void;
    const terminal: Terminal = {
      id,
      kind: launch?.kind ?? 'shell',
      title,
      pty,
      exited: false,
      pending: [],
      flushTimer: undefined,
      scrollback: [],
      scrollbackLength: 0,
      gone: new Promise<void>((resolve) => (exited = resolve)),
    };
    this.terminals.set(id, terminal);
    pty.onData((data) => {
      if (this.terminals.get(id) !== terminal) return;
      terminal.pending.push(data);
      terminal.flushTimer ??= setTimeout(() => this.flush(terminal), this.flushMs);
    });
    pty.onExit(({ exitCode, signal }) => {
      terminal.exited = true;
      exited();
      if (this.terminals.get(id) !== terminal) return;
      this.flush(terminal);
      this.emit({ type: 'terminal.exit', id, code: signal ? null : exitCode });
    });
    const info = this.info(terminal);
    this.emit({ type: 'terminal.opened', terminal: info });
    return info;
  }

  input(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.exited || data.length > MAX_TERMINAL_INPUT) return;
    terminal.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.exited) return;
    terminal.pty.resize(clamp(cols, 2, 500), clamp(rows, 1, 300));
  }

  close(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    clearTimeout(terminal.flushTimer);
    if (!terminal.exited) {
      const dying = this.kill(terminal);
      this.dying.add(dying);
      void dying.finally(() => this.dying.delete(dying));
    }
    this.emit({ type: 'terminal.closed', id });
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.terminals.keys()]) this.close(id);
    await Promise.all(this.dying);
  }

  snapshot(): TerminalInfo[] {
    return [...this.terminals.values()].map((terminal) => this.info(terminal));
  }

  private info(terminal: Terminal): TerminalInfo {
    return { id: terminal.id, kind: terminal.kind, title: terminal.title, exited: terminal.exited, scrollback: terminal.scrollback.join('') };
  }

  private async kill(terminal: Terminal): Promise<void> {
    terminal.pty.kill('SIGHUP');
    if (await this.within(terminal.gone, KILL_GRACE_MS)) return;
    terminal.pty.kill('SIGKILL');
    // A process stuck in the kernel can outlive SIGKILL; the core must still be able to shut down.
    await this.within(terminal.gone, KILL_GRACE_MS);
  }

  private within(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
    ]).finally(() => clearTimeout(timer));
  }

  private flush(terminal: Terminal): void {
    clearTimeout(terminal.flushTimer);
    terminal.flushTimer = undefined;
    if (terminal.pending.length === 0) return;
    const data = terminal.pending.join('');
    terminal.pending = [];
    this.remember(terminal, data);
    this.emit({ type: 'terminal.output', id: terminal.id, data });
  }

  private remember(terminal: Terminal, data: string): void {
    terminal.scrollback.push(data);
    terminal.scrollbackLength += data.length;
    let excess = terminal.scrollbackLength - this.scrollbackBytes;
    while (excess > 0) {
      const first = terminal.scrollback[0] ?? '';
      if (first.length <= excess) {
        terminal.scrollback.shift();
        terminal.scrollbackLength -= first.length;
        excess -= first.length;
        continue;
      }
      const cut = isLowSurrogate(first.charCodeAt(excess)) ? excess + 1 : excess;
      terminal.scrollback[0] = first.slice(cut);
      terminal.scrollbackLength -= cut;
      excess = 0;
    }
    const head = terminal.scrollback[0];
    if (head !== undefined && isLowSurrogate(head.charCodeAt(0))) {
      terminal.scrollback[0] = head.slice(1);
      terminal.scrollbackLength -= 1;
    }
  }

  private emit(message: TerminalServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
