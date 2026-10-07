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
  // The directories each work-tree rewrite and each history command may run in; null when the command does not say.
  rewrites: (string | null)[];
  history: (string | null)[];
  // For each history command, the commits it brings into the work tree besides HEAD; null when the command does not say which.
  incoming: (string[] | null)[];
  // The directories of history commands in a call that is not pure only because it writes named files: judged as rewrites, but what git
  // moves there is still git's, and what the writers name is the agent's.
  moves: (string | null)[];
}

type Part =
  | { kind: 'lit'; text: string }
  | { kind: 'tilde' }
  // Text bash builds from how the word is spelled, which CodeRay does not work out; dash when it may begin with -.
  | { kind: 'unread'; what: string; dash: boolean }
  // modified: an operator in ${…} (%, #, /, :-, [i] …) makes the value something other than the variable's.
  | { kind: 'var'; name: string; modified?: boolean }
  | { kind: 'glob' }
  | { kind: 'sub'; body: string; open?: boolean };

interface Word {
  parts: Part[];
  raw: string;
}

// A sub token is a command substitution outside any word: in a heredoc body or in (( )).
type Token = { t: 'word'; word: Word } | { t: 'op'; op: string } | { t: 'redir'; op: string } | { t: 'sub'; body: string };

interface Heredoc {
  delimiter: string;
  strip: boolean;
  quoted: boolean;
}

interface Redirect {
  op: string;
  word: Word | null;
}

