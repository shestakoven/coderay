import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClonePhase } from '@ide/protocol';
import { CLONE_CANCELLED, parseCloneProgress, startClone } from '../../src/project/clone';
import { GIT_NOT_FOUND } from '../../src/project/git';
import { tempDir, waitFor } from '../helpers';
import { fakeGit } from './fake-git';

type Progress = { phase: ClonePhase; percent: number };

const ls = (dir: string): string[] => readdirSync(dir).sort();

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  vi.unstubAllEnvs();
});

function setup(): { base: string; parent: string; bin: string } {
  const base = tempDir('ide-clone-contract-');
  const parent = join(base, 'parent');
  const bin = join(base, 'bin');
  mkdirSync(parent);
  mkdirSync(bin);
  return { base, parent, bin };
}

function bareRepo(base: string): string {
  const src = join(base, 'src');
  execFileSync('git', ['init', '-q', src]);
  writeFileSync(join(src, 'hello.txt'), 'hello');
  execFileSync('git', ['-C', src, 'add', '.']);
  execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  const bare = join(base, 'bare.git');
  execFileSync('git', ['clone', '-q', '--bare', src, bare]);
  return bare;
}

async function pidFrom(file: string): Promise<number> {
  const pid = await waitFor(() => existsSync(file) && Number(readFileSync(file, 'utf8').trim()), `pid in ${file}`);
  spawned.push(pid);
  return pid;
}

const LAST_ARG = 'for a in "$@"; do last="$a"; done';

// A git that makes a partial target, then waits on a background helper in its process group.
function slowGit(bin: string, opts: { ignoreTerm?: boolean; lateWrite?: boolean } = {}): string {
  return fakeGit(bin, [
    opts.ignoreTerm ? "trap '' TERM" : '',
    LAST_ARG,
    opts.lateWrite ? `trap 'sleep 0.3; mkdir -p "$last"; echo late > "$last/late"; exit 143' TERM` : '',
    'mkdir -p "$last"',
    'echo partial > "$last/partial"',
    `echo $$ > "${bin}/git.pid"`,
    'sleep 30 &',
    `echo $! > "${bin}/sleep.pid"`,
    'wait',
  ].join('\n'));
}

// A git that records its cwd, args and environment, creates the target and succeeds.
function recordingGit(bin: string, exit = 0): string {
  return fakeGit(bin, [
    `echo ran > "${bin}/ran"`,
    `env > "${bin}/env"`,
    `: > "${bin}/args"`,
    `for a in "$@"; do printf '%s\\n' "$a" >> "${bin}/args"; done`,
    LAST_ARG,
    'mkdir -p "$last"',
    `exit ${exit}`,
  ].join('\n'));
}

// A git that writes the given shell commands' stderr, creates the target and exits with the code.
function scriptedGit(bin: string, stderr: string, exit: number, makeTarget = true): string {
  return fakeGit(bin, [LAST_ARG, makeTarget ? 'mkdir -p "$last"; echo x > "$last/x"' : '', stderr, `exit ${exit}`].join('\n'));
}

function run(opts: { url: string; parent: string; name: string | null; git?: string; killAfterMs?: number }) {
  const progress: Progress[] = [];
  const clone = startClone({ ...opts, onProgress: (p) => progress.push({ phase: p.phase, percent: p.percent }) });
  return { ...clone, progress };
}

const envOf = (bin: string): Record<string, string> =>
  Object.fromEntries(readFileSync(join(bin, 'env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const at = l.indexOf('=');
    return [l.slice(0, at), l.slice(at + 1)];
  }));
const argsOf = (bin: string): string[] => readFileSync(join(bin, 'args'), 'utf8').split('\n').slice(0, -1);

