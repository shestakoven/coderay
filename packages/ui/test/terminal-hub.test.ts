import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, TerminalInfo } from '@ide/protocol';
import { TerminalHub, type TerminalTab } from '../src/terminal/terminal-hub';

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    disposed = false;
    written: string[] = [];
    openedOn: unknown[] = [];
    focused = 0;
    cols = 80;
    rows = 24;
    dataListener: (data: string) => void = () => {};
    keyHandler: ((event: unknown) => boolean) | null = null;
    constructor() {
      FakeTerminal.all.push(this);
    }
    loadAddon() {}
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
    }
    attachCustomKeyEventHandler(handler: (event: unknown) => boolean) {
      this.keyHandler = handler;
    }
    write(data: string) {
      this.written.push(data);
    }
    open(host: unknown) {
      this.openedOn.push(host);
    }
    focus() {
      this.focused += 1;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFit {
    fit = (): void => {};
  }
  class FakeLinks {}
  return { FakeTerminal, FakeFit, FakeLinks };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.FakeFit }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: xterm.FakeLinks }));

const info = (id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, kind: 'shell', title: id, exited: false, scrollback: '', ...overrides });
const AGENT = (overrides: Partial<TerminalInfo> = {}) => info('agent', { kind: 'agent', title: 'claude', ...overrides });

function hubWithSpies() {
  const sent: ClientMessage[] = [];
  const changes: TerminalTab[][] = [];
  const hub = new TerminalHub((message) => {
    sent.push(message);
    return true;
  }, (tabs) => changes.push(tabs));
  return { hub, sent, changes };
}

const terminalOf = (index: number) => xterm.FakeTerminal.all[index] as InstanceType<typeof xterm.FakeTerminal>;

beforeEach(() => {
  xterm.FakeTerminal.all.length = 0;
});

