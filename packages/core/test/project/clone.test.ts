import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ClonePhase } from '@ide/protocol';
import { CLONE_CANCELLED, parseCloneProgress, startClone } from '../../src/project/clone';
import { GIT_NOT_FOUND } from '../../src/project/git';
import { tempDir, waitFor } from '../helpers';
import { fakeGit } from './fake-git';

type Progress = { phase: ClonePhase; percent: number };
const clone = (options: { url: string; parent: string; name?: string | null; git?: string; killAfterMs?: number }) => {
  const progress: Progress[] = [];
  const handle = startClone({ ...options, name: options.name ?? null, onProgress: (item) => progress.push(item) });
  return { ...handle, progress };
};

function groupSignals(): () => unknown[] {
  const kill = vi.spyOn(process, 'kill');
  onTestFinished(() => kill.mockRestore());
  return () => kill.mock.calls.filter(([pid]) => Number(pid) < 0).map(([, signal]) => signal);
}

function source(dir: string, name = 'source'): string {
  const path = join(dir, name);
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(path, 'hello.txt'), 'hi');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return path;
}

describe('parseCloneProgress', () => {
  it.each([
    ['Receiving objects:  42% (21/50), 1.2 MiB | 3 MiB/s', 'receiving', 42],
    ['remote: Counting objects:  10% (1/10)', 'counting', 10],
    ['Enumerating objects: 7%', 'counting', 7],
    ['remote: Compressing objects: 100% (5/5), done.', 'compressing', 100],
    ['Resolving deltas: 100% (3/3), done.', 'resolving', 100],
    ['Updating files:  50% (2/4)', 'checking-out', 50],
    ['Checking out files:  50% (2/4)', 'checking-out', 50],
  ])('reads %j', (line, phase, percent) => {
    expect(parseCloneProgress(line)).toEqual({ phase, percent });
  });

  it.each(['Cloning into \'x\'...', 'fatal: repository not found', 'remote: Total 15 (delta 0)', '', 'Receiving objects: soon'])('ignores %j', (line) => {
    expect(parseCloneProgress(line)).toBeNull();
  });
});