describe('startClone from a local bare repository', () => {
  it('clones into parent/<name derived from the URL> when the name is null', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    const result = await run({ url: `file://${bare}`, parent, name: null }).done;
    expect(result).toEqual({ root: join(parent, 'bare') });
    expect(readFileSync(join(parent, 'bare', 'hello.txt'), 'utf8')).toBe('hello');
  });

  it('clones into parent/<given name>', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    expect(await run({ url: bare, parent, name: 'mine' }).done).toEqual({ root: join(parent, 'mine') });
    expect(readFileSync(join(parent, 'mine', 'hello.txt'), 'utf8')).toBe('hello');
  });

  it('clones into a pre-existing empty folder', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    mkdirSync(join(parent, 'empty'));
    expect(await run({ url: bare, parent, name: 'empty' }).done).toEqual({ root: join(parent, 'empty') });
    expect(ls(join(parent, 'empty'))).toContain('hello.txt');
  });

  it('reports only known phases with integer percents in 0..100', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    const clone = run({ url: `file://${bare}`, parent, name: null });
    await clone.done;
    for (const p of clone.progress) {
      expect(['counting', 'compressing', 'receiving', 'resolving', 'checking-out']).toContain(p.phase);
      expect(Number.isInteger(p.percent) && p.percent >= 0 && p.percent <= 100).toBe(true);
    }
  });

  it('removes the target and reports an error for a URL that is not a repository', async () => {
    const { base, parent } = setup();
    const result = await run({ url: join(base, 'nope.git'), parent, name: 'x' }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
    expect(ls(parent)).toEqual([]);
  });

  it('keeps a pre-existing empty folder empty when the URL is not a repository', async () => {
    const { base, parent } = setup();
    mkdirSync(join(parent, 'keep'));
    await run({ url: join(base, 'nope.git'), parent, name: 'keep' }).done;
    expect(ls(parent)).toEqual(['keep']);
    expect(ls(join(parent, 'keep'))).toEqual([]);
  });

  it('cancel after a successful clone does nothing to the clone', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    const clone = run({ url: bare, parent, name: 'done' });
    expect(await clone.done).toEqual({ root: join(parent, 'done') });
    expect(() => clone.cancel()).not.toThrow();
    expect(() => clone.cancel()).not.toThrow();
    expect(readFileSync(join(parent, 'done', 'hello.txt'), 'utf8')).toBe('hello');
    expect(existsSync(join(parent, 'done', '.git'))).toBe(true);
  });
});

