import { basename } from 'node:path';
import { shellWord } from './codex/events';

const READ_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// Shells whose scripts the gate's shell reader does not parse (or not under that spelling): a write in one would look like none.
const UNREAD_SHELLS = new Set([...READ_SHELLS, 'ash', 'busybox', 'csh', 'elvish', 'fish', 'ksh', 'mksh', 'nu', 'oksh', 'posh', 'powershell', 'pwsh', 'tcsh', 'xonsh', 'yash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// One word of a command line as written, quotes included; an operator ends it.
const RAW_WORD = /^\s*((?:[^\s'"\\;&|()<>]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+)/s;

/** The shell a command line runs in when the gate cannot read it (one it does not parse, or env with options); null when it can. */
export function unreadShell(command: string): string | null {
  let rest = command;
  let env = false;
  for (let count = 0; count < 32; count++) {
    const raw = RAW_WORD.exec(rest);
    const word = raw ? shellWord(raw[1]!) : null;
    if (raw === null || word === null) return null;
    rest = rest.slice(raw[0].length);
    const name = basename(word);
    if (name === 'env') env = true;
    else if (env && word.startsWith('-')) return `env ${word}`;
    else if (!ASSIGNMENT.test(word)) return !READ_SHELLS.has(name) && UNREAD_SHELLS.has(name.toLowerCase().replace(/\.exe$/, '')) ? name : null;
  }
  return null;
}
