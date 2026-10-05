import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalServerMessage } from '@ide/protocol';
import { TerminalService, type PtyProcess, type PtySpawnOptions } from '../../src/terminal/terminal-service';

class FakePty implements PtyProcess {
  dataListener: (data: string) => void = () => {};
  exitListener: (exit: { exitCode: number; signal?: number }) => void = () => {};
  writes: string[] = [];
  resizes: [number, number][] = [];
  kills: string[] = [];
  dieOn: string | null = 'SIGHUP';
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: PtySpawnOptions,
  ) {}
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
  }
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    if (signal === this.dieOn) this.exitListener({ exitCode: 0, signal: 1 });
  }
  emit(data: string) {
    this.dataListener(data);
  }
  exit(code: number) {
    this.exitListener({ exitCode: code });
  }
}

interface Harness {
  service: TerminalService;
  ptys: FakePty[];
  messages: TerminalServerMessage[];
}

function setup(options: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}): Harness {
  const ptys: FakePty[] = [];
  const messages: TerminalServerMessage[] = [];
  const service = new TerminalService({
    root: '/proj',
    shell: '/bin/zsh',
    env: { PATH: '/bin' },
    flushMs: 10,
    spawnPty: (file, args, spawnOptions) => {
      const pty = new FakePty(file, args, spawnOptions);
      ptys.push(pty);
      return pty;
    },
    ...options,
  });
  service.onMessage((message) => messages.push(message));
  return { service, ptys, messages };
}

const wellFormed = (text: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
const outputs = (messages: TerminalServerMessage[]) => messages.filter((m) => m.type === 'terminal.output');
const ofType = (messages: TerminalServerMessage[], type: TerminalServerMessage['type']) => messages.filter((m) => m.type === type);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalService.open validation', () => {
  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'a b'],
    ['a dot', 'a.b'],
    ['a slash', 'a/b'],
    ['a non-ASCII letter', 'é'],
  ])('rejects an id with %s', (_name, id) => {
    const { service, ptys } = setup();
    expect(() => service.open(id, 80, 24)).toThrow(/terminal id/);
    expect(ptys).toHaveLength(0);
  });

  it('accepts a 64-character id and the allowed characters', () => {
    const { service } = setup();
    expect(service.open('a'.repeat(64), 80, 24).id).toHaveLength(64);
    expect(service.open('Az09_-', 80, 24).id).toBe('Az09_-');
  });

  it('rejects a duplicate id without spawning a second process', () => {
    const { service, ptys } = setup();
    service.open('t1', 80, 24);
    expect(() => service.open('t1', 80, 24)).toThrow(/already open/);
    expect(ptys).toHaveLength(1);
  });

  it('refuses the 9th terminal', () => {
    const { service, ptys } = setup();
    for (let i = 0; i < 8; i += 1) service.open(`t${i}`, 80, 24);
    expect(() => service.open('t8', 80, 24)).toThrow(/At most 8/);
    expect(ptys).toHaveLength(8);
  });

  it('allows a new terminal once one is closed', () => {
    const { service } = setup();
    for (let i = 0; i < 8; i += 1) service.open(`t${i}`, 80, 24);
    service.close('t0');
    expect(() => service.open('t8', 80, 24)).not.toThrow();
  });
});