describe('startClone runs git safely', () => {
  it('passes clone --progress, then --, then the trimmed URL and the target', async () => {
    const { parent, bin } = setup();
    await run({ url: '  file:///srv/repo.git \n', parent, name: null, git: recordingGit(bin) }).done;
    const args = argsOf(bin);
    expect(args).toContain('clone');
    expect(args).toContain('--progress');
    const dashes = args.indexOf('--');
    expect(dashes).toBeGreaterThan(args.indexOf('clone'));
    expect(args.slice(dashes + 1)).toEqual(['file:///srv/repo.git', join(parent, 'repo')]);
  });

  it('disables prompts and allows only https, ssh, git and file transports', async () => {
    const { parent, bin } = setup();
    await run({ url: 'file:///srv/repo.git', parent, name: 'r', git: recordingGit(bin) }).done;
    expect(envOf(bin)).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git:file' });
  });

  it('overrides a permissive GIT_ALLOW_PROTOCOL and GIT_TERMINAL_PROMPT inherited from the user', async () => {
    const { parent, bin } = setup();
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ext:file:https');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    await run({ url: 'file:///srv/repo.git', parent, name: 'r', git: recordingGit(bin) }).done;
    expect(envOf(bin)).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git:file' });
  });

  it('keeps the user environment so SSH keys and credential helpers apply', async () => {
    const { parent, bin } = setup();
    vi.stubEnv('IDE_CONTRACT_MARKER', 'kept');
    await run({ url: 'file:///srv/repo.git', parent, name: 'r', git: recordingGit(bin) }).done;
    expect(envOf(bin)).toMatchObject({ HOME: process.env.HOME, IDE_CONTRACT_MARKER: 'kept' });
  });

  it.each([
    ['a leading dash', '-uhoh'],
    ['an --upload-pack option', '--upload-pack=touch /tmp/never'],
    ['a dash after whitespace', '   --upload-pack=touch /tmp/never'],
    ['a dash after a tab and newline', '\t\n-oProxyCommand=x'],
  ])('rejects a URL with %s without running git', async (_label, url) => {
    const { parent, bin } = setup();
    const result = await run({ url, parent, name: 'x', git: recordingGit(bin) }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect(existsSync(join(bin, 'ran'))).toBe(false);
    expect(ls(parent)).toEqual([]);
  });

  it('a real git never runs an --upload-pack URL', async () => {
    const { base, parent } = setup();
    const marker = join(base, 'PWNED');
    const result = await run({ url: `--upload-pack=touch ${marker}`, parent, name: 'x' }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect(existsSync(marker)).toBe(false);
  });

  it('a real git refuses an ext:: URL even when the user environment allows ext', async () => {
    const { base, parent } = setup();
    const marker = join(base, 'PWNED');
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ext:file');
    const result = await run({ url: `ext::sh -c touch% ${marker}`, parent, name: 'x' }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect(existsSync(marker)).toBe(false);
    expect(ls(parent)).toEqual([]);
  });

  it.each([['empty', ''], ['whitespace only', '  \n ']])('rejects an %s URL without running git', async (_label, url) => {
    const { parent, bin } = setup();
    expect(await run({ url, parent, name: 'x', git: recordingGit(bin) }).done).toEqual({ error: expect.any(String) });
    expect(existsSync(join(bin, 'ran'))).toBe(false);
  });

  it.each([['two dots', '..'], ['a dot', '.'], ['a slash', 'a/b'], ['empty', ''], ['256 bytes', 'n'.repeat(256)]])(
    'rejects a name with %s without running git',
    async (_label, name) => {
      const { base, parent, bin } = setup();
      expect(await run({ url: 'file:///srv/repo.git', parent, name, git: recordingGit(bin) }).done).toEqual({ error: expect.any(String) });
      expect(existsSync(join(bin, 'ran'))).toBe(false);
      expect(ls(parent)).toEqual([]);
      expect(ls(base)).toEqual(['bin', 'parent']);
    },
  );

  it('never targets outside the parent when the URL ends in ..', async () => {
    const { base, parent, bin } = setup();
    const result = await run({ url: 'https://host/org/..', parent, name: null, git: recordingGit(bin) }).done;
    expect(ls(base)).toEqual(['bin', 'parent']);
    if ('root' in result) expect(result.root.startsWith(`${parent}/`)).toBe(true);
    if (existsSync(join(bin, 'args'))) expect(argsOf(bin).at(-1)!.startsWith(`${parent}/`)).toBe(true);
  });

  it('refuses a non-empty target without touching it', async () => {
    const { parent, bin } = setup();
    mkdirSync(join(parent, 'taken'));
    writeFileSync(join(parent, 'taken', 'notes.txt'), 'keep me');
    const result = await run({ url: 'file:///srv/repo.git', parent, name: 'taken', git: recordingGit(bin) }).done;
    expect(result).toEqual({ error: expect.stringMatching(/already exists/i) });
    expect(ls(join(parent, 'taken'))).toEqual(['notes.txt']);
    expect(readFileSync(join(parent, 'taken', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('refuses a target that is a file without touching it', async () => {
    const { parent, bin } = setup();
    writeFileSync(join(parent, 'file'), 'data');
    expect(await run({ url: 'file:///srv/repo.git', parent, name: 'file', git: recordingGit(bin) }).done).toEqual({ error: expect.any(String) });
    expect(readFileSync(join(parent, 'file'), 'utf8')).toBe('data');
  });

  it('refuses a missing parent and does not create it', async () => {
    const { base, bin } = setup();
    expect(await run({ url: 'file:///srv/repo.git', parent: join(base, 'nope'), name: 'r', git: recordingGit(bin) }).done)
      .toEqual({ error: expect.any(String) });
    expect(existsSync(join(base, 'nope'))).toBe(false);
  });

  it('reports git not found and removes the folder it created', async () => {
    const { base, parent } = setup();
    expect(await run({ url: 'file:///srv/repo.git', parent, name: 'r', git: join(base, 'no-such-git') }).done).toEqual({ error: GIT_NOT_FOUND });
    expect(ls(parent)).toEqual([]);
  });

  it('resolves with an error when the git path is a directory', async () => {
    const { parent, bin } = setup();
    await expect(run({ url: 'file:///srv/repo.git', parent, name: 'r', git: bin }).done).resolves.toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
  });
});

describe('startClone failure text and cleanup', () => {
  it('uses the last stderr line as the error, even without a trailing newline', async () => {
    const { parent, bin } = setup();
    const git = scriptedGit(bin, `printf "Cloning into 'r'...\\nfatal: could not read Username for 'https://host': terminal prompts disabled" >&2`, 128);
    const result = await run({ url: 'https://host/org/r.git', parent, name: 'r', git }).done;
    expect(result).toEqual({ error: expect.stringContaining('could not read Username') });
    expect((result as { error: string }).error).not.toContain('Cloning into');
  });

  it('treats a carriage return as a line end when picking the last line', async () => {
    const { parent, bin } = setup();
    const git = scriptedGit(bin, 'printf "Receiving objects:  50%% (1/2)\\rfatal: early EOF\\n" >&2', 128);
    const result = await run({ url: 'https://host/org/r.git', parent, name: 'r', git }).done;
    expect(result).toEqual({ error: expect.stringContaining('early EOF') });
    expect((result as { error: string }).error).not.toContain('Receiving');
  });

  it('skips trailing blank lines when picking the last line', async () => {
    const { parent, bin } = setup();
    const git = scriptedGit(bin, 'printf "fatal: the thing broke\\n\\n\\n" >&2', 1);
    expect(await run({ url: 'https://host/org/r.git', parent, name: 'r', git }).done).toEqual({ error: expect.stringContaining('the thing broke') });
  });

  it('still reports a non-empty error when git fails silently', async () => {
    const { parent, bin } = setup();
    const result = await run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, '', 1) }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect((result as { error: string }).error.trim().length).toBeGreaterThan(0);
  });

  it('removes a target that git created and filled before failing', async () => {
    const { parent, bin } = setup();
    await run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, 'echo "fatal: x" >&2', 1) }).done;
    expect(ls(parent)).toEqual([]);
  });

  it('empties but keeps a pre-existing empty folder after a failure', async () => {
    const { parent, bin } = setup();
    mkdirSync(join(parent, 'mine'));
    await run({ url: 'https://host/org/r.git', parent, name: 'mine', git: scriptedGit(bin, 'echo "fatal: x" >&2', 1) }).done;
    expect(ls(parent)).toEqual(['mine']);
    expect(ls(join(parent, 'mine'))).toEqual([]);
  });
});

describe('startClone cleanup of what git wrote', () => {
  it('empties a pre-existing folder of dot-files and nested git data after a failure', async () => {
    const { parent, bin } = setup();
    mkdirSync(join(parent, 'mine'));
    const git = fakeGit(bin, [
      LAST_ARG,
      'mkdir -p "$last/.git/objects/ab" "$last/src/deep"',
      'echo blob > "$last/.git/objects/ab/cd"',
      'echo x > "$last/.gitattributes"',
      'echo y > "$last/src/deep/file"',
      'echo "fatal: interrupted" >&2',
      'exit 128',
    ].join('\n'));
    await run({ url: 'https://host/org/r.git', parent, name: 'mine', git }).done;
    expect(ls(parent)).toEqual(['mine']);
    expect(ls(join(parent, 'mine'))).toEqual([]);
  });
});

describe('startClone progress', () => {
  it('reports recorded git stderr as de-duplicated progress in order', async () => {
    const { parent, bin } = setup();
    const recorded = [
      'Cloning into r...\\n',
      'remote: Enumerating objects: 3, done.        \\n',
      'remote: Counting objects:  33%% (1/3)        \\r',
      'remote: Counting objects:  66%% (2/3)        \\r',
      'remote: Counting objects: 100%% (3/3)        \\r',
      'remote: Counting objects: 100%% (3/3), done.        \\n',
      'remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)        \\n',
      'Receiving objects:  33%% (1/3)\\r',
      'Receiving objects:  66%% (2/3)\\r',
      'Receiving objects: 100%% (3/3)\\r',
      'Receiving objects: 100%% (3/3), done.\\n',
    ].join('');
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, `printf '${recorded}' >&2`, 0) });
    expect(await clone.done).toEqual({ root: join(parent, 'r') });
    expect(clone.progress).toEqual([
      { phase: 'counting', percent: 33 },
      { phase: 'counting', percent: 66 },
      { phase: 'counting', percent: 100 },
      { phase: 'receiving', percent: 33 },
      { phase: 'receiving', percent: 66 },
      { phase: 'receiving', percent: 100 },
    ]);
  });

  it('joins a progress line split across output chunks', async () => {
    const { parent, bin } = setup();
    const stderr = [
      'printf "Receiving obj" >&2',
      'sleep 0.2',
      'printf "ects:  42%% (42/100)\\r" >&2',
      'sleep 0.2',
      'printf "Resolving del" >&2',
      'sleep 0.2',
      'printf "tas: 100%% (1/1), done.\\n" >&2',
    ].join('\n');
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, stderr, 0) });
    await clone.done;
    expect(clone.progress).toEqual([{ phase: 'receiving', percent: 42 }, { phase: 'resolving', percent: 100 }]);
  });

  it('parses an unterminated final progress line', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, 'printf "Resolving deltas:  77%% (7/9)" >&2', 0) });
    await clone.done;
    expect(clone.progress).toEqual([{ phase: 'resolving', percent: 77 }]);
  });

  it('reports a repeated line once but a changed percent again', async () => {
    const { parent, bin } = setup();
    const lines = 'Receiving objects:  10%% (1/10)\\rReceiving objects:  10%% (1/10)\\rReceiving objects:  20%% (2/10)\\rResolving deltas:  20%% (1/5)\\n';
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, `printf '${lines}' >&2`, 0) });
    await clone.done;
    expect(clone.progress).toEqual([
      { phase: 'receiving', percent: 10 },
      { phase: 'receiving', percent: 20 },
      { phase: 'resolving', percent: 20 },
    ]);
  });
});

