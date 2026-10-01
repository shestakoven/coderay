export const MAX_TERMINALS = 8;

export interface TerminalInfo {
  id: string;
  title: string;
  exited: boolean;
  scrollback: string;
}

export type TerminalClientMessage =
  | { type: 'terminal.open'; id: string; cols: number; rows: number }
  | { type: 'terminal.input'; id: string; data: string }
  | { type: 'terminal.resize'; id: string; cols: number; rows: number }
  | { type: 'terminal.close'; id: string };

export type TerminalServerMessage =
  | { type: 'terminal.snapshot'; terminals: TerminalInfo[] }
  | { type: 'terminal.opened'; terminal: TerminalInfo }
  | { type: 'terminal.output'; id: string; data: string }
  | { type: 'terminal.exit'; id: string; code: number | null }
  | { type: 'terminal.closed'; id: string };