describe('TerminalService.open spawn', () => {
  it('clamps oversized cols and rows to 500 and 300', () => {
    const { service, ptys } = setup();
    service.open('t', 9999, 9999);
    expect(ptys[0]!.options).toMatchObject({ cols: 500, rows: 300 });
  });

  it('clamps undersized cols and rows to 2 and 1', () => {
    const { service, ptys } = setup();
    service.open('t', -5, 0);
    expect(ptys[0]!.options).toMatchObject({ cols: 2, rows: 1 });
  });

  it('keeps in-range sizes as they are', () => {
    const { service, ptys } = setup();
    service.open('t', 2, 1);
    service.open('u', 500, 300);
    expect(ptys[0]!.options).toMatchObject({ cols: 2, rows: 1 });
    expect(ptys[1]!.options).toMatchObject({ cols: 500, rows: 300 });
  });

  it('starts the configured shell as a login shell in the project root', () => {
    const { service, ptys } = setup({ shell: '/usr/bin/fish', root: '/work/p' });
    service.open('t', 80, 24);
    expect(ptys[0]!.file).toBe('/usr/bin/fish');
    expect(ptys[0]!.args).toEqual(['-l']);
    expect(ptys[0]!.options.cwd).toBe('/work/p');
    expect(ptys[0]!.options.name).toBe('xterm-256color');
  });

  it('sets TERM and COLORTERM, overriding inherited values', () => {
    const { service, ptys } = setup({ env: { TERM: 'dumb', COLORTERM: 'no', KEEP: 'yes' } });
    service.open('t', 80, 24);
    expect(ptys[0]!.options.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', KEEP: 'yes' });
  });

  it('removes IDE_CORE_TOKEN and CLAUDECODE from the shell environment', () => {
    const { service, ptys } = setup({ env: { IDE_CORE_TOKEN: 'secret', CLAUDECODE: '1', PATH: '/bin' } });
    service.open('t', 80, 24);
    const env = ptys[0]!.options.env;
    expect(Object.keys(env)).not.toContain('IDE_CORE_TOKEN');
    expect(Object.keys(env)).not.toContain('CLAUDECODE');
    expect(env.PATH).toBe('/bin');
  });

  it('scrubs the secrets from process.env when no env option is given, without mutating it', () => {
    vi.stubEnv('IDE_CORE_TOKEN', 'secret');
    vi.stubEnv('CLAUDECODE', '1');
    try {
      const { service, ptys } = setup({ env: undefined });
      service.open('t', 80, 24);
      expect(Object.keys(ptys[0]!.options.env)).not.toContain('IDE_CORE_TOKEN');
      expect(Object.keys(ptys[0]!.options.env)).not.toContain('CLAUDECODE');
      expect(process.env.IDE_CORE_TOKEN).toBe('secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not mutate the env object passed in', () => {
    const env = { IDE_CORE_TOKEN: 'secret', CLAUDECODE: '1' };
    const { service } = setup({ env });
    service.open('t', 80, 24);
    expect(env).toEqual({ IDE_CORE_TOKEN: 'secret', CLAUDECODE: '1' });
  });

  it('titles terminals after the shell with a running number from the second on', () => {
    const { service } = setup();
    expect(service.open('a', 80, 24).title).toBe('zsh');
    expect(service.open('b', 80, 24).title).toBe('zsh 2');
    expect(service.open('c', 80, 24).title).toBe('zsh 3');
  });

  it('does not reuse a number after a terminal is closed', () => {
    const { service } = setup();
    service.open('a', 80, 24);
    service.close('a');
    expect(service.open('b', 80, 24).title).toBe('zsh 2');
  });

  it('announces the opened terminal with an empty scrollback and exited=false', () => {
    const { service, messages } = setup();
    service.open('t', 80, 24);
    expect(messages).toEqual([{ type: 'terminal.opened', terminal: { id: 't', kind: 'shell', title: 'zsh', exited: false, scrollback: '' } }]);
  });
});

describe('TerminalService output', () => {
  it('coalesces data within flushMs into one message with the order preserved', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('a');
    vi.advanceTimersByTime(4);
    ptys[0]!.emit('b');
    ptys[0]!.emit('c');
    expect(outputs(messages)).toHaveLength(0);
    vi.advanceTimersByTime(10);
    expect(outputs(messages)).toEqual([{ type: 'terminal.output', id: 't', data: 'abc' }]);
  });

  it('flushes flushMs after the first chunk, not after the latest one', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('a');
    vi.advanceTimersByTime(6);
    ptys[0]!.emit('b');
    vi.advanceTimersByTime(4);
    expect(outputs(messages)).toEqual([{ type: 'terminal.output', id: 't', data: 'ab' }]);
  });

  it('flushes a separate message for data arriving after a flush', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('one');
    vi.advanceTimersByTime(10);
    ptys[0]!.emit('two');
    vi.advanceTimersByTime(10);
    expect(outputs(messages).map((m) => (m as { data: string }).data)).toEqual(['one', 'two']);
  });

  it('does not emit before flushMs has elapsed', () => {
    const { service, ptys, messages } = setup({ flushMs: 50 });
    service.open('t', 80, 24);
    ptys[0]!.emit('x');
    vi.advanceTimersByTime(49);
    expect(outputs(messages)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(outputs(messages)).toHaveLength(1);
  });

  it('keeps output of different terminals separate', () => {
    const { service, ptys, messages } = setup();
    service.open('a', 80, 24);
    service.open('b', 80, 24);
    ptys[0]!.emit('A');
    ptys[1]!.emit('B');
    vi.advanceTimersByTime(10);
    expect(outputs(messages)).toEqual([
      { type: 'terminal.output', id: 'a', data: 'A' },
      { type: 'terminal.output', id: 'b', data: 'B' },
    ]);
  });

  it('loses nothing across many chunks', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    const chunks = Array.from({ length: 200 }, (_, i) => `[${i}]`);
    for (const chunk of chunks) ptys[0]!.emit(chunk);
    vi.advanceTimersByTime(10);
    const joined = outputs(messages).map((m) => (m as { data: string }).data).join('');
    expect(joined).toBe(chunks.join(''));
    expect(service.snapshot()[0]!.scrollback).toBe(chunks.join(''));
  });

  it('does not emit output for a terminal closed before the flush', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('late');
    service.close('t');
    vi.advanceTimersByTime(100);
    expect(outputs(messages)).toHaveLength(0);
  });

  it('ignores data that arrives after the terminal is closed', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    service.close('t');
    ptys[0]!.emit('ghost');
    vi.advanceTimersByTime(100);
    expect(outputs(messages)).toHaveLength(0);
  });
});