describe('parseCloneProgress', () => {
  it.each([
    ['Receiving objects:  45% (9/20), 1.00 KiB | 1.00 MiB/s', 'receiving', 45],
    ['Receiving objects: 100% (3/3), done.', 'receiving', 100],
    ['Resolving deltas:   0% (0/2)', 'resolving', 0],
    ['Resolving deltas: 100% (2/2), done.', 'resolving', 100],
    ['remote: Counting objects:  33% (1/3)        ', 'counting', 33],
    ['remote: Compressing objects: 100% (2/2), done.', 'compressing', 100],
    ['Checking out files:  50% (1/2)', 'checking-out', 50],
    ['Updating files:  12% (1/8)', 'checking-out', 12],
  ])('%j -> %s %d', (line, phase, percent) => {
    expect(parseCloneProgress(line)).toEqual({ phase, percent });
  });

  it.each([
    "Cloning into 'repo'...",
    'remote: Enumerating objects: 3, done.',
    'remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0',
    'fatal: repository not found',
    'warning: You appear to have cloned an empty repository.',
    'Receiving objects',
    'Receiving objects: abc% (1/2)',
    'Downloading cats:  50% (1/2)',
    '',
  ])('ignores %j', (line) => {
    expect(parseCloneProgress(line)).toBeNull();
  });
});

