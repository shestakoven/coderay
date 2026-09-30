import { posix } from 'node:path';

export interface ShellEnv {
  home: string;
  vars: Record<string, string | undefined>;
}

export interface ShellTarget {
  word: string;
  path: string | null;
  temp: boolean;
  mkdir: boolean;
  deleting: boolean;
  names: string[];
  unresolved: string | null;
}

export interface ShellWrites {
  targets: ShellTarget[];
  allTracked: boolean;
}

type Part =
  | { kind: 'lit'; text: string }
  | { kind: 'tilde' }
  | { kind: 'other' }
  | { kind: 'escape' }
  | { kind: 'var'; name: string }
  | { kind: 'glob' }
  | { kind: 'sub'; body: string };

interface Word {
  parts: Part[];
  raw: string;
}

type Token = { t: 'word'; word: Word } | { t: 'op'; op: string } | { t: 'redir'; op: string };

interface Redirect {
  op: string;
  word: Word | null;
}

interface State {
  env: ShellEnv;
  cwd: (string | null)[];
  mktemp: Set<string>;
  poisoned: Set<string>;
  targets: ShellTarget[];
  allTracked: boolean;
}

interface TargetExtra {
  mkdir?: boolean;
  deleting?: boolean;
  names?: string[];
}

type WordValue = { text: string } | { temp: true } | { problem: string };

const BREAKS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const LONG_OPERATORS = ['&&', '||', ';;', '|&'];
const REDIRECTS = ['&>>', '<<<', '<<-', '>>', '>|', '&>', '>&', '<&', '<>', '<<', '>', '<'];
const SHORT_OPERATORS = [';', '|', '&', '(', ')'];
const FILE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'env']);
const WORK_TREE_REWRITES = new Set(['checkout', 'switch', 'restore', 'reset', 'stash', 'clean', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am']);
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'tee', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'chgrp', 'sed', 'ln', 'install', 'dd']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PLAIN_MKTEMP_FLAGS = new Set(['-d', '-q', '-u', '--directory', '--quiet', '--dry-run', '--tmpdir']);
const CHMOD_OPTIONS = new Set(['-c', '--changes', '-f', '--silent', '--quiet', '-v', '--verbose', '--no-preserve-root', '--preserve-root', '-R', '--recursive', '-H', '-L', '-P', '-h', '--help', '--version']);
const PROTECTED_VARS = new Set(['HOME', 'TMPDIR', 'TMP']);
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const DEVICE = /^\/dev\/(null|stdout|stderr|tty|zero|fd\/\d+)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 8;
const EMPTY: Word = { parts: [], raw: '' };

export function shellWrites(command: string, cwd: string, env: ShellEnv): ShellWrites {
  const state: State = { env, cwd: [cwd], mktemp: new Set(), poisoned: new Set(), targets: [], allTracked: false };
  run(command, state, 0);
  return { targets: state.targets, allTracked: state.allTracked };
}

function run(script: string, state: State, depth: number): void {
  if (depth > MAX_DEPTH) {
    state.targets.push(unresolved(script.slice(0, 60), 'commands nested too deeply'));
    return;
  }
  const tokens = lex(script);
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  const flush = (): void => {
    if (words.length > 0 || redirects.length > 0) simpleCommand(words, redirects, state, depth);
    words = [];
    redirects = [];
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.t === 'word') {
      words.push(token.word);
    } else if (token.t === 'redir') {
      const next = tokens[i + 1];
      redirects.push({ op: token.op, word: next?.t === 'word' ? next.word : null });
      if (next?.t === 'word') i += 1;
    } else {
      flush();
      if (token.op === '(') state.cwd.push(cwdOf(state));
      if (token.op === ')' && state.cwd.length > 1) state.cwd.pop();
    }
  }
  flush();
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let delimiterStrips: boolean | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') {
      i += 1;
    } else if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '\n') {
      tokens.push({ t: 'op', op: '\n' });
      i += 1;
      for (const doc of heredocs.splice(0)) i = skipHeredoc(src, i, doc);
    } else if (src.startsWith('((', i)) {
      const innerClose = closing(src, i + 2, ')');
      if (src[innerClose + 1] === ')') {
        i = innerClose + 2;
        tokens.push({ t: 'word', word: { parts: [{ kind: 'lit', text: '((…))' }], raw: '((…))' } });
      } else {
        tokens.push({ t: 'op', op: '(' }, { t: 'op', op: '(' });
        i += 2;
      }
    } else {
      const long = LONG_OPERATORS.find((op) => src.startsWith(op, i));
      const redirect = long ? undefined : REDIRECTS.find((op) => src.startsWith(op, i));
      const short = long || redirect ? undefined : SHORT_OPERATORS.find((op) => src.startsWith(op, i));
      if (long || short) {
        tokens.push({ t: 'op', op: (long ?? short)! });
        i += (long ?? short)!.length;
        continue;
      }
      if (redirect) {
        tokens.push({ t: 'redir', op: redirect });
        i += redirect.length;
        if (redirect === '<<' || redirect === '<<-') delimiterStrips = redirect === '<<-';
        continue;
      }
      const [word, end] = readWord(src, i);
      i = end;
      if (/^\d+$/.test(word.raw) && REDIRECTS.some((op) => src.startsWith(op, i))) continue;
      if (delimiterStrips !== null) {
        heredocs.push({ delimiter: literalText(word) ?? word.raw, strip: delimiterStrips });
        delimiterStrips = null;
      }
      tokens.push({ t: 'word', word });
    }
  }
  return tokens;
}