describe('TerminalService scrollback', () => {
  it('keeps everything while under the cap', () => {
    const { service, ptys } = setup({ scrollbackBytes: 10 });
    service.open('t', 80, 24);
    ptys[0]!.emit('0123456789');
    vi.advanceTimersByTime(10);
    expect(service.snapshot()[0]!.scrollback).toBe('0123456789');
  });

  it('drops the oldest characters from the front, within one chunk', () => {
    const { service, ptys } = setup({ scrollbackBytes: 5 });
    service.open('t', 80, 24);
    ptys[0]!.emit('0123456789');
    vi.advanceTimersByTime(10);
    expect(service.snapshot()[0]!.scrollback).toBe('56789');
  });

  it('drops whole old chunks and part of the next one across flushes', () => {
    const { service, ptys } = setup({ scrollbackBytes: 6 });
    service.open('t', 80, 24);
    for (const chunk of ['aaaa', 'bbbb', 'cccc']) {
      ptys[0]!.emit(chunk);
      vi.advanceTimersByTime(10);
    }
    expect(service.snapshot()[0]!.scrollback).toBe('bbcccc');
  });

  it('keeps the cap exact over many small flushes', () => {
    const { service, ptys } = setup({ scrollbackBytes: 7 });
    service.open('t', 80, 24);
    let all = '';
    for (let i = 0; i < 30; i += 1) {
      const chunk = String(i % 10);
      all += chunk;
      ptys[0]!.emit(chunk);
      vi.advanceTimersByTime(10);
    }
    expect(service.snapshot()[0]!.scrollback).toBe(all.slice(-7));
  });

  it('never starts with half of a surrogate pair when the cut lands inside it', () => {
    const { service, ptys } = setup({ scrollbackBytes: 4 });
    service.open('t', 80, 24);
    // 'a😀cde' is 6 units; dropping 2 lands between the two units of the pair
    ptys[0]!.emit('a😀cde');
    vi.advanceTimersByTime(10);
    const scrollback = service.snapshot()[0]!.scrollback;
    expect(scrollback).toBe('cde');
    expect(wellFormed(scrollback)).toBe(true);
  });

  it('drops a pair entirely when the cut lands between its units, across chunks', () => {
    const { service, ptys } = setup({ scrollbackBytes: 4 });
    service.open('t', 80, 24);
    ptys[0]!.emit('😀😀');
    vi.advanceTimersByTime(10);
    ptys[0]!.emit('x');
    vi.advanceTimersByTime(10);
    const scrollback = service.snapshot()[0]!.scrollback;
    expect(wellFormed(scrollback)).toBe(true);
    expect(scrollback).toBe('😀x');
  });

  it('keeps a whole pair when the cut falls right before it', () => {
    const { service, ptys } = setup({ scrollbackBytes: 3 });
    service.open('t', 80, 24);
    ptys[0]!.emit('ab😀c');
    vi.advanceTimersByTime(10);
    expect(service.snapshot()[0]!.scrollback).toBe('😀c');
  });

  it('removes a low surrogate left at the head when a whole chunk is dropped', () => {
    const { service, ptys } = setup({ scrollbackBytes: 3 });
    service.open('t', 80, 24);
    ptys[0]!.emit('\ud83d');
    vi.advanceTimersByTime(10);
    ptys[0]!.emit('\ude00ab');
    vi.advanceTimersByTime(10);
    expect(service.snapshot()[0]!.scrollback).toBe('ab');
  });
});