describe('startClone cancel', () => {
  it('stops git and its helpers, removes the partial folder and reports cancelled', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin) });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    const sleepPid = await pidFrom(join(bin, 'sleep.pid'));
    expect(existsSync(join(parent, 'r', 'partial'))).toBe(true);
    clone.cancel();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
    expect(ls(parent)).toEqual([]);
    await waitFor(() => !alive(gitPid), 'git exited', 3000);
    await waitFor(() => !alive(sleepPid), 'helper in the process group exited', 3000);
  });

  it('a git that exits on SIGTERM ends well before the kill delay', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin), killAfterMs: 15_000 });
    await pidFrom(join(bin, 'sleep.pid'));
    const started = Date.now();
    clone.cancel();
    await clone.done;
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('SIGKILLs a git that ignores SIGTERM after killAfterMs, helpers included', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin, { ignoreTerm: true }), killAfterMs: 400 });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    const sleepPid = await pidFrom(join(bin, 'sleep.pid'));
    const started = Date.now();
    clone.cancel();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(5000);
    expect(ls(parent)).toEqual([]);
    await waitFor(() => !alive(gitPid) && !alive(sleepPid), 'git and helper killed', 3000);
  });

  it('cleans up only after git exits, so a late write by git does not survive', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin, { lateWrite: true }) });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    clone.cancel();
    await clone.done;
    await waitFor(() => !alive(gitPid), 'git exited', 3000);
    expect(ls(parent)).toEqual([]);
  });

  it('empties but keeps a pre-existing empty folder, including late writes', async () => {
    const { parent, bin } = setup();
    mkdirSync(join(parent, 'mine'));
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'mine', git: slowGit(bin, { lateWrite: true }) });
    const gitPid = await pidFrom(join(bin, 'git.pid'));
    clone.cancel();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
    await waitFor(() => !alive(gitPid), 'git exited', 3000);
    expect(ls(parent)).toEqual(['mine']);
    expect(ls(join(parent, 'mine'))).toEqual([]);
  });

  it('a second cancel is harmless and the result is reported once', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin) });
    await pidFrom(join(bin, 'sleep.pid'));
    clone.cancel();
    expect(() => clone.cancel()).not.toThrow();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
  });

  it('cancel right after start leaves no folder and no process behind', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin) });
    clone.cancel();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
    expect(ls(parent)).toEqual([]);
    // A git that was not stopped writes its pid files within this time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const file of ['git.pid', 'sleep.pid']) {
      if (!existsSync(join(bin, file))) continue;
      const pid = await pidFrom(join(bin, file));
      await waitFor(() => !alive(pid), `${file} process gone`, 3000);
    }
  });
});

