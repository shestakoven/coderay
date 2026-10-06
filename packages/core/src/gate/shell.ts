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
  // The directory each work-tree rewrite and each history command runs in; null when the command does not say.
  rewrites: (string | null)[];
  history: (string | null)[];
  // For each history command, the commits it brings into the work tree besides HEAD; null when the command does not say which.
  incoming: (string[] | null)[];
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
  rewrites: (string | null)[];
  history: (string | null)[];
  incoming: (string[] | null)[];
  // Whether every command so far only moves history or reads.
  pure: boolean;
  // A GIT_ variable was set, so git may run on another repository or index than its directory says.
  gitEnv: boolean;
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
const HISTORY_VERBS = new Set(['checkout', 'switch', 'reset', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert']);
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'fetch', 'branch', 'ls-files', 'rev-list', 'describe', 'merge-base']);
const HARMLESS = new Set(['cd', 'pwd', 'echo', 'printf', 'true', 'false', ':', 'sleep', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'test', '[', 'set', 'exit', 'fi', 'done', 'which']);
// Options whose value is the next word, among the history commands'.
const VALUE_OPTIONS = new Set(['-b', '-B', '-c', '-C', '--orphan', '-m', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--onto', '--into-name']);
const WORK_TREE_REWRITES = new Set(['restore', 'stash', 'clean', 'apply', 'am']);
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'tee', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'chgrp', 'sed', 'ln', 'install', 'dd']);
const XARGS_WRITES = 'xargs runs a command that writes files it reads from its input';
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PLAIN_MKTEMP_FLAGS = new Set(['-d', '-q', '-u', '--directory', '--quiet', '--dry-run', '--tmpdir']);
const CHMOD_OPTIONS = new Set(['-c', '--changes', '-f', '--silent', '--quiet', '-v', '--verbose', '--no-preserve-root', '--preserve-root', '-R', '--recursive', '-H', '-L', '-P', '-h', '--help', '--version']);
const PROTECTED_VARS = new Set(['HOME', 'TMPDIR', 'TMP']);
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const DEVICE = /^\/dev\/(null|stdout|stderr|tty|zero|fd\/\d+)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 8;
const TEMP_ROOT = '/\0temp';
const EMPTY: Word = { parts: [], raw: '' };

export function shellWrites(command: string, cwd: string, env: ShellEnv): ShellWrites {
  const state: State = { env, cwd: [cwd], mktemp: new Set(), poisoned: new Set(), targets: [], rewrites: [], history: [], incoming: [], pure: true, gitEnv: false };
  run(command, state, 0);
  // History is spared only in a command that can write nothing else: a commit built with plumbing and reset onto in one call is the agent's.
  const pure = state.pure && state.targets.length === 0;
  const rewrites = pure ? state.rewrites : [...state.rewrites, ...state.history];
  const history = pure ? state.history : [];
  return { targets: state.targets, allTracked: rewrites.length + history.length > 0, rewrites, history, incoming: pure ? state.incoming : [] };
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
  const wrapped = unwrap(args);
  for (const word of args.slice(0, args.length - wrapped.length)) {
    if (isAssignment(word)) assign(word, state);
    else if (['env', 'sudo'].includes(posix.basename(literalText(word) ?? ''))) state.pure = false;
  }
  if (wrapped.length === 0) return;
  const name = literalText(wrapped[0]!);
  if (name === null || (posix.basename(name) !== 'git' && !HARMLESS.has(posix.basename(name)))) state.pure = false;
  if (name) command(posix.basename(name), wrapped.slice(1), state, depth);
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
    case 'xargs': {
      const gitAt = args.findIndex((word) => literalText(word) === 'git');
      if (gitAt !== -1) {
        xargsGit(args.slice(gitAt + 1), state);
        return;
      }
      if (
        args.some((word) => {
          const base = posix.basename(literalText(word) ?? '');
          return WRITERS.has(base) || SHELLS.has(base);
        })
      ) {
        state.targets.push(unresolved('xargs', XARGS_WRITES));
      }
      return;
    }
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
    } else if (text !== null && /^-[fvinuRrpaTbdlHLPsxZ]+t$/.test(text)) {
      into = args[i + 1] ?? null;
      i += 1;
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
    // Configuration given on the command line can run any program: hooks, aliases, editors, merge drivers.
    if (text === null || text === '-c' || /^--(config-env|exec-path)(=|$)/.test(text)) state.pure = false;
    if (text === '-C' || text === '-c' || text === '--git-dir' || text === '--work-tree' || text === '--namespace') i += 2;
    else if (text !== null && text.startsWith('-')) i += 1;
    else break;
  }
  const word = args[i];
  if (!word) return;
  const sub = literalText(word);
  const rest = args.slice(i + 1);
  if (sub === null || !(HISTORY_VERBS.has(sub) || GIT_READS.has(sub)) || rest.some((arg) => runsCommand(sub, literalText(arg)))) state.pure = false;
  if (sub === null) state.targets.push(unresolved(word.raw, 'a git command the IDE cannot read'));
  else if (sub === 'checkout' && checksOutPaths(rest)) state.rewrites.push(gitDirectory(args.slice(0, i), state));
  else if (HISTORY_VERBS.has(sub)) {
    state.history.push(gitDirectory(args.slice(0, i), state));
    state.incoming.push(incomingRefs(sub, rest));
  }
  else if (WORK_TREE_REWRITES.has(sub)) {
    if (!(sub === 'apply' && appliesToIndexOnly(rest))) state.rewrites.push(gitDirectory(args.slice(0, i), state));
  }
  else if (sub === 'mv' || sub === 'rm') gitPaths(sub, args.slice(0, i), rest, state);
}