function skipHeredoc(src: string, start: number, doc: { delimiter: string; strip: boolean }): number {
  let i = start;
  while (i < src.length) {
    const end = src.indexOf('\n', i);
    const line = src.slice(i, end === -1 ? src.length : end);
    i = end === -1 ? src.length : end + 1;
    if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) return i;
  }
  return i;
}

function readWord(src: string, start: number): [Word, number] {
  const parts: Part[] = [];
  let lit = '';
  const push = (part: Part): void => {
    if (lit) parts.push({ kind: 'lit', text: lit });
    lit = '';
    parts.push(part);
  };
  let i = start;
  if (src[i] === '~' && (i + 1 === src.length || src[i + 1] === '/' || BREAKS.has(src[i + 1]!))) {
    parts.push({ kind: 'tilde' });
    i += 1;
  } else if (src[i] === '~' && /[A-Za-z0-9._-]/.test(src[i + 1] ?? '')) {
    parts.push({ kind: 'other' });
  }
  let quoted = false;
  while (i < src.length) {
    const c = src[i]!;
    if (!quoted && BREAKS.has(c)) break;
    if (!quoted && c === '$' && src[i + 1] === "'") {
      let end = i + 2;
      while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1;
      const body = src.slice(i + 2, end);
      if (body.includes('\\')) push({ kind: 'escape' });
      else lit += body;
      i = end + 1;
    } else if (c === '$') {
      const [part, next] = readDollar(src, i);
      if (part) push(part);
      else lit += '$';
      i = next;
    } else if (c === '`') {
      const end = closing(src, i + 1, '`');
      push({ kind: 'sub', body: src.slice(i + 1, end) });
      i = end + 1;
    } else if (quoted) {
      if (c === '"') {
        quoted = false;
        i += 1;
      } else if (c === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
        lit += src[i + 1];
        i += 2;
      } else {
        lit += c;
        i += 1;
      }
    } else if (c === '"') {
      quoted = true;
      i += 1;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      lit += src.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '\\') {
      lit += src[i + 1] ?? '';
      i += 2;
    } else if (c === '*' || c === '?' || c === '[') {
      push({ kind: 'glob' });
      i += 1;
    } else {
      lit += c;
      i += 1;
    }
  }
  if (lit) parts.push({ kind: 'lit', text: lit });
  return [{ parts, raw: src.slice(start, i) }, i];
}