describe('startClone with real git', () => {
  it('clones a local repository into parent/name', async () => {
    const dir = tempDir('ide-clone-');
    const url = source(dir);
    const parent = tempDir('ide-clone-parent-');
    expect(await clone({ url, parent, name: 'copy' }).done).toEqual({ root: join(parent, 'copy') });
    expect(readFileSync(join(parent, 'copy', 'hello.txt'), 'utf8')).toBe('hi');
    expect(existsSync(join(parent, 'copy', '.git'))).toBe(true);
  });

  it('names the folder after the url when no name is given, dropping .git', async () => {
    const url = source(tempDir('ide-clone-'), 'lib.git');
    const parent = tempDir('ide-clone-parent-');
    expect(await clone({ url, parent }).done).toEqual({ root: join(parent, 'lib') });
  });

  it('clones into an existing empty folder', async () => {
    const url = source(tempDir('ide-clone-'));
    const parent = tempDir('ide-clone-parent-');
    mkdirSync(join(parent, 'copy'));
    expect(await clone({ url, parent, name: 'copy' }).done).toEqual({ root: join(parent, 'copy') });
    expect(existsSync(join(parent, 'copy', 'hello.txt'))).toBe(true);
  });

  it('refuses a non-empty target without starting git, and leaves its files', async () => {
    const parent = tempDir('ide-clone-parent-');
    mkdirSync(join(parent, 'copy'));
    writeFileSync(join(parent, 'copy', 'keep.txt'), 'mine');
    const result = await clone({ url: 'https://h/o/r.git', parent, name: 'copy', git: '/nonexistent/git' }).done;
    expect(result).toEqual({ error: expect.stringContaining('already exists') });
    expect(readdirSync(join(parent, 'copy'))).toEqual(['keep.txt']);
  });

  it('reports a failed clone and leaves no folder behind', async () => {
    const parent = tempDir('ide-clone-parent-');
    const result = await clone({ url: join(tempDir('ide-clone-'), 'no-such-repo'), parent, name: 'copy' }).done;
    expect(result).toEqual({ error: expect.stringMatching(/fatal|does not exist|not a git/i) });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('keeps a pre-existing empty folder when the clone fails', async () => {
    const parent = tempDir('ide-clone-parent-');
    mkdirSync(join(parent, 'copy'));
    await clone({ url: join(tempDir('ide-clone-'), 'no-such-repo'), parent, name: 'copy' }).done;
    expect(readdirSync(parent)).toEqual(['copy']);
    expect(readdirSync(join(parent, 'copy'))).toEqual([]);
  });

  it('says git is missing when the command does not exist', async () => {
    const parent = tempDir('ide-clone-parent-');
    expect(await clone({ url: 'https://h/o/r.git', parent, name: 'copy', git: '/nonexistent/git' }).done).toEqual({ error: GIT_NOT_FOUND });
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe('startClone input checks', () => {
  const never = '/nonexistent/git';

  it('refuses an empty url', async () => {
    const parent = tempDir('ide-clone-parent-');
    for (const url of ['', '   ']) expect(await clone({ url, parent, name: 'x', git: never }).done).toEqual({ error: expect.stringMatching(/url/i) });
  });

  it('refuses a url that starts with a dash before git is started', async () => {
    const parent = tempDir('ide-clone-parent-');
    for (const url of ['--upload-pack=touch /tmp/pwned', ' -o x', '-']) {
      expect(await clone({ url, parent, name: 'x', git: never }).done).toEqual({ error: expect.stringContaining('not a repository URL') });
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a name that escapes the parent', async () => {
    const parent = tempDir('ide-clone-parent-');
    expect(await clone({ url: 'https://h/o/r.git', parent, name: '../x', git: never }).done).toEqual({ error: expect.stringMatching(/cannot contain/) });
    expect(await clone({ url: 'https://h/..', parent, git: never }).done).toEqual({ error: expect.stringMatching(/not allowed/) });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('resolves with an error when the url cannot be passed to git', async () => {
    const parent = tempDir('ide-clone-parent-');
    expect(await clone({ url: 'a\0b', parent, name: 'x' }).done).toEqual({ error: expect.any(String) });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a relative or missing parent', async () => {
    const dir = tempDir('ide-clone-');
    expect('error' in (await clone({ url: 'https://h/o/r.git', parent: 'relative', name: 'x', git: never }).done)).toBe(true);
    expect('error' in (await clone({ url: 'https://h/o/r.git', parent: join(dir, 'missing'), name: 'x', git: never }).done)).toBe(true);
  });
});

describe('startClone with a fake git', () => {
  it('runs git clone --progress -- <url> <target> with prompts off and unsafe transports blocked', async () => {
    const parent = tempDir('ide-clone-parent-');
    const out = join(tempDir('ide-clone-out-'), 'record');
    const git = fakeGit(tempDir('ide-fake-git-'), `for last; do :; done\nmkdir -p "$last"\nprintf '%s\\n' "$@" > "${out}"\nprintf '%s %s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_ALLOW_PROTOCOL" >> "${out}"`);
    const result = await clone({ url: '  https://h/o/r.git  ', parent, name: 'copy', git }).done;
    expect(result).toEqual({ root: join(parent, 'copy') });
    expect(readFileSync(out, 'utf8').split('\n')).toEqual(['clone', '--progress', '--', 'https://h/o/r.git', join(parent, 'copy'), '0 https:ssh:git:file', '']);
  });

  it('reports progress, one event per change, including updates separated by carriage returns', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(
      tempDir('ide-fake-git-'),
      'for last; do :; done\nmkdir -p "$last"\nprintf \'Receiving objects:  10%% (1/10)\\rReceiving objects:  55%% (5/10)\\rReceiving objects:  55%% (5/10)\\rResolving deltas: 100%% (3/3), done.\\n\' >&2',
    );
    const run = clone({ url: 'x', parent, name: 'copy', git });
    await run.done;
    expect(run.progress).toEqual([
      { phase: 'receiving', percent: 10 },
      { phase: 'receiving', percent: 55 },
      { phase: 'resolving', percent: 100 },
    ]);
  });

  it('returns the last stderr line when git fails and removes the folder it started', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "fatal: Authentication failed" >&2\nexit 128');
    expect(await clone({ url: 'x', parent, name: 'copy', git }).done).toEqual({ error: 'fatal: Authentication failed' });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('cancels a running clone, waits for git to exit and removes the partial folder', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const run = clone({ url: 'x', parent, name: 'copy', git });
    await waitFor(() => run.progress.length > 0 || undefined, 'the first progress event');
    run.cancel();
    expect(await run.done).toEqual({ error: CLONE_CANCELLED });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('ignores a cancel after the clone has finished, signalling nothing', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"');
    const run = clone({ url: 'x', parent, name: 'copy', git });
    expect(await run.done).toEqual({ root: join(parent, 'copy') });
    const signals = groupSignals();
    run.cancel();
    expect(signals()).toEqual([]);
    expect(existsSync(join(parent, 'copy'))).toBe(true);
  });

  it('kills a git that ignores SIGTERM once the delay has passed, and only once', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\ntrap \'\' TERM\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const run = clone({ url: 'x', parent, name: 'copy', git, killAfterMs: 200 });
    await waitFor(() => run.progress.length > 0 || undefined, 'the first progress event');
    const signals = groupSignals();
    const cancelledAt = Date.now();
    run.cancel();
    run.cancel();
    expect(await run.done).toEqual({ error: CLONE_CANCELLED });
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(150);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('does not send SIGKILL after a cancelled git has already exited', async () => {
    const parent = tempDir('ide-clone-parent-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'for last; do :; done\nmkdir -p "$last"\necho "Receiving objects:  10% (1/10)" >&2\nexec sleep 30');
    const run = clone({ url: 'x', parent, name: 'copy', git, killAfterMs: 100 });
    await waitFor(() => run.progress.length > 0 || undefined, 'the first progress event');
    const signals = groupSignals();
    run.cancel();
    await run.done;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(signals()).toEqual(['SIGTERM']);
  });
});