interface State {
  env: ShellEnv;
  // Per subshell level, every directory bash may be in.
  cwd: (string | null)[][];
  // How deep in if, while, for, case, a function or a { } group the command is; after a function is defined, never back to 0.
  nesting: number;
  mktemp: Set<string>;
  poisoned: Set<string>;
  // Loop variables whose every value CodeRay can read: for NAME in a b c.
  loops: Map<string, string[]>;
  // A construct ran or may run that changes a variable without an assignment CodeRay reads: no loop variable is known from then on.
  loopsOff: boolean;
  targets: ShellTarget[];
  rewrites: (string | null)[];
  history: (string | null)[];
  incoming: (string[] | null)[];
  // Whether every command so far only moves history or reads.
  pure: boolean;
  // Whether a command ran that may write what no target names, or commit or stash what it wrote: an unknown program, a sed that may write, plumbing, configuration, a function, git add or commit.
  wild: boolean;
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
const OPENERS = new Set(['{', 'if', 'while', 'until', 'for', 'case', 'select', 'function']);
const CLOSERS = new Set(['}', 'fi', 'done', 'esac']);
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'env']);
const HISTORY_VERBS = new Set(['checkout', 'switch', 'reset', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert']);
// Reads write no file but --output, and run no program but what the repository's own configuration names.
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'rev-list', 'describe', 'merge-base', 'stash list', 'stash show']);
const HARMLESS = new Set(['cd', 'pwd', 'echo', 'true', 'false', ':', 'sleep', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'test', '[', 'set', 'exit', 'fi', 'done', 'which']);
// Programs that only read and print; what they print goes through a redirect, which is a target of its own.
const READERS = new Set(['cut', 'tr', 'diff', 'jq', 'stat', 'basename', 'dirname']);
// Readers with an option that writes a file or runs a program: sort -o and --compress-program, rg --pre and --hostname-bin.
const READERS_UNLESS = new Map([
  ['sort', /^(-[A-Za-z]*o|--[oc])/],
  ['rg', /^--(pre|host)/],
]);
// A sed script that cannot write a file or run a command: one p, d, q, Q or = or s command with an address that selects lines, and for s no w or e flag.
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/[Im]*)`;
const READING_SED = new RegExp(String.raw`^\s*(?:${SED_ADDRESS}(?:,(?:${SED_ADDRESS}|\+\d+))?!?)?\s*(?:[pdqQ=]|s([^\s\\])(?:(?!\1)[^\n])*\1(?:(?!\1)[^\n])*\1[gpiImM0-9]*)\s*$`);
const READING_SED_OPTIONS = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data', '--posix', '--unbuffered', '--debug', '--sandbox']);
// The options git takes before its command, with = after those that take a value; after any other one CodeRay cannot tell which command runs.
const GLOBAL_OPTIONS = optionTable('-C= -c= --git-dir= --work-tree= --namespace= --config-env= --attr-source= --exec-path --bare -P --no-pager -p --paginate --no-optional-locks --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-replace-objects --no-advice -v --version -h --help');
// Of those, the ones that run no program of the agent's choosing and leave refs and attributes as they are; -c only with a quiet editor or pager.
const PURE_GLOBALS = new Set(['-C', '--git-dir', '--work-tree', '-P', '--no-pager', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--no-advice', '-v', '--version', '-h', '--help']);
// Per git command that leaves a command pure, the options known to run no program of the agent's choosing and to write nothing more,
// with = after those that always take one (an optional value goes after =). Any other option, an abbreviation git accepts included,
// makes the command impure.
// git add, commit and stash only move content the gated work tree already had.
const SAFE_OPTIONS = new Map(Object.entries({
  checkout: '-q --quiet -f --force -m --merge --detach -t --track --no-track --guess --no-guess --progress --no-progress -b= -B= --orphan=',
  switch: '-q --quiet -f --force --discard-changes -m --merge -d --detach -t --track --no-track --guess --no-guess --progress --no-progress -c= -C= --create= --force-create= --orphan=',
  reset: '-q --quiet --hard --soft --mixed --merge --keep',
  merge: '-q --quiet -v --verbose --ff --no-ff --ff-only --commit --no-commit --squash --no-squash --no-edit --stat -n --no-stat --log --no-log --autostash --no-autostash --allow-unrelated-histories --no-verify --abort --continue --quit -m= -F= --file= -X= --strategy-option= --into-name=',
  pull: '-q --quiet -v --verbose -r --rebase --no-rebase --ff --no-ff --ff-only --commit --no-commit --squash --no-squash --no-edit --stat -n --no-stat --autostash --no-autostash --allow-unrelated-histories --no-verify --all -p --prune -t --tags --no-tags --unshallow -X= --strategy-option= --depth=',
  rebase: '-q --quiet -v --verbose -i --interactive --autosquash --no-autosquash --autostash --no-autostash -m --merge -r --rebase-merges --no-rebase-merges --update-refs --no-update-refs --keep-base --root --fork-point --no-fork-point --stat -n --no-stat -f --force-rebase --no-ff --no-verify --verify --reapply-cherry-picks --no-reapply-cherry-picks --committer-date-is-author-date --ignore-date --reset-author-date --signoff --continue --skip --abort --quit --onto= -X= --strategy-option= --empty',
  'cherry-pick': '-n --no-commit -x --ff --allow-empty --allow-empty-message --keep-redundant-commits -s --signoff --continue --skip --abort --quit -m= --mainline= -X= --strategy-option= --empty',
  revert: '-n --no-commit --no-edit -s --signoff --continue --skip --abort --quit -m= --mainline= -X= --strategy-option=',
  add: '-A --all -u --update -f --force -n --dry-run -v --verbose -N --intent-to-add --no-all --ignore-removal --ignore-errors',
  commit: '-a --all -q --quiet -v --verbose --amend --no-edit -s --signoff -n --no-verify --verify --allow-empty --allow-empty-message --reset-author -o --only -i --include -m= --message= -F= --file= --author= --date= --fixup= --squash=',
  'stash push': '-q --quiet -k --keep-index --no-keep-index -m= --message=',
  'stash pop': '-q --quiet --index',
  'stash apply': '-q --quiet --index',
  'stash drop': '-q --quiet',
  fetch: '-q --quiet -v --verbose --all --multiple -p --prune -P --prune-tags -t --tags -n --no-tags --unshallow --dry-run --progress --no-progress -f --force --atomic --no-recurse-submodules --depth= --deepen=',
  push: '-q --quiet -v --verbose -u --set-upstream -f --force --force-with-lease --force-if-includes --tags --follow-tags --no-verify -n --dry-run --atomic -d --delete --progress --no-progress --porcelain',
  branch: '-a --all -r --remotes -v --verbose -l --list --show-current --contains --no-contains --merged --no-merged -i --ignore-case --color --no-color --column --no-column -q --quiet -t --track --no-track --no-abbrev --points-at= --sort= --format= --abbrev',
  tag: '-l --list --contains --no-contains --merged --no-merged -i --ignore-case --color --no-color --column --no-column --points-at= --sort= --format=',
  remote: '-v --verbose -n --push --all',
  config: '--get --get-all --get-regexp --get-urlmatch -l --list --local --global --system --worktree --show-origin --show-scope --name-only -z --null --bool --int --path --includes --no-includes --default= --type=',
}).map(([verb, spec]) => [verb, optionTable(spec)]));
const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list'];
// Editors and pagers that do nothing or only print, so setting one runs no program of the agent's choosing.
const QUIET_SETTINGS = new Set(['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'EDITOR', 'VISUAL', 'PAGER', 'core.editor', 'sequence.editor', 'core.pager']);
const QUIET_PROGRAMS = new Set(['true', ':', 'cat']);
const WORK_TREE_REWRITES = new Set(['restore', 'stash', 'clean', 'apply', 'am']);
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'tee', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'chgrp', 'sed', 'ln', 'install', 'dd']);
// The writers whose args name every file they write (not sed, whose script writes any file with w, e or a backup suffix).
const NAMING_WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'tee', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'chgrp']);
// The long options of cp and mv that write nothing besides the files they name; GNU getopt accepts any abbreviation of --backup and --suffix, which write a backup under a name of their own.
const NAMING_LONG_OPTIONS = new Set(['--target-directory', '--no-target-directory', '--force', '--interactive', '--no-clobber', '--verbose', '--recursive', '--archive', '--update', '--parents']);
const BACKUP_SHORT_OPTION = /^-[A-Za-z]*[bS]/;
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
const MAX_LOOP_PATHS = 32;
// Words that read or assign a variable behind an assignment CodeRay reads: arithmetic (let, the operands of -eq and the like), select, read and its kin, eval and source, a trap or an alias that runs later, a nameref.
const REBINDERS = new Set(['select', 'let', 'eval', 'source', '.', 'trap', 'alias', 'read', 'mapfile', 'readarray', 'getopts', 'unset', 'wait', 'compgen', 'coproc', 'declare', 'typeset', 'local', 'function', '-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
// Values that stay one word with no wildcard, whatever the quoting of the variable.
const PLAIN_VALUE = /^[\w.,:@%+=/-]+$/;
const TEMP_ROOT = '/\0temp';
const EMPTY: Word = { parts: [], raw: '' };

export function shellWrites(command: string, cwd: string, env: ShellEnv): ShellWrites {
  const state: State = { env, cwd: [[cwd]], nesting: 0, mktemp: new Set(), poisoned: new Set(), loops: new Map(), loopsOff: false, targets: [], rewrites: [], history: [], incoming: [], pure: true, wild: false, gitEnv: false };
  run(command, state, 0);
  // History is spared only in a command that can write nothing else: a commit built with plumbing and reset onto in one call is the agent's.
  const pure = state.pure && state.targets.length === 0;
  const rewrites = pure ? state.rewrites : [...state.rewrites, ...state.history];
  const history = pure ? state.history : [];
  const named = !state.wild && state.targets.every((target) => target.unresolved === null);
  return { targets: state.targets, allTracked: rewrites.length + history.length > 0, rewrites, history, incoming: pure ? state.incoming : [], moves: pure || !named ? [] : state.history };
}

// The call is no longer pure; wild when what ran may also write files no target names.
function taint(state: State, wild = true): void {
  state.pure = false;
  state.wild ||= wild;
}

// A word CodeRay cannot read, and a long option it does not know exactly, may be a backup option.
function namesWhatItWrites(base: string, args: Word[]): boolean {
  if (!NAMING_WRITERS.has(base)) return false;
  if (base !== 'cp' && base !== 'mv') return true;
  return args.every((word) => {
    const text = literalText(word);
    return text !== null && !BACKUP_SHORT_OPTION.test(text) && (!text.startsWith('--') || text === '--' || NAMING_LONG_OPTIONS.has(text.split('=')[0]!));
  });
}

// Whether the program, called with these arguments, writes no file and runs nothing of the agent's choosing.
function readsOnly(base: string, args: Word[]): boolean {
  if (HARMLESS.has(base) || READERS.has(base)) return true;
  if (base === 'sed') return readingSed(args);
  const writing = READERS_UNLESS.get(base);
  return writing !== undefined && args.every((word) => {
    const text = literalText(word);
    return text !== null && !writing.test(text);
  });
}

// Whether the script has a construct that can change a variable without an assignment CodeRay reads.
function rebinds(tokens: Token[]): boolean {
  return tokens.some((token, i) => {
    const next = tokens[i + 1];
    if (token.t === 'op') {
      // ((…)), for ((…)) and name() { … }: a function may be called before the line that defines it, and sets any variable.
      return token.op === '(' && (next?.t === 'op' && (next.op === '(' || next.op === ')'));
    }
    if (token.t !== 'word') return false;
    const text = literalText(token.word);
    // Arithmetic hides in the spelling: $(( … )) nested in a substitution, $[ … ], and ${x:f=5}, ${a[f=5]} in a parameter expansion.
    if (token.word.raw.includes('((') || token.word.raw.includes('$[') || /\$\{[^}]*=/.test(token.word.raw)) return true;
    // exec {f}>file puts a descriptor number in f.
    if (next?.t === 'redir' && /^\{[A-Za-z_]\w*\}$/.test(token.word.raw)) return true;
    if (text === null) return false;
    if (text === '((…))' || REBINDERS.has(text) || /\[[^\]]*=/.test(text)) return true;
    return text === 'printf' && next?.t === 'word' && (literalText(next.word) ?? '').startsWith('-v');
  });
}

// A word CodeRay cannot read may be any option, so sed must have none; GNU sed takes options after operands and BSD sed does not, so none may follow an operand.
function readingSed(args: Word[]): boolean {
  const scripts: string[] = [];
  const words: string[] = [];
  let expressions = false;
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === null) return false;
    if (text === '--') {
      words.push(...args.slice(i + 1).map((word) => literalText(word) ?? ''));
      break;
    }
    if (words.length > 0 && text.startsWith('-') && text !== '-') return false;
    if (/^-[nErszu]*e$/.test(text) || text === '--expression') {
      const script = literalText(args[i + 1] ?? EMPTY);
      if (script === null || args[i + 1] === undefined) return false;
      scripts.push(script);
      expressions = true;
      i += 1;
    } else if (text.startsWith('--expression=')) {
      scripts.push(text.slice('--expression='.length));
      expressions = true;
    } else if (text.startsWith('-') && text !== '-') {
      if (!/^-[nErszu]+$/.test(text) && !READING_SED_OPTIONS.has(text)) return false;
    } else {
      words.push(text);
    }
  }
  if (!expressions) {
    const script = words.shift();
    if (script === undefined) return false;
    scripts.push(script);
  }
  return scripts.every((script) => READING_SED.test(script));
}

function run(script: string, state: State, depth: number): void {
  if (depth > MAX_DEPTH) {
    state.targets.push(unresolved(script.slice(0, 60), 'commands nested too deeply'));
    return;
  }
  const tokens = lex(script);
  if (rebinds(tokens)) state.loopsOff = true;
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let before = '';
  const flush = (after: string): void => {
    // A command after && or || may not run, and one in a pipeline or in the background runs in a subshell.
    const maybe = ['&&', '||', '|', '|&'].includes(before) || ['|', '|&', '&'].includes(after);
    const empty = words.length === 0 && redirects.length === 0;
    if (!empty) simpleCommand(words, redirects, state, depth, maybe);
    words = [];
    redirects = [];
    // A line break after && or || continues the list.
    if (!(empty && after === '\n')) before = after;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.t === 'word') {
      words.push(token.word);
    } else if (token.t === 'redir' && inTest(words)) {
      // In [[ ]], < and > compare strings.
      words.push(literalWord(token.op));
    } else if (token.t === 'redir') {
      const next = tokens[i + 1];
      redirects.push({ op: token.op, word: next?.t === 'word' ? next.word : null });
      if (next?.t === 'word') i += 1;
    } else if (token.t === 'sub') {
      state.cwd.push(cwdOf(state));
      run(token.body, state, depth + 1);
      state.cwd.pop();
    } else {
      const next = tokens[i + 1];
      // name() defines a function, which may shadow any command and run at any later point.
      if (token.op === '(' && words.length > 0 && next?.t === 'op' && next.op === ')') {
        words = [];
        taint(state);
        state.nesting += 1;
        i += 1;
        continue;
      }
      flush(token.op);
      if (token.op === '(') state.cwd.push(cwdOf(state));
      if (token.op === ')' && state.cwd.length > 1) state.cwd.pop();
    }
  }
  flush('');
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: Heredoc[] = [];
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
      for (const doc of heredocs.splice(0)) {
        const body = i;
        i = skipHeredoc(src, i, doc);
        // Bash runs $(…) and `…` in the body of a heredoc whose delimiter is not quoted.
        if (!doc.quoted) tokens.push(...substitutionsIn(src.slice(body, i)).map((text): Token => ({ t: 'sub', body: text })));
      }
    } else if (src.startsWith('((', i)) {
      const innerClose = closing(src, i + 2, ')');
      if (src[innerClose + 1] === ')') {
        tokens.push(...substitutionsIn(src.slice(i + 2, innerClose)).map((text): Token => ({ t: 'sub', body: text })));
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
      if (redirect === '<<' || redirect === '<<-') {
        const [doc, word, end] = heredocAt(src, i + 2);
        heredocs.push(doc);
        tokens.push({ t: 'redir', op: redirect }, { t: 'word', word });
        i = end;
        continue;
      }
      if (redirect) {
        tokens.push({ t: 'redir', op: redirect });
        i += redirect.length;
        continue;
      }
      const [word, end] = readWord(src, i);
      i = end;
      if (/^\d+$/.test(word.raw) && REDIRECTS.some((op) => src.startsWith(op, i))) continue;
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
  } else if (src[i] === '~' && /[A-Za-z0-9._+-]/.test(src[i + 1] ?? '')) {
    parts.push({ kind: 'unread', what: "another user's home directory, ~+ or ~-", dash: false });
  }
  let quoted = false;
  while (i < src.length) {
    const c = src[i]!;
    if (!quoted && BREAKS.has(c)) break;
    const brace = !quoted && c === '{' ? braceExpansion(src, i) : null;
    if (!quoted && c === '$' && src[i + 1] === "'") {
      let end = i + 2;
      while (end < src.length && src[end] !== "'") end += src[end] === '\\' ? 2 : 1;
      const body = src.slice(i + 2, end);
      const escape = body.indexOf('\\');
      // The text before the first escape stays readable, so $'line\nline' is no option in disguise.
      lit += escape === -1 ? body : body.slice(0, escape);
      if (escape !== -1) push({ kind: 'unread', what: "an escape sequence in a $'…' string", dash: true });
      i = end + 1;
    } else if (!quoted && c === '$' && src[i + 1] === '"') {
      // The locale may translate the string. The quoted string after the $ is still read, for the commands it runs.
      push({ kind: 'unread', what: 'a $"…" string', dash: true });
      i += 1;
    } else if (brace) {
      push({ kind: 'unread', what: 'brace expansion', dash: brace.dash });
      i += 1;
    } else if (c === '$') {
      const [part, next] = readDollar(src, i);
      if (part) push(part);
      else lit += '$';
      i = next;
    } else if (c === '`') {
      const end = closing(src, i + 1, '`');
      push({ kind: 'sub', body: src.slice(i + 1, end), open: end === src.length });
      i = end + 1;
    } else if (quoted) {
      if (c === '"') {
        quoted = false;
        i += 1;
      } else if (c === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
        // A backslash before a line break joins the two lines.
        if (src[i + 1] !== '\n') lit += src[i + 1];
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
      if (src[i + 1] !== '\n') lit += src[i + 1] ?? '';
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

// The brace expansion the { at start opens, if it does: a } that closes it in the same word, and a comma or .. between, none of
// them quoted. dash when a word it makes may begin with -: an alternative is empty, starts with -, or starts with what CodeRay
// does not follow. A sequence makes letters or numbers, so at most a negative count.
function braceExpansion(src: string, start: number): { dash: boolean } | null {
  let depth = 0;
  let list = false;
  let dash = false;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]!;
    if (BREAKS.has(c)) return null;
    if (depth === 1 && '{,'.includes(src[i - 1]!) && '-\\\'"$`{,}'.includes(c)) dash = true;
    if (c === '\\') {
      i += 1;
    } else if (c === "'" || c === '"') {
      i = quoteEnd(src, i, c);
    } else if (c === '`') {
      i = closing(src, i + 1, '`');
    } else if (c === '$' && src[i + 1] === '(') {
      i = closing(src, i + 2, ')');
    } else if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i);
      i = end === -1 ? src.length : end;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) return list ? { dash } : null;
    } else if (depth === 1 && (c === ',' || src.startsWith('..', i))) {
      list = true;
    }
  }
  return null;
}