function readDollar(src: string, i: number): [Part | null, number] {
  const next = src[i + 1];
  if (next === '(' && src[i + 2] === '(') {
    const end = src.indexOf('))', i + 3);
    return [{ kind: 'var', name: '((…))' }, end === -1 ? src.length : end + 2];
  }
  if (next === '(') {
    const end = closing(src, i + 2, ')');
    return [{ kind: 'sub', body: src.slice(i + 2, end) }, end + 1];
  }
  if (next === '{') {
    const end = src.indexOf('}', i + 2);
    const inner = src.slice(i + 2, end === -1 ? src.length : end);
    return [{ kind: 'var', name: NAME.exec(inner)?.[0] ?? inner }, end === -1 ? src.length : end + 1];
  }
  const name = NAME.exec(src.slice(i + 1))?.[0];
  if (name) return [{ kind: 'var', name }, i + 1 + name.length];
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return [{ kind: 'var', name: next }, i + 2];
  return [null, i + 1];
}

function closing(src: string, from: number, close: ')' | '`'): number {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      i += 1;
    } else if (close === '`') {
      if (c === '`') return i;
    } else if (c === "'" || c === '"') {
      i = quoteEnd(src, i, c);
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return src.length;
}

function quoteEnd(src: string, open: number, quote: string): number {
  for (let i = open + 1; i < src.length; i += 1) {
    if (src[i] === '\\' && quote === '"') i += 1;
    else if (src[i] === quote) return i;
  }
  return src.length;
}

function simpleCommand(words: Word[], redirects: Redirect[], state: State, depth: number): void {
  for (const word of [...words, ...redirects.flatMap((redirect) => (redirect.word ? [redirect.word] : []))]) {
    for (const part of word.parts) {
      if (part.kind !== 'sub') continue;
      state.cwd.push(cwdOf(state));
      run(part.body, state, depth + 1);
      state.cwd.pop();
    }
  }
  let args = words;
  while (args.length > 0 && KEYWORDS.has(literalText(args[0]!) ?? '')) args = args.slice(1);
  if (args[0]?.raw === '[[') return;
  for (const redirect of redirects) redirectTarget(redirect, state);
  while (args.length > 0 && isAssignment(args[0]!)) {
    assign(args[0]!, state);
    args = args.slice(1);
  }
  args = unwrap(args);
  const name = literalText(args[0] ?? EMPTY);
  if (!name) return;
  command(posix.basename(name), args.slice(1), state, depth);
}

function command(name: string, args: Word[], state: State, depth: number): void {
  switch (name) {
    case 'cd':
      changeDirectory(args, state);
      return;
    case 'rm':
    case 'rmdir':
    case 'unlink':
      for (const word of operands(args, [])) addTarget(word, state, { deleting: true });
      return;
    case 'tee':
      for (const word of operands(args, [])) addTarget(word, state);
      return;
    case 'source':
    case '.':
      state.targets.push(unresolved(name, `${name} runs a script the IDE cannot read`));
      return;
    case 'touch':
      for (const word of operands(args, ['-t', '-d', '-r'])) addTarget(word, state);
      return;
    case 'mkdir':
      for (const word of operands(args, ['-m'])) addTarget(word, state, { mkdir: true });
      return;
    case 'truncate':
      for (const word of operands(args, ['-s', '-r'])) addTarget(word, state);
      return;
    case 'chmod': {
      const byReference = args.some((word) => literalText(word)?.startsWith('--reference') ?? false);
      const words = chmodOperands(args);
      for (const word of byReference ? words : words.slice(1)) addTarget(word, state);
      return;
    }
    case 'chown':
    case 'chgrp': {
      const byReference = args.some((word) => literalText(word)?.startsWith('--reference') ?? false);
      const words = operands(args, []);
      for (const word of byReference ? words : words.slice(1)) addTarget(word, state);
      return;
    }
    case 'mv':
    case 'cp':
      moveOrCopy(name, args, state);
      return;
    case 'sed':
      sedInPlace(args, state);
      return;
    case 'git':
      git(args, state);
      return;
    case 'find':
      find(args, state);
      return;
    case 'xargs':
      if (
        args.some((word) => {
          const base = posix.basename(literalText(word) ?? '');
          return WRITERS.has(base) || SHELLS.has(base);
        })
      ) {
        state.targets.push(unresolved('xargs', 'xargs runs a command that writes files it reads from its input'));
      }
      return;
    case 'eval':
      state.targets.push(unresolved('eval', 'eval runs text the IDE cannot read'));
      return;
    default:
      if (ENV_SETTERS.has(name)) {
        for (const word of args) if (isAssignment(word)) assign(word, state);
        return;
      }
      if (SHELLS.has(name)) nestedShell(args, state, depth);
  }
}

