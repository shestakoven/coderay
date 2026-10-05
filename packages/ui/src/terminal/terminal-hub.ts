import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { AGENT_TERMINAL_ID, type ClientMessage, type TerminalInfo, type TerminalKind } from '@ide/protocol';

export interface TerminalTab {
  id: string;
  kind: TerminalKind;
  title: string;
  exited: boolean;
}

export const TERMINAL_THEME = {
  background: '#1e1f22',
  foreground: '#dfe1e5',
  cursor: '#548af7',
  cursorAccent: '#1e1f22',
  selectionBackground: '#2e436e',
  black: '#2b2d30',
  red: '#f75464',
  green: '#73c991',
  yellow: '#f2c55c',
  blue: '#548af7',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#dfe1e5',
  brightBlack: '#6f737a',
  brightRed: '#ff7a86',
  brightGreen: '#8fe0a9',
  brightYellow: '#ffd98a',
  brightBlue: '#7aa7ff',
  brightMagenta: '#d89cf0',
  brightCyan: '#7fd0da',
  brightWhite: '#ffffff',
};

interface Entry {
  tab: TerminalTab;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement | null;
}

export const newTerminalId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export class TerminalHub {
  private readonly entries = new Map<string, Entry>();
  private readonly send: (message: ClientMessage) => boolean;
  private readonly onChange: (tabs: TerminalTab[]) => void;

  constructor(send: (message: ClientMessage) => boolean, onChange: (tabs: TerminalTab[]) => void) {
    this.send = send;
    this.onChange = onChange;
  }

  tabs(): TerminalTab[] {
    return [...this.entries.values()].map((entry) => entry.tab);
  }

  create(): string | null {
    const id = newTerminalId();
    return this.send({ type: 'terminal.open', id, cols: 80, rows: 24 }) ? id : null;
  }

  createAgent(): boolean {
    return this.send({ type: 'terminal.open', id: AGENT_TERMINAL_ID, cols: 80, rows: 24, kind: 'agent' });
  }

  restore(infos: TerminalInfo[]): void {
    for (const entry of this.entries.values()) entry.term.dispose();
    this.entries.clear();
    for (const info of infos) this.add(info);
    this.changed();
  }

  opened(info: TerminalInfo): void {
    if (!this.entries.has(info.id)) this.add(info);
    this.changed();
  }

  output(id: string, data: string): void {
    this.entries.get(id)?.term.write(data);
  }

  exited(id: string, code: number | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.tab = { ...entry.tab, exited: true };
    entry.term.write(`\r\n\x1b[2m[process exited${code === null ? '' : ` with code ${code}`}]\x1b[0m\r\n`);
    this.changed();
  }

  closed(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.term.dispose();
    this.entries.delete(id);
    this.changed();
  }

  close(id: string): void {
    this.send({ type: 'terminal.close', id });
  }

  attach(id: string, host: HTMLElement): void {
    const entry = this.entries.get(id);
    if (!entry || entry.host === host) return;
    entry.host = host;
    entry.term.open(host);
    this.fit(id);
  }

  fit(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.host || entry.host.clientWidth === 0 || entry.host.clientHeight === 0) return;
    const before = `${entry.term.cols}x${entry.term.rows}`;
    entry.fit.fit();
    if (`${entry.term.cols}x${entry.term.rows}` !== before || !entry.tab.exited) {
      this.send({ type: 'terminal.resize', id, cols: entry.term.cols, rows: entry.term.rows });
    }
  }

  focus(id: string): void {
    this.entries.get(id)?.term.focus();
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.term.dispose();
    this.entries.clear();
  }

  private add(info: TerminalInfo): void {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => {
      this.send({ type: 'terminal.input', id: info.id, data });
    });
    // xterm sends a plain CR for Shift+Enter; claude reads Meta+Enter (ESC CR) as a new line.
    if (info.kind === 'agent') {
      term.attachCustomKeyEventHandler((event) => {
        if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return true;
        if (event.type === 'keydown') this.send({ type: 'terminal.input', id: info.id, data: '\x1b\r' });
        return false;
      });
    }
    if (info.scrollback) term.write(info.scrollback);
    this.entries.set(info.id, { tab: { id: info.id, kind: info.kind, title: info.title, exited: info.exited }, term, fit, host: null });
  }

  private changed(): void {
    this.onChange(this.tabs());
  }
}