describe('startClone robustness', () => {
  it('finishes when git floods stdout beyond a pipe buffer', async () => {
    const { parent, bin } = setup();
    const git = scriptedGit(bin, 'i=0; while [ $i -lt 4000 ]; do echo "line $i padding padding padding padding padding padding"; i=$((i+1)); done', 0);
    expect(await run({ url: 'https://host/org/r.git', parent, name: 'r', git }).done).toEqual({ root: join(parent, 'r') });
  });

  it('finishes when git floods stderr without progress', async () => {
    const { parent, bin } = setup();
    const git = scriptedGit(bin, 'i=0; while [ $i -lt 4000 ]; do echo "remote: noise $i padding padding padding padding padding" >&2; i=$((i+1)); done', 0);
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git });
    expect(await clone.done).toEqual({ root: join(parent, 'r') });
    expect(clone.progress).toEqual([]);
  });

  it('a git killed by a signal it did not get from cancel is a failure, not a cancel, and is cleaned up', async () => {
    const { parent, bin } = setup();
    const result = await run({ url: 'https://host/org/r.git', parent, name: 'r', git: scriptedGit(bin, 'kill -KILL $$', 0) }).done;
    expect(result).toEqual({ error: expect.any(String) });
    expect((result as { error: string }).error).not.toBe(CLONE_CANCELLED);
    expect(ls(parent)).toEqual([]);
  });

  it('passes a target with spaces as one argument', async () => {
    const { base, bin } = setup();
    const parent = join(base, 'my projects');
    mkdirSync(parent);
    expect(await run({ url: 'file:///srv/repo.git', parent, name: 'my repo', git: recordingGit(bin) }).done).toEqual({ root: join(parent, 'my repo') });
    expect(argsOf(bin).at(-1)).toBe(join(parent, 'my repo'));
  });

  it('reports an error for a parent that is not writable and creates nothing', async () => {
    const { base, parent } = setup();
    const bare = bareRepo(base);
    chmodSync(parent, 0o555);
    try {
      const result = await run({ url: bare, parent, name: 'r' }).done;
      expect(result).toEqual({ error: expect.any(String) });
      expect(ls(parent)).toEqual([]);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('keeps a symlinked empty target folder and the link after a cancel', async () => {
    const { base, parent, bin } = setup();
    mkdirSync(join(base, 'real-empty'));
    symlinkSync(join(base, 'real-empty'), join(parent, 'link'));
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'link', git: slowGit(bin) });
    let settled = false;
    void clone.done.then(() => (settled = true));
    await waitFor(() => settled || existsSync(join(bin, 'sleep.pid')), 'clone running or refused');
    clone.cancel();
    await clone.done;
    if (existsSync(join(bin, 'git.pid'))) {
      const pid = await pidFrom(join(bin, 'git.pid'));
      await waitFor(() => !alive(pid), 'git exited', 3000);
    }
    expect(lstatSync(join(parent, 'link')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(base, 'real-empty')).isDirectory()).toBe(true);
  });

  it('SIGKILLs a SIGTERM-ignoring git after the default delay of about 3 s', async () => {
    const { parent, bin } = setup();
    const clone = run({ url: 'https://host/org/r.git', parent, name: 'r', git: slowGit(bin, { ignoreTerm: true }) });
    const sleepPid = await pidFrom(join(bin, 'sleep.pid'));
    const started = Date.now();
    clone.cancel();
    expect(await clone.done).toEqual({ error: CLONE_CANCELLED });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(8000);
    await waitFor(() => !alive(sleepPid), 'helper killed', 3000);
  });
});