function operands(args: Word[], valueOptions: string[]): Word[] {
  const found: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === '--') return [...found, ...args.slice(i + 1)];
    if (text !== null && text.startsWith('-') && text !== '-') {
      if (valueOptions.includes(text)) i += 1;
      continue;
    }
    found.push(args[i]!);
  }
  return found;
}

function chmodOperands(args: Word[]): Word[] {
  const found: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === '--') return [...found, ...args.slice(i + 1)];
    if (text !== null && (CHMOD_OPTIONS.has(text) || text.startsWith('--reference'))) continue;
    found.push(args[i]!);
  }
  return found;
}

function moveOrCopy(name: string, args: Word[], state: State): void {
  let into: Word | null = null;
  let intoFile = false;
  const words: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (text === '-t' || text === '--target-directory') {
      into = args[i + 1] ?? null;
      i += 1;
    } else if (text?.startsWith('--target-directory=')) {
      into = literalWord(text.slice('--target-directory='.length));
    } else if (text !== null && /^-t.+/.test(text)) {
      into = literalWord(text.slice(2));
    } else if (text === '-T' || text === '--no-target-directory') {
      intoFile = true;
    } else if (text === '-S' || text === '--suffix') {
      i += 1;
    } else if (!(text !== null && text.startsWith('-') && text !== '-')) {
      words.push(args[i]!);
    }
  }
  const destination = into ?? words.pop();
  if (!destination) return;
  if (name === 'mv') for (const source of words) addTarget(source, state, { deleting: true });
  const names = words.map((source) => {
    const value = wordValue(source, state);
    return 'text' in value ? posix.basename(value.text) : null;
  });
  addTarget(destination, state, { names: intoFile || names.includes(null) ? [] : (names as string[]) });
}

function sedInPlace(args: Word[], state: State): void {
  let inPlace = false;
  let scriptGiven = false;
  const words: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (text === '--in-place' || text?.startsWith('--in-place=')) {
      inPlace = true;
    } else if (text !== null && /^-[A-Za-z]*i/.test(text) && !text.startsWith('--')) {
      inPlace = true;
      // BSD sed takes the backup suffix as a separate argument: sed -i '' …
      if (text === '-i' && args[i + 1] !== undefined && literalText(args[i + 1]!) === '') i += 1;
    } else if (text === '-e' || text === '-f' || text === '--expression' || text === '--file') {
      scriptGiven = true;
      i += 1;
    } else if (text?.startsWith('--expression=') || text?.startsWith('--file=')) {
      scriptGiven = true;
    } else if (text === '-l' || text === '--line-length') {
      i += 1;
    } else if (!(text !== null && text.startsWith('-') && text !== '-')) {
      words.push(args[i]!);
    }
  }
  if (!inPlace) return;
  for (const word of scriptGiven ? words : words.slice(1)) addTarget(word, state);
}