describe('TerminalService.snapshot', () => {
  it('is empty without terminals', () => {
    expect(setup().service.snapshot()).toEqual([]);
  });

  it('lists open terminals with their scrollback only after the flush', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('hello');
    expect(service.snapshot()[0]!.scrollback).toBe('');
    vi.advanceTimersByTime(10);
    expect(service.snapshot()).toEqual([{ id: 't', kind: 'shell', title: 'zsh', exited: false, scrollback: 'hello' }]);
  });

  it('flags exited terminals and keeps their scrollback', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('bye');
    ptys[0]!.exit(0);
    expect(service.snapshot()).toEqual([{ id: 't', kind: 'shell', title: 'zsh', exited: true, scrollback: 'bye' }]);
  });

  it('omits closed terminals', () => {
    const { service } = setup();
    service.open('a', 80, 24);
    service.open('b', 80, 24);
    service.close('a');
    expect(service.snapshot().map((t) => t.id)).toEqual(['b']);
  });
});

describe('TerminalService.input', () => {
  it('forwards data to the process', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.input('t', 'ls\r');
    expect(ptys[0]!.writes).toEqual(['ls\r']);
  });

  it('ignores an unknown id', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.input('nope', 'x');
    expect(ptys[0]!.writes).toEqual([]);
  });

  it('ignores input for an exited terminal', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exit(0);
    service.input('t', 'x');
    expect(ptys[0]!.writes).toEqual([]);
  });

  it('ignores input over 65536 characters but forwards exactly 65536', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.input('t', 'x'.repeat(65537));
    expect(ptys[0]!.writes).toEqual([]);
    service.input('t', 'y'.repeat(65536));
    expect(ptys[0]!.writes).toHaveLength(1);
  });

  it('ignores input for a closed terminal', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.close('t');
    service.input('t', 'x');
    expect(ptys[0]!.writes).toEqual([]);
  });
});

describe('TerminalService.resize', () => {
  it('resizes the process', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.resize('t', 100, 40);
    expect(ptys[0]!.resizes).toEqual([[100, 40]]);
  });

  it('clamps to [2,500] x [1,300]', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.resize('t', 1000, 1000);
    service.resize('t', 0, 0);
    expect(ptys[0]!.resizes).toEqual([
      [500, 300],
      [2, 1],
    ]);
  });

  it('ignores an unknown id', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.resize('nope', 10, 10);
    expect(ptys[0]!.resizes).toEqual([]);
  });

  it('ignores an exited terminal', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exit(0);
    service.resize('t', 10, 10);
    expect(ptys[0]!.resizes).toEqual([]);
  });
});

describe('TerminalService process exit', () => {
  it('reports the exit code and keeps the terminal with exited=true', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exit(3);
    expect(ofType(messages, 'terminal.exit')).toEqual([{ type: 'terminal.exit', id: 't', code: 3 }]);
    expect(service.snapshot()[0]).toMatchObject({ id: 't', exited: true });
  });

  it('reports a null code when the process died from a signal', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exitListener({ exitCode: 0, signal: 9 });
    expect(ofType(messages, 'terminal.exit')).toEqual([{ type: 'terminal.exit', id: 't', code: null }]);
  });

  it('flushes pending output before the exit message', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('last words');
    ptys[0]!.exit(0);
    const types = messages.map((m) => m.type);
    expect(types.indexOf('terminal.output')).toBeGreaterThan(-1);
    expect(types.indexOf('terminal.output')).toBeLessThan(types.indexOf('terminal.exit'));
    expect(outputs(messages)).toEqual([{ type: 'terminal.output', id: 't', data: 'last words' }]);
  });

  it('does not emit the flushed output a second time when the timer fires later', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.emit('once');
    ptys[0]!.exit(0);
    vi.advanceTimersByTime(100);
    expect(outputs(messages)).toHaveLength(1);
  });

  it('keeps an exited terminal counted against the limit until it is closed', () => {
    const { service, ptys } = setup();
    for (let i = 0; i < 8; i += 1) service.open(`t${i}`, 80, 24);
    ptys[0]!.exit(0);
    expect(() => service.open('x', 80, 24)).toThrow(/At most 8/);
  });
});