function readDollar(src: string, i: number): [Part | null, number] {
  const next = src[i + 1];
  if (next === '(' && src[i + 2] === '(') {
    const end = src.indexOf('))', i + 3);
    return [nested(src.slice(i + 3, end === -1 ? src.length : end)) ?? { kind: 'var', name: '((…))' }, end === -1 ? src.length : end + 2];
  }
  if (next === '(') {
    const end = closing(src, i + 2, ')');
    return [{ kind: 'sub', body: src.slice(i + 2, end), open: end === src.length }, end + 1];
  }
  if (next === '{') {
    const end = src.indexOf('}', i + 2);
    const inner = src.slice(i + 2, end === -1 ? src.length : end);
    const name = NAME.exec(inner)?.[0] ?? inner;
    return [nested(inner) ?? { kind: 'var', name, modified: name !== inner }, end === -1 ? src.length : end + 1];
  }
  const name = NAME.exec(src.slice(i + 1))?.[0];
  if (name) return [{ kind: 'var', name }, i + 1 + name.length];
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return [{ kind: 'var', name: next }, i + 2];
  return [null, i + 1];
}

// $(…) and `…` inside ${…} and $((…)) run as well; their part is then a substitution of them all.
function nested(text: string): Part | null {
  const bodies = substitutionsIn(text);
  return bodies.length === 0 ? null : { kind: 'sub', body: bodies.join('\n') };
}