function git(args: Word[], state: State): void {
  let i = 0;
  while (i < args.length) {
    const text = literalText(args[i]!);
    if (text === '-C' || text === '-c' || text === '--git-dir' || text === '--work-tree' || text === '--namespace') i += 2;
    else if (text !== null && text.startsWith('-')) i += 1;
    else break;
  }
  const word = args[i];
  if (!word) return;
  const sub = literalText(word);
  if (sub === null) state.targets.push(unresolved(word.raw, 'a git command the IDE cannot read'));
  else if (WORK_TREE_REWRITES.has(sub)) state.allTracked = true;
  else if (sub === 'mv') moveOrCopy('mv', args.slice(i + 1), state);
  else if (sub === 'rm') {
    const rest = args.slice(i + 1);
    if (rest.some((arg) => literalText(arg) === '--cached')) return;
    for (const target of operands(rest, [])) addTarget(target, state, { deleting: true });
  }
}

function find(args: Word[], state: State): void {
  const texts = args.map((word) => literalText(word));
  if (texts.includes('-delete')) {
    state.targets.push(unresolved('find', 'find deletes or changes the files it finds'));
    return;
  }
  for (let i = 0; i < args.length; i += 1) {
    const text = texts[i];
    if (text !== '-exec' && text !== '-execdir' && text !== '-ok' && text !== '-okdir') continue;
    const rest = unwrap(args.slice(i + 1));
    const base = posix.basename(literalText(rest[0] ?? EMPTY) ?? '');
    if (WRITERS.has(base) || SHELLS.has(base)) {
      state.targets.push(unresolved('find', 'find deletes or changes the files it finds'));
      return;
    }
  }
}

function nestedShell(args: Word[], state: State, depth: number): void {
  const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(literalText(word) ?? ''));
  if (flag === -1) return;
  const script = args[flag + 1];
  if (script !== undefined && literalText(script) === '--') {
    state.targets.push(unresolved('--', 'a shell script the IDE cannot read'));
    return;
  }
  const text = script ? literalText(script) : null;
  if (text === null) {
    state.targets.push(unresolved(script?.raw ?? '-c', 'a shell script the IDE cannot read'));
    return;
  }
  state.cwd.push(cwdOf(state));
  run(text, state, depth + 1);
  state.cwd.pop();
}

function changeDirectory(args: Word[], state: State): void {
  const [first] = operands(args, []);
  const top = state.cwd.length - 1;
  if (!first) {
    state.cwd[top] = state.env.home;
    return;
  }
  const value = wordValue(first, state);
  const current = state.cwd[top] ?? null;
  const known = 'text' in value && value.text !== '-' && (value.text.startsWith('/') || current !== null);
  state.cwd[top] = known ? posix.resolve(current ?? '/', value.text) : null;
}

function redirectTarget(redirect: Redirect, state: State): void {
  if (!redirect.word) return;
  if (FILE_REDIRECTS.has(redirect.op)) {
    addTarget(redirect.word, state);
    return;
  }
  if (redirect.op !== '>&') return;
  const text = literalText(redirect.word);
  if (text !== null && (/^\d+$/.test(text) || text === '-')) return;
  addTarget(redirect.word, state);
}

function wordValue(word: Word, state: State): WordValue {
  let text = '';
  for (const [index, part] of word.parts.entries()) {
    if (part.kind === 'lit') text += part.text;
    else if (part.kind === 'tilde') {
      if (state.poisoned.has('HOME')) return { problem: 'the variable $HOME' };
      text += state.env.home;
    } else if (part.kind === 'other') return { problem: "another user's home directory" };
    else if (part.kind === 'escape') return { problem: 'an escape sequence in a $\'…\' string' };
    else if (part.kind === 'glob') return { problem: 'a wildcard' };
    else if (part.kind === 'sub') return { problem: 'command substitution' };
    else if (text === '' && state.mktemp.has(part.name)) return tempValue(word.parts.slice(index + 1));
    else if (state.poisoned.has(part.name)) return { problem: `the variable $${part.name}` };
    else if (part.name === 'HOME') text += state.env.home;
    else if ((part.name === 'TMPDIR' || part.name === 'TMP') && state.env.vars[part.name]) text += state.env.vars[part.name];
    else return { problem: `the variable $${part.name}` };
  }
  return { text };
}