describe('TerminalService.close', () => {
  it('sends SIGHUP and emits terminal.closed', async () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    service.close('t');
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
    expect(ofType(messages, 'terminal.closed')).toEqual([{ type: 'terminal.closed', id: 't' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it('does not send SIGKILL when the process exits right after SIGHUP', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.close('t');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it('escalates to SIGKILL after 2 seconds when SIGHUP is ignored', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGKILL';
    service.close('t');
    await vi.advanceTimersByTimeAsync(1999);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
    await vi.advanceTimersByTimeAsync(1);
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
  });

  it('emits no terminal.exit for a closed terminal, even when the process exits later', async () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGKILL';
    service.close('t');
    await vi.advanceTimersByTimeAsync(2500);
    expect(ofType(messages, 'terminal.exit')).toEqual([]);
  });

  it('emits no terminal.exit when the process dies synchronously on SIGHUP', () => {
    const { service, messages } = setup();
    service.open('t', 80, 24);
    service.close('t');
    expect(ofType(messages, 'terminal.exit')).toEqual([]);
  });

  it('does not kill a process that has already exited, but still emits closed', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exit(0);
    service.close('t');
    expect(ptys[0]!.kills).toEqual([]);
    expect(ofType(messages, 'terminal.closed')).toHaveLength(1);
  });

  it('ignores an unknown id', () => {
    const { service, messages } = setup();
    service.close('nope');
    expect(messages).toEqual([]);
  });

  it('closing twice emits closed once and kills once', () => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24);
    service.close('t');
    service.close('t');
    expect(ofType(messages, 'terminal.closed')).toHaveLength(1);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it('allows reusing the id after close', () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    service.close('t');
    expect(() => service.open('t', 80, 24)).not.toThrow();
    expect(ptys).toHaveLength(2);
  });
});

const AGENT = { kind: 'agent' as const, title: 'claude', file: '/usr/bin/claude', args: ['--resume', 'x'], cwd: '/proj', env: {} };
const settled = (promise: Promise<void>) => {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
};

describe('TerminalService.close of an agent terminal', () => {
  it('stops the process with SIGTERM, which claude answers by stopping its tools, and not with SIGHUP', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    ptys[0]!.dieOn = 'SIGTERM';
    await service.close('agent');
    expect(ptys[0]!.kills).toEqual(['SIGTERM']);
  });

  it('stops a shell with SIGHUP next to it', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGTERM';
    await Promise.all([service.close('agent'), service.close('t')]);
    expect([ptys[0]!.kills, ptys[1]!.kills]).toEqual([['SIGTERM'], ['SIGHUP']]);
  });

  it('does not send SIGKILL when the process exits right after SIGTERM', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    ptys[0]!.dieOn = 'SIGTERM';
    void service.close('agent');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ptys[0]!.kills).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL after 2 seconds when SIGTERM is ignored', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    ptys[0]!.dieOn = 'SIGKILL';
    void service.close('agent');
    await vi.advanceTimersByTimeAsync(1999);
    expect(ptys[0]!.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(ptys[0]!.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops every terminal of the agent kind with SIGTERM on closeAll, and a shell with SIGHUP', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGTERM';
    await service.closeAll();
    expect([ptys[0]!.kills, ptys[1]!.kills]).toEqual([['SIGTERM'], ['SIGHUP']]);
  });
});