const runsCommand = (sub: string, arg: string | null): boolean =>
  arg !== null && (/^--(exec|upload-pack)(=|$)/.test(arg) || (sub === 'rebase' && /^-[^-]*x/.test(arg)));

// checkout <tree-ish> <paths>, checkout -- <paths> and their kin write files and leave HEAD where it is.
function checksOutPaths(rest: Word[]): boolean {
  let operands = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const text = literalText(rest[i]!);
    if (text === '--' || text === '-p' || text === '--patch' || text?.startsWith('--pathspec-from-file')) return true;
    if (text !== null && VALUE_OPTIONS.has(text)) i += 1;
    else if (text === null || !text.startsWith('-') || text === '-') operands += 1;
  }
  return operands > 1;
}

// The commits a history command brings into the work tree besides HEAD; null when the words do not say (a variable, a sequencer step).
function incomingRefs(sub: string, rest: Word[]): string[] | null {
  const words: string[] = [];
  const flags = new Set<string>();
  let onto: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const text = literalText(rest[i]!);
    if (text === null) return null;
    if (text === '--') break;
    if (text === '--onto' || text.startsWith('--onto=')) {
      onto = text === '--onto' ? literalText(rest[i + 1] ?? EMPTY) : text.slice('--onto='.length);
      if (!onto) return null;
    }
    if (VALUE_OPTIONS.has(text)) i += 1;
    else if (text === '-') words.push('@{-1}');
    else if (text.startsWith('-')) flags.add(text.split('=')[0]!);
    else words.push(text);
  }
  if (flags.has('--quit') || (sub === 'merge' && (flags.has('--abort') || flags.has('--continue')))) return [];
  if (flags.has('--continue') || flags.has('--skip') || flags.has('--abort')) return null;
  switch (sub) {
    case 'checkout':
    case 'switch':
      return words.slice(0, 1);
    case 'reset':
      return ['--hard', '--merge', '--keep'].some((flag) => flags.has(flag)) ? words.slice(0, 1) : [];
    case 'merge':
      return words.length > 0 ? words : ['@{upstream}'];
    case 'pull':
      if (words.length < 2) return ['@{upstream}'];
      return words.slice(1).some((ref) => ref.includes(':')) ? null : words.slice(1).map((ref) => `${words[0]}/${ref}`);
    case 'rebase':
      return [onto ?? words[0] ?? '@{upstream}', ...words.slice(1, 2)];
    case 'revert':
      return words.flatMap((ref) => [ref, `${ref}^`]);
    default:
      return words;
  }
}

// Where git runs: the working directory moved by each -C; unknown for a repository chosen any other way.
function gitDirectory(options: Word[], state: State): string | null {
  if (state.gitEnv) return null;
  let dir = cwdOf(state);
  for (let i = 0; i < options.length; i += 1) {
    const text = literalText(options[i]!);
    if (text !== null && /^--(git-dir|work-tree)(=|$)/.test(text)) return null;
    if (text !== '-C') continue;
    const value = options[i + 1] === undefined ? null : literalText(options[i + 1]!);
    if (value === null || (dir === null && !value.startsWith('/'))) return null;
    dir = posix.resolve(dir ?? '/', value);
  }
  return dir;
}

// git xargs reads the paths from its input, so only a command that writes none of them is known to be harmless.
function xargsGit(args: Word[], state: State): void {
  const sub = args.map((word) => literalText(word)).find((text) => text === null || !text.startsWith('-'));
  const indexOnly = sub === 'rm' && removesFromIndexOnly(args.slice(args.findIndex((word) => literalText(word) === 'rm') + 1));
  if ((sub === 'rm' && !indexOnly) || sub === 'mv') state.targets.push(unresolved('xargs', XARGS_WRITES));
  else git(args, state);
}

// --cached before any -- changes the index only; after it, --cached names a file.
function removesFromIndexOnly(rest: Word[]): boolean {
  const end = rest.findIndex((arg) => literalText(arg) === '--');
  return (end === -1 ? rest : rest.slice(0, end)).some((arg) => literalText(arg) === '--cached');
}

function appliesToIndexOnly(rest: Word[]): boolean {
  const options = rest.map((arg) => literalText(arg));
  return options.includes('--cached') && !options.includes('--index');
}

function gitPaths(sub: 'mv' | 'rm', global: Word[], rest: Word[], state: State): void {
  const redirected = state.gitEnv || global.some((arg) => /^(-C|--git-dir|--work-tree)/.test(literalText(arg) ?? ''));
  const fromFile = rest.some((arg) => literalText(arg)?.startsWith('--pathspec-from-file') ?? false);
  if (redirected || fromFile) {
    state.targets.push(unresolved(`git ${sub}`, redirected ? `git ${sub} runs in another directory` : `git ${sub} reads its paths from a file`));
    return;
  }
  if (sub === 'mv') {
    moveOrCopy('mv', rest, state);
    return;
  }
  if (removesFromIndexOnly(rest)) return;
  for (const target of operands(rest, [])) addTarget(target, state, { deleting: true });
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
  const leaves = { problem: 'a path that leaves its temporary directory' };
  let tail = '';
  let dotted = false;
  for (const part of rest) {
    if (part.kind === 'lit') {
      tail += part.text;
      dotted ||= part.text.split('/').includes('..');
    } else if (dotted) {
      return leaves;
    } else {
      tail += '\0';
    }
  }
  const inside = posix.normalize(`${TEMP_ROOT}${tail}`);
  return inside === TEMP_ROOT || inside.startsWith(`${TEMP_ROOT}/`) ? { temp: true } : leaves;
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
  // A variable can point git at another repository, index or editor, or put another program on the PATH.
  state.pure = false;
  if (name.startsWith('GIT_')) state.gitEnv = true;
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