function tempValue(rest: Part[]): WordValue {
  if (rest.some((part) => part.kind !== 'lit')) return { temp: true };
  const tail = rest.map((part) => (part as { text: string }).text).join('');
  const inside = posix.normalize(`/t${tail}`);
  return inside === '/t' || inside.startsWith('/t/') ? { temp: true } : { problem: 'a path that leaves its temporary directory' };
}

function addTarget(word: Word, state: State, extra: TargetExtra = {}): void {
  const base = { word: word.raw, mkdir: extra.mkdir ?? false, deleting: extra.deleting ?? false, names: extra.names ?? [] };
  const value = wordValue(word, state);
  if ('temp' in value) {
    state.targets.push({ ...base, path: null, temp: true, unresolved: null });
    return;
  }
  if ('problem' in value) {
    state.targets.push({ ...base, path: null, temp: false, unresolved: value.problem });
    return;
  }
  if (value.text === '' || DEVICE.test(value.text)) return;
  const cwd = cwdOf(state);
  if (!value.text.startsWith('/') && cwd === null) {
    state.targets.push({ ...base, path: null, temp: false, unresolved: 'a relative path after a cd the IDE cannot follow' });
    return;
  }
  state.targets.push({ ...base, path: posix.resolve(cwd ?? '/', value.text), temp: false, unresolved: null });
}

function unwrap(args: Word[]): Word[] {
  let i = 0;
  for (;;) {
    const name = literalText(args[i] ?? EMPTY);
    if (!name || !WRAPPERS.has(posix.basename(name))) return args.slice(i);
    const base = posix.basename(name);
    const acceptsAssignments = base === 'env' || base === 'sudo';
    i += 1;
    while (i < args.length) {
      const word = args[i]!;
      if (acceptsAssignments && isAssignment(word)) {
        i += 1;
        continue;
      }
      const text = literalText(word);
      if (text !== null && text.startsWith('-')) {
        i += text === '-n' || text === '-u' || text === '-g' || (base === 'exec' && text === '-a') ? 2 : 1;
      } else {
        break;
      }
    }
  }
}

function assign(word: Word, state: State): void {
  const first = word.parts[0] as { kind: 'lit'; text: string };
  const name = first.text.slice(0, first.text.indexOf('='));
  const rest = first.text.slice(name.length + 1);
  const value = [...(rest ? [{ kind: 'lit', text: rest } as Part] : []), ...word.parts.slice(1)];
  const only = value.length === 1 ? value[0] : undefined;
  if (only?.kind === 'sub' && isPlainMktemp(only.body)) state.mktemp.add(name);
  else state.mktemp.delete(name);
  if (PROTECTED_VARS.has(name)) state.poisoned.add(name);
}

function isPlainMktemp(body: string): boolean {
  const words = lex(body.trim()).map((token) => (token.t === 'word' ? literalText(token.word) : null));
  if (words[0] !== 'mktemp' || words.some((word) => word === null)) return false;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] === '-t') i += 1;
    else if (!PLAIN_MKTEMP_FLAGS.has(words[i]!)) return false;
  }
  return true;
}

function isAssignment(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === 'lit' && ASSIGNMENT.test(first.text);
}

function literalText(word: Word): string | null {
  let text = '';
  for (const part of word.parts) {
    if (part.kind !== 'lit') return null;
    text += part.text;
  }
  return text;
}

const literalWord = (text: string): Word => ({ parts: [{ kind: 'lit', text }], raw: text });
const cwdOf = (state: State): string | null => state.cwd[state.cwd.length - 1] ?? null;
const unresolved = (word: string, reason: string): ShellTarget => ({ word, path: null, temp: false, mkdir: false, deleting: false, names: [], unresolved: reason });