describe('TerminalHub generations', () => {
  it('gives the tabs of one restore the same generation', () => {
    const { hub } = hubWithSpies();
    hub.restore([info('a'), info('b'), AGENT()]);
    const generations = hub.tabs().map((tab) => tab.generation);
    expect(new Set(generations).size).toBe(1);
  });

  it('gives every tab a new generation each time a reconnect restores the terminals, though the ids are the same', () => {
    const { hub } = hubWithSpies();
    const infos = [info('a'), AGENT()];
    hub.restore(infos);
    const first = hub.tabs();
    hub.restore(infos);
    const second = hub.tabs();
    hub.restore(infos);
    const third = hub.tabs();
    expect(second.map((tab) => tab.id)).toEqual(first.map((tab) => tab.id));
    for (const [index] of first.entries()) {
      expect(second[index]?.generation).toBeGreaterThan(first[index]?.generation as number);
      expect(third[index]?.generation).toBeGreaterThan(second[index]?.generation as number);
    }
  });

  it('keeps the generation of a tab while nothing restores it: output, exit and new terminals do not change it', () => {
    const { hub } = hubWithSpies();
    hub.restore([info('a')]);
    const generation = hub.tabs()[0]?.generation;
    hub.output('a', 'text');
    hub.exited('a', 0);
    hub.opened(info('b'));
    expect(hub.tabs().find((tab) => tab.id === 'a')?.generation).toBe(generation);
  });

  it('opens a terminal after a restore in the generation of that restore', () => {
    const { hub } = hubWithSpies();
    hub.restore([info('a')]);
    hub.opened(AGENT());
    const [a, agent] = hub.tabs();
    expect(agent?.generation).toBe(a?.generation);
  });

  it('gives a terminal opened after a second restore a newer generation than one opened after the first', () => {
    const { hub } = hubWithSpies();
    hub.restore([]);
    hub.opened(info('a'));
    const before = hub.tabs()[0]?.generation as number;
    hub.restore([]);
    hub.opened(info('a'));
    expect(hub.tabs()[0]?.generation).toBeGreaterThan(before);
  });

  it('passes the tabs with the new generation to the listener once, when it restores', () => {
    const { hub, changes } = hubWithSpies();
    hub.restore([info('a')]);
    const calls = changes.length;
    hub.restore([info('a')]);
    expect(changes).toHaveLength(calls + 1);
    expect(changes.at(-1)).toEqual(hub.tabs());
    expect(changes.at(-1)?.[0]?.generation).toBeGreaterThan(changes[calls - 1]?.[0]?.generation as number);
  });

  it('drops the tabs of an empty restore, so no view is kept on a terminal the core no longer has', () => {
    const { hub, changes } = hubWithSpies();
    hub.restore([info('a'), AGENT()]);
    hub.restore([]);
    expect(hub.tabs()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });
});

describe('TerminalHub after a reconnect replaces the terminals', () => {
  it('disposes the old xterm of every tab and makes a new one', () => {
    const { hub } = hubWithSpies();
    hub.restore([info('a'), AGENT()]);
    const old = [terminalOf(0), terminalOf(1)];
    hub.restore([info('a'), AGENT()]);
    expect(old.map((term) => term.disposed)).toEqual([true, true]);
    expect(xterm.FakeTerminal.all).toHaveLength(4);
    expect(xterm.FakeTerminal.all.slice(2).map((term) => term.disposed)).toEqual([false, false]);
  });

  it('shows the content the core holds for a terminal in the new xterm', () => {
    const { hub } = hubWithSpies();
    hub.restore([AGENT({ scrollback: 'before' })]);
    hub.restore([AGENT({ scrollback: 'before and after' })]);
    expect(terminalOf(1).written).toEqual(['before and after']);
  });

  it('writes the output that comes after the reconnect to the new xterm and not to the old one', () => {
    const { hub } = hubWithSpies();
    hub.restore([info('a')]);
    hub.restore([info('a')]);
    hub.output('a', 'fresh');
    expect([terminalOf(0).written, terminalOf(1).written]).toEqual([[], ['fresh']]);
  });

  it('opens the new xterm on a host that the old one was opened on, so a view that keeps its element can re-attach', () => {
    const { hub } = hubWithSpies();
    const host = { clientWidth: 0, clientHeight: 0 } as HTMLElement;
    hub.restore([AGENT()]);
    hub.attach('agent', host);
    hub.attach('agent', host);
    expect(terminalOf(0).openedOn).toEqual([host]);
    hub.restore([AGENT()]);
    hub.attach('agent', host);
    expect(terminalOf(1).openedOn).toEqual([host]);
  });

  it('opens the new xterm on a new host as well', () => {
    const { hub } = hubWithSpies();
    const oldHost = { clientWidth: 0, clientHeight: 0 } as HTMLElement;
    const newHost = { clientWidth: 0, clientHeight: 0 } as HTMLElement;
    hub.restore([info('a')]);
    hub.attach('a', oldHost);
    hub.restore([info('a')]);
    hub.attach('a', newHost);
    expect([terminalOf(0).openedOn, terminalOf(1).openedOn]).toEqual([[oldHost], [newHost]]);
  });

  it('sends what is typed into the new xterm to the core under its id', () => {
    const { hub, sent } = hubWithSpies();
    hub.restore([AGENT()]);
    hub.restore([AGENT()]);
    terminalOf(1).dataListener('ls\r');
    expect(sent).toEqual([{ type: 'terminal.input', id: 'agent', data: 'ls\r' }]);
  });

  it('focuses the new xterm, not the old one', () => {
    const { hub } = hubWithSpies();
    hub.restore([AGENT()]);
    hub.restore([AGENT()]);
    hub.focus('agent');
    expect([terminalOf(0).focused, terminalOf(1).focused]).toEqual([0, 1]);
  });

  it('keeps Shift+Enter as a new line for the agent in the new xterm', () => {
    const { hub, sent } = hubWithSpies();
    hub.restore([AGENT()]);
    hub.restore([AGENT()]);
    const handled = terminalOf(1).keyHandler?.({ key: 'Enter', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, type: 'keydown' });
    expect([handled, sent]).toEqual([false, [{ type: 'terminal.input', id: 'agent', data: '\x1b\r' }]]);
  });

  it('keeps the exit of a terminal that exited before the reconnect', () => {
    const { hub } = hubWithSpies();
    hub.restore([AGENT({ exited: true })]);
    expect(hub.tabs()[0]).toMatchObject({ id: 'agent', kind: 'agent', exited: true });
  });
});