describe('TerminalService.close promise', () => {
  it('resolves for an id that is not open', async () => {
    await expect(setup().service.close('nope')).resolves.toBeUndefined();
  });

  it('resolves for a terminal whose process has already exited, without killing it', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.exit(0);
    await expect(service.close('t')).resolves.toBeUndefined();
    expect(ptys[0]!.kills).toEqual([]);
  });

  it('resolves once the process is gone after the signal', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    await expect(service.close('t')).resolves.toBeUndefined();
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it.each([['an agent terminal', true], ['a shell', false]])('does not resolve for %s while the process still runs, though the terminal is already announced closed', async (_name, agent) => {
    const { service, ptys, messages } = setup();
    service.open('t', 80, 24, agent ? AGENT : undefined);
    ptys[0]!.dieOn = null;
    const closing = settled(service.close('t'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(closing.done).toBe(false);
    expect(ofType(messages, 'terminal.closed')).toHaveLength(1);
  });

  it('resolves as soon as a process that ignored the signal exits on its own, with no SIGKILL', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = null;
    const closing = settled(service.close('t'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(closing.done).toBe(false);
    ptys[0]!.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(closing.done).toBe(true);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it('resolves once SIGKILL has stopped a process that ignored the signal', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGKILL';
    const closing = settled(service.close('t'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(closing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closing.done).toBe(true);
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
  });

  it('gives up after the extra wait for a process that ignores SIGKILL as well, so the core can go on', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = null;
    const closing = settled(service.close('t'));
    await vi.advanceTimersByTimeAsync(3999);
    expect(closing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closing.done).toBe(true);
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
  });

  it('gives a second close of the same terminal nothing to wait for, since the first one took it out', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = null;
    void service.close('t');
    await expect(service.close('t')).resolves.toBeUndefined();
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });

  it('lets the id be opened again at once, while the old process is still stopping', async () => {
    const { service, ptys } = setup();
    service.open('agent', 80, 24, AGENT);
    ptys[0]!.dieOn = null;
    const closing = settled(service.close('agent'));
    expect(() => service.open('agent', 80, 24, AGENT)).not.toThrow();
    expect([ptys.length, closing.done]).toEqual([2, false]);
  });
});

describe('TerminalService.closeAll', () => {
  it('resolves immediately when nothing is open', async () => {
    await expect(setup().service.closeAll()).resolves.toBeUndefined();
  });

  it('closes every terminal and emits closed for each', async () => {
    const { service, ptys, messages } = setup();
    service.open('a', 80, 24);
    service.open('b', 80, 24);
    await service.closeAll();
    expect(ptys.map((p) => p.kills)).toEqual([['SIGHUP'], ['SIGHUP']]);
    expect(ofType(messages, 'terminal.closed')).toHaveLength(2);
    expect(service.snapshot()).toEqual([]);
  });

  it('waits for the exit of a process that needs SIGKILL', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = 'SIGKILL';
    let done = false;
    const closing = service.closeAll().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
    await closing;
    expect(done).toBe(true);
  });

  it('does not resolve while a process still runs after SIGHUP', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = null;
    let done = false;
    void service.closeAll().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
  });

  it('does not hang when a process ignores SIGKILL: resolves after the extra wait', async () => {
    const { service, ptys } = setup();
    service.open('t', 80, 24);
    ptys[0]!.dieOn = null;
    let done = false;
    const closing = service.closeAll().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
    expect(done).toBe(true);
  });

  it('skips already exited terminals when waiting', async () => {
    const { service, ptys } = setup();
    service.open('a', 80, 24);
    service.open('b', 80, 24);
    ptys[0]!.exit(0);
    await service.closeAll();
    expect(ptys[0]!.kills).toEqual([]);
    expect(ptys[1]!.kills).toEqual(['SIGHUP']);
  });

  it('waits for every terminal, not just the first', async () => {
    const { service, ptys } = setup();
    service.open('a', 80, 24);
    service.open('b', 80, 24);
    ptys[1]!.dieOn = null;
    let done = false;
    void service.closeAll().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });
});

describe('TerminalService.onMessage', () => {
  it('stops delivering after unsubscribe', () => {
    const { service } = setup();
    const seen: TerminalServerMessage[] = [];
    const off = service.onMessage((m) => seen.push(m));
    service.open('a', 80, 24);
    off();
    service.open('b', 80, 24);
    expect(seen).toHaveLength(1);
  });
});