// The bodies of the $(…) and `…` in text that bash expands without heeding quotes.
function substitutionsIn(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const backtick = text[i] === '`';
    if (text[i] === '\\') {
      i += 1;
    } else if (backtick || (text.startsWith('$(', i) && text[i + 2] !== '(')) {
      const open = i + (backtick ? 1 : 2);
      i = closing(text, open, backtick ? '`' : ')');
      bodies.push(text.slice(open, i));
    }
  }
  return bodies;
}

// The heredoc whose << ends at start, the word that names its delimiter, and where that word ends.
function heredocAt(src: string, start: number): [Heredoc, Word, number] {
  const strip = src[start] === '-';
  let i = strip ? start + 1 : start;
  while (src[i] === ' ' || src[i] === '\t') i += 1;
  const [word, end] = readWord(src, i);
  return [{ delimiter: literalText(word) ?? word.raw, strip, quoted: /['"\\]/.test(word.raw) }, word, end];
}

function closing(src: string, from: number, close: ')' | '`'): number {
  let depth = 0;
  const heredocs: Heredoc[] = [];
  for (let i = from; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === '\\') {
      i += 1;
    } else if (close === '`') {
      if (c === '`') return i;
    } else if (c === '\n' && heredocs.length > 0) {
      for (const doc of heredocs.splice(0)) i = skipHeredoc(src, i + 1, doc) - 1;
    } else if (c === "'" || c === '"') {
      i = quoteEnd(src, i, c);
    } else if (c === '#' && (i === from || /[\s;&|()]/.test(src[i - 1]!))) {
      // A comment runs to the end of its line, apostrophes and all.
      const end = src.indexOf('\n', i);
      i = (end === -1 ? src.length : end) - 1;
    } else if (src.startsWith('<<', i) && src[i + 2] !== '<') {
      const [doc, , end] = heredocAt(src, i + 2);
      heredocs.push(doc);
      i = end - 1;
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

function simpleCommand(words: Word[], redirects: Redirect[], state: State, depth: number, maybe: boolean): void {
  for (const word of [...words, ...redirects.flatMap((redirect) => (redirect.word ? [redirect.word] : []))]) {
    for (const part of word.parts) {
      if (part.kind !== 'sub') continue;
      // Where CodeRay finds no end bash may find one, and run what follows as commands.
      if (part.open) state.targets.push(unresolved(word.raw.slice(0, 60), 'a command substitution CodeRay cannot read to its end'));
      state.cwd.push(cwdOf(state));
      run(part.body, state, depth + 1);
      state.cwd.pop();
    }
  }
  let args = words;
  while (args.length > 0 && KEYWORDS.has(literalText(args[0]!) ?? '')) {
    nest(literalText(args[0]!)!, state);
    args = args.slice(1);
  }
  nest(literalText(args[0] ?? EMPTY) ?? '', state);
  for (const redirect of redirects) redirectTarget(redirect, state);
  if (args[0]?.raw === '[[') return;
  while (args.length > 0 && isAssignment(args[0]!)) {
    assign(args[0]!, state);
    args = args.slice(1);
  }
  const wrapped = unwrap(args);
  for (const word of args.slice(0, args.length - wrapped.length)) {
    if (isAssignment(word)) assign(word, state);
    else if (['env', 'sudo'].includes(posix.basename(literalText(word) ?? ''))) taint(state);
  }
  if (wrapped.length === 0) return;
  const name = literalText(wrapped[0]!);
  const base = posix.basename(name ?? '');
  // Only a name looked up on the PATH is the program it says: ./cat or /tmp/x/git can be anything.
  if (name === null || name.includes('/') || (base !== 'git' && !ENV_SETTERS.has(base) && !readsOnly(base, wrapped.slice(1)))) {
    taint(state, name === null || name.includes('/') || !namesWhatItWrites(base, wrapped.slice(1)));
  }
  const appended = name === null ? null : /^([A-Za-z_]\w*)\+=/.exec(name);
  if (appended) state.loops.delete(appended[1]!);
  // A command named by a variable may be read, let or any other builtin.
  if (name === null) {
    state.loopsOff = true;
    state.loops.clear();
  }
  // After anything impure (an alias, CDPATH, a function) a cd may not go where it says.
  if (name) command(base, wrapped.slice(1), state, depth, maybe || state.nesting > 0 || !state.pure);
}

// Whether the words so far open a [[ ]] test that has not closed.
function inTest(words: Word[]): boolean {
  const first = words.findIndex((word) => !KEYWORDS.has(literalText(word) ?? ''));
  return first !== -1 && words[first]!.raw === '[[' && !words.slice(first).some((word) => word.raw === ']]');
}

function nest(word: string, state: State): void {
  if (OPENERS.has(word)) state.nesting += 1;
  else if (CLOSERS.has(word)) state.nesting = Math.max(0, state.nesting - 1);
}

function command(name: string, args: Word[], state: State, depth: number, maybe: boolean): void {
  switch (name) {
    case 'cd':
      changeDirectory(args, state, maybe);
      return;
    case 'set':
      // set -a exports every later assignment, set -k takes them from anywhere, and set -- or a word replaces $1 ….
      if (!args.every((word) => /^[-+][euxo]+$|^(pipefail|errexit|nounset|xtrace)$/.test(literalText(word) ?? ''))) taint(state);
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
      state.targets.push(unresolved(name, `${name} runs a script CodeRay cannot read`));
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
    case 'for':
      bindLoop(args, state);
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
      state.targets.push(unresolved('eval', 'eval runs text CodeRay cannot read'));
      return;
    default:
      if (ENV_SETTERS.has(name)) {
        for (const word of args) {
          if (isAssignment(word)) assign(word, state);
          else taint(state);
        }
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
    if (text === null || !text.startsWith('-')) break;
    const name = text.split('=')[0]!;
    if (!GLOBAL_OPTIONS.has(name)) {
      state.targets.push(unresolved(text, 'a git option CodeRay cannot read'));
      return;
    }
    // Configuration given on the command line can run any program: hooks, aliases, editors, merge drivers.
    const setting = literalText(args[i + 1] ?? EMPTY) ?? '';
    if (text === '-c' ? !quiet(setting.split('=')[0]!.toLowerCase(), setting.slice(setting.indexOf('=') + 1)) : !PURE_GLOBALS.has(name)) taint(state);
    i += GLOBAL_OPTIONS.get(name) && name === text ? 2 : 1;
  }
  const word = args[i];
  if (!word) return;
  const sub = literalText(word);
  const global = args.slice(0, i);
  const rest = args.slice(i + 1);
  const [verb, operands] = sub === 'stash' ? stashCommand(rest) : [sub, rest];
  const options = verb === null ? null : parseOptions(operands, SAFE_OPTIONS.get(verb));
  const harmless = verb !== null && spares(verb, operands, options);
  if (!harmless) taint(state);
  // What a commit or a stash takes in may be a file that a program wrote and no target names; it stays pure, as the gate has always judged it.
  if (verb !== null && (verb === 'add' || verb === 'commit' || (verb.startsWith('stash') && !GIT_READS.has(verb)))) state.wild = true;
  // git diff, log and show write their output to a file with --output.
  for (const [at, arg] of rest.entries()) {
    const first = arg.parts[0];
    if (literalText(arg) === '--output' && rest[at + 1]) addTarget(rest[at + 1]!, state);
    else if (first?.kind === 'lit' && first.text.startsWith('--output=')) {
      addTarget({ parts: [{ kind: 'lit', text: first.text.slice('--output='.length) }, ...arg.parts.slice(1)], raw: arg.raw }, state);
    } else if (hidesOption(arg)) state.targets.push(unresolved(arg.raw, 'a git option CodeRay cannot read'));
  }
  if (sub === null) state.targets.push(unresolved(word.raw, 'a git command CodeRay cannot read'));
  // checkout <tree-ish> <paths>, checkout -- <paths> and their kin write files and leave HEAD where it is.
  else if (sub === 'checkout' && (options === null || options.paths)) state.rewrites.push(...gitDirectories(global, state));
  else if (HISTORY_VERBS.has(sub) || (verb === 'stash push' && options !== null)) {
    const refs = options === null ? null : incomingRefs(sub, options);
    for (const dir of gitDirectories(global, state)) {
      state.history.push(dir);
      state.incoming.push(refs);
    }
  }
  else if (sub === 'stash' ? !harmless : WORK_TREE_REWRITES.has(sub)) {
    if (!(sub === 'apply' && appliesToIndexOnly(rest))) state.rewrites.push(...gitDirectories(global, state));
  }
  else if (sub === 'mv' || sub === 'rm') gitPaths(sub, global, rest, state);
}

// Whether a word may be an option whose name its spelling hides, such as {--output=f,} or $"--hard". Variables and command
// substitutions are not counted: everyday git passes a commit or a path through them.
function hidesOption(word: Word): boolean {
  const at = word.parts.findIndex((part) => part.kind === 'unread');
  const part = word.parts[at];
  if (part?.kind !== 'unread') return false;
  const before = literalText({ parts: word.parts.slice(0, at), raw: '' });
  if (before === '') return part.dash;
  return before === null || (before.startsWith('-') && !before.includes('='));
}

// The subcommand of git stash, push when none is named, and the words after it.
function stashCommand(rest: Word[]): [string | null, Word[]] {
  const first = rest[0] === undefined ? undefined : literalText(rest[0]);
  if (first === null) return [null, rest];
  if (first === undefined || first.startsWith('-')) return ['stash push', rest];
  return [`stash ${first === 'save' ? 'push' : first}`, rest.slice(1)];
}

interface Options {
  words: string[];
  flags: Set<string>;
  values: Map<string, string | null>;
  // Paths follow --, or more than one operand is given.
  paths: boolean;
}

// The operands and options of a git command when each option is among the safe ones; null for any other, or for a word CodeRay cannot read.
function parseOptions(args: Word[], safe: Map<string, boolean> | undefined): Options | null {
  if (!safe) return null;
  const parsed: Options = { words: [], flags: new Set(), values: new Map(), paths: false };
  for (let i = 0; i < args.length; i += 1) {
    const text = literalText(args[i]!);
    if (text === null) return null;
    if (text === '--') {
      parsed.paths = true;
      break;
    }
    if (!text.startsWith('-') || text === '-') {
      parsed.words.push(text);
      continue;
    }
    // A long option's value follows = or is the next word; short options bundle, and one that takes a value takes the rest or the next word.
    const long = text.startsWith('--');
    const at = text.indexOf('=');
    const names = long ? [at === -1 ? text : text.slice(0, at)] : [...text.slice(1)].map((letter) => `-${letter}`);
    for (const [index, name] of names.entries()) {
      if (!safe.has(name)) return null;
      parsed.flags.add(name);
      if (!safe.get(name)) continue;
      const attached = long ? (at === -1 ? null : text.slice(at + 1)) : text.slice(index + 2) || null;
      if (attached === null) i += 1;
      parsed.values.set(name, attached ?? (args[i] === undefined ? '' : literalText(args[i]!)));
      break;
    }
  }
  parsed.paths ||= parsed.words.length > 1;
  return parsed;
}

// Whether a git command keeps the call pure: a read, or a command with only safe options (and, for remote and config, one that reads).
function spares(verb: string, operands: Word[], options: Options | null): boolean {
  if (GIT_READS.has(verb)) {
    return operands.every((arg) => {
      const text = literalText(arg);
      return text !== null && !(text.length > 4 && '--ext-diff'.startsWith(text.split('=')[0]!));
    });
  }
  if (options === null) return false;
  const [first] = options.words;
  if (verb === 'remote') return first === undefined || first === 'show' || first === 'get-url';
  if (verb === 'config') return CONFIG_READS.some((flag) => options.flags.has(flag)) || options.words.length === 1 || first === 'get' || first === 'list';
  return true;
}

// The commits a history command brings into the work tree besides HEAD; null when the words do not say (a variable, a refspec).
function incomingRefs(sub: string, { words: operands, flags, values }: Options): string[] | null {
  // A stopped sequence's commits were judged when it started, and the edits that resolve it are ordinary edits.
  if (['--continue', '--skip', '--quit'].some((flag) => flags.has(flag))) return [];
  if (flags.has('--abort')) return sub === 'merge' ? [] : ['ORIG_HEAD'];
  const words = operands.map((word) => (word === '-' ? '@{-1}' : word));
  const onto = values.get('--onto');
  if (onto === null || onto === '') return null;
  switch (sub) {
    case 'checkout':
    case 'switch':
      return words.slice(0, 1);
    case 'reset':
      return ['--hard', '--merge', '--keep'].some((flag) => flags.has(flag)) ? words.slice(0, 1) : [];
    case 'stash':
      return [];
    case 'merge':
      return words.length > 0 ? words : ['@{upstream}'];
    case 'pull':
      if (words.length < 2) return ['@{upstream}'];
      return words.slice(1).some((ref) => ref.includes(':')) ? null : words.slice(1).map((ref) => `${words[0]}/${ref}`);
    case 'rebase':
      // With --root every commit is replayed, and the word names the branch, not an upstream.
      if (flags.has('--root')) return [...(onto === undefined ? [] : [onto]), ...words.slice(0, 1)];
      return [onto ?? words[0] ?? '@{upstream}', ...words.slice(1, 2)];
    case 'revert':
      return words.flatMap((ref) => [ref, `${ref}^`]);
    default:
      return words;
  }
}

// Where git may run: each directory bash may be in, moved by each -C; unknown for a repository chosen any other way.
function gitDirectories(options: Word[], state: State): (string | null)[] {
  if (state.gitEnv) return [null];
  const dirs = cwdOf(state).map((cwd) => {
    let dir = cwd;
    for (let i = 0; i < options.length; i += 1) {
      const text = literalText(options[i]!);
      if (text !== null && /^--(git-dir|work-tree)(=|$)/.test(text)) return null;
      if (text !== '-C') continue;
      const value = options[i + 1] === undefined ? null : literalText(options[i + 1]!);
      if (value === null || (dir === null && !value.startsWith('/'))) return null;
      dir = posix.resolve(dir ?? '/', value);
    }
    return dir;
  });
  return [...new Set(dirs)];
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
    state.targets.push(unresolved('--', 'a shell script CodeRay cannot read'));
    return;
  }
  const text = script ? literalText(script) : null;
  if (text === null) {
    state.targets.push(unresolved(script?.raw ?? '-c', 'a shell script CodeRay cannot read'));
    return;
  }
  state.cwd.push(cwdOf(state));
  const loops = state.loops;
  state.loops = new Map();
  run(text, state, depth + 1);
  state.loops = loops;
  state.cwd.pop();
}

// A cd that may not run leaves bash in either directory.
function changeDirectory(args: Word[], state: State, maybe: boolean): void {
  const [first] = operands(args, []);
  const top = state.cwd.length - 1;
  const current = state.cwd[top]!;
  const value = first ? wordValue(first, state) : { text: state.env.home };
  const moved = current.map((dir) =>
    'text' in value && value.text !== '-' && (value.text.startsWith('/') || dir !== null) ? posix.resolve(dir ?? '/', value.text) : null);
  state.cwd[top] = [...new Set(maybe ? [...current, ...moved] : moved)];
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
    } else if (part.kind === 'unread') return { problem: part.what };
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
    } else if (part.kind === 'unread') {
      // It may spell .. and climb out.
      return { problem: part.what };
    } else if (dotted) {
      return leaves;
    } else {
      tail += '\0';
    }
  }
  const inside = posix.normalize(`${TEMP_ROOT}${tail}`);
  return inside === TEMP_ROOT || inside.startsWith(`${TEMP_ROOT}/`) ? { temp: true } : leaves;
}

// A word with a loop variable stands for one word per value of the variable.
function loopWords(word: Word, state: State): Word[] {
  let variants: Part[][] = [[]];
  for (const part of word.parts) {
    const values = part.kind === 'var' && !part.modified ? state.loops.get(part.name) : undefined;
    if (values === undefined) {
      variants = variants.map((parts) => [...parts, part]);
    } else if (variants.length * values.length > MAX_LOOP_PATHS) {
      return [word];
    } else {
      variants = variants.flatMap((parts) => values.map((text): Part[] => [...parts, { kind: 'lit', text }]));
    }
  }
  return variants.map((parts) => ({ ...word, parts }));
}

// for NAME in WORDS: while the loop runs NAME is one of the words; a list CodeRay cannot read leaves it unknown.
function bindLoop(args: Word[], state: State): void {
  const name = literalText(args[0] ?? EMPTY);
  if (name === null || !/^[A-Za-z_]\w*$/.test(name)) return;
  state.loops.delete(name);
  if (PROTECTED_VARS.has(name)) {
    state.poisoned.add(name);
    return;
  }
  if (state.loopsOff) return;
  const values = args.slice(2).map(literalText);
  if (literalText(args[1] ?? EMPTY) !== 'in' || values.length === 0) return;
  if (values.every((value): value is string => value !== null && PLAIN_VALUE.test(value))) state.loops.set(name, values);
}

function addTarget(word: Word, state: State, extra: TargetExtra = {}): void {
  for (const variant of loopWords(word, state)) addResolvedTarget(variant, state, extra);
}

function addResolvedTarget(word: Word, state: State, extra: TargetExtra): void {
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
  for (const cwd of value.text.startsWith('/') ? ['/'] : cwdOf(state)) {
    if (cwd === null) state.targets.push({ ...base, path: null, temp: false, unresolved: 'a relative path after a cd CodeRay cannot follow' });
    else state.targets.push({ ...base, path: posix.resolve(cwd, value.text), temp: false, unresolved: null });
  }
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
  state.loops.delete(name);
  if (PROTECTED_VARS.has(name)) state.poisoned.add(name);
  if (quiet(name, literalText({ parts: value, raw: '' }) ?? '')) return;
  // A variable can point git at another repository, index or editor, or put another program on the PATH.
  taint(state);
  if (name.startsWith('GIT_')) state.gitEnv = true;
}

const quiet = (name: string, value: string): boolean => QUIET_SETTINGS.has(name) && QUIET_PROGRAMS.has(value);

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

function optionTable(spec: string): Map<string, boolean> {
  return new Map(spec.split(' ').map((option) => [option.replace(/=$/, ''), option.endsWith('=')]));
}

const literalWord = (text: string): Word => ({ parts: [{ kind: 'lit', text }], raw: text });
const cwdOf = (state: State): (string | null)[] => state.cwd[state.cwd.length - 1]!;
const unresolved = (word: string, reason: string): ShellTarget => ({ word, path: null, temp: false, mkdir: false, deleting: false, names: [], unresolved: reason });
