import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/create';
import { GIT_NOT_FOUND } from '../../src/project/git';
import { tempDir } from '../helpers';
import { fakeGit } from './fake-git';

const ls = (dir: string): string[] => readdirSync(dir).sort();
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup(): { base: string; parent: string; bin: string } {
  const base = tempDir('ide-create-contract-');
  const parent = join(base, 'parent');
  const bin = join(base, 'bin');
  mkdirSync(parent);
  mkdirSync(bin);
  return { base, parent, bin };
}

// Writes junk into every directory under base it is handed (as an argument or as its cwd), then fails.
const junkThenFail = (bin: string, base: string): string =>
  fakeGit(bin, [
    `for a in "$@"; do case "$a" in "${base}"/*) [ -d "$a" ] && echo junk > "$a/junk";; esac; done`,
    `case "$PWD" in "${base}"/*) echo junk > "$PWD/junk";; esac`,
    'printf "hint: something first\\nfatal: cannot init here\\n" >&2',
    'exit 1',
  ].join('\n'));

describe('createProject success', () => {
  it('creates parent/name with a git repository and no commit', async () => {
    const { parent } = setup();
    const result = await createProject({ parent, name: 'app' });
    const root = join(parent, 'app');
    expect(result).toEqual({ root });
    expect(git(root, 'rev-parse', '--show-toplevel')).toBe(root);
    expect(git(root, 'rev-list', '--all')).toBe('');
  });

  it('initializes a pre-existing empty folder in place', async () => {
    const { parent } = setup();
    mkdirSync(join(parent, 'empty'));
    expect(await createProject({ parent, name: 'empty' })).toEqual({ root: join(parent, 'empty') });
    expect(git(join(parent, 'empty'), 'rev-parse', '--show-toplevel')).toBe(join(parent, 'empty'));
  });

  it('accepts a 255-byte name and creates exactly that folder', async () => {
    const { parent } = setup();
    const name = 'n'.repeat(255);
    expect(await createProject({ parent, name })).toEqual({ root: join(parent, name) });
    expect(existsSync(join(parent, name, '.git'))).toBe(true);
  });

  it('creates a folder with a unicode name', async () => {
    const { parent } = setup();
    expect(await createProject({ parent, name: 'проект' })).toEqual({ root: join(parent, 'проект') });
    expect(existsSync(join(parent, 'проект', '.git'))).toBe(true);
  });

  it('creates the project inside the real folder when the parent is a symlink', async () => {
    const { base, parent } = setup();
    symlinkSync(parent, join(base, 'link'));
    const result = await createProject({ parent: join(base, 'link'), name: 'via-link' });
    expect('root' in result).toBe(true);
    expect(existsSync(join(parent, 'via-link', '.git'))).toBe(true);
  });

  it('runs git init for the target folder', async () => {
    const { parent, bin } = setup();
    const record = join(bin, 'record');
    const fake = fakeGit(bin, `echo "$PWD" > "${record}"\nfor a in "$@"; do echo "$a" >> "${record}"; done\nexit 0`);
    expect(await createProject({ parent, name: 'rec', git: fake })).toEqual({ root: join(parent, 'rec') });
    const [cwd, ...args] = readFileSync(record, 'utf8').trim().split('\n');
    expect(args).toContain('init');
    expect(cwd === join(parent, 'rec') || args.includes(join(parent, 'rec'))).toBe(true);
  });

  it('refuses a second create of the same name, leaving the first project intact', async () => {
    const { parent } = setup();
    await createProject({ parent, name: 'twice' });
    writeFileSync(join(parent, 'twice', 'work.txt'), 'mine');
    const second = await createProject({ parent, name: 'twice' });
    expect(second).toEqual({ error: expect.stringMatching(/already exists/i) });
    expect(readFileSync(join(parent, 'twice', 'work.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(parent, 'twice', '.git'))).toBe(true);
  });
});

describe('createProject refuses a taken target without touching it', () => {
  it('a non-empty folder: error, the user file unchanged, no .git added', async () => {
    const { parent } = setup();
    mkdirSync(join(parent, 'taken'));
    writeFileSync(join(parent, 'taken', 'notes.txt'), 'keep me');
    const result = await createProject({ parent, name: 'taken' });
    expect(result).toEqual({ error: expect.stringMatching(/already exists/i) });
    expect(ls(join(parent, 'taken'))).toEqual(['notes.txt']);
    expect(readFileSync(join(parent, 'taken', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('a folder holding only a dot-file counts as non-empty', async () => {
    const { parent } = setup();
    mkdirSync(join(parent, 'dotted'));
    writeFileSync(join(parent, 'dotted', '.env'), 'SECRET=1');
    expect(await createProject({ parent, name: 'dotted' })).toEqual({ error: expect.any(String) });
    expect(ls(join(parent, 'dotted'))).toEqual(['.env']);
  });

  it('a file: error, the file unchanged', async () => {
    const { parent } = setup();
    writeFileSync(join(parent, 'file'), 'data');
    expect(await createProject({ parent, name: 'file' })).toEqual({ error: expect.any(String) });
    expect(readFileSync(join(parent, 'file'), 'utf8')).toBe('data');
  });

  it('a dangling symlink: error, the link still there', async () => {
    const { base, parent } = setup();
    symlinkSync(join(base, 'missing'), join(parent, 'dangling'));
    expect(await createProject({ parent, name: 'dangling' })).toEqual({ error: expect.any(String) });
    expect(lstatSync(join(parent, 'dangling')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(base, 'missing'))).toBe(false);
  });

  it('a symlink to a non-empty folder: error, the linked folder unchanged', async () => {
    const { base, parent } = setup();
    mkdirSync(join(base, 'elsewhere'));
    writeFileSync(join(base, 'elsewhere', 'a.txt'), 'a');
    symlinkSync(join(base, 'elsewhere'), join(parent, 'link'));
    expect(await createProject({ parent, name: 'link' })).toEqual({ error: expect.any(String) });
    expect(ls(join(base, 'elsewhere'))).toEqual(['a.txt']);
  });
});

describe('createProject validates the name before touching the disk', () => {
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a dot', '.'],
    ['two dots', '..'],
    ['a slash', 'a/b'],
    ['a NUL', 'a\0b'],
    ['256 bytes', 'n'.repeat(256)],
    ['256 bytes of two-byte characters', 'é'.repeat(128)],
  ])('rejects %s and creates nothing', async (_label, name) => {
    const { base, parent } = setup();
    const result = await createProject({ parent, name });
    expect(result).toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
    expect(ls(base)).toEqual(['bin', 'parent']);
  });

  it.each([' . ', ' .. ', '.. '])('never initializes the parent or its parent for %j', async (name) => {
    const { base, parent } = setup();
    await createProject({ parent, name });
    expect(existsSync(join(parent, '.git'))).toBe(false);
    expect(existsSync(join(base, '.git'))).toBe(false);
  });
});

describe('createProject validates the parent', () => {
  it('rejects a missing parent and does not create it', async () => {
    const { base } = setup();
    const result = await createProject({ parent: join(base, 'nope'), name: 'app' });
    expect(result).toEqual({ error: expect.any(String) });
    expect(existsSync(join(base, 'nope'))).toBe(false);
  });

  it('rejects a parent that is a file and leaves the file alone', async () => {
    const { base } = setup();
    writeFileSync(join(base, 'plain'), 'x');
    expect(await createProject({ parent: join(base, 'plain'), name: 'app' })).toEqual({ error: expect.any(String) });
    expect(readFileSync(join(base, 'plain'), 'utf8')).toBe('x');
  });

  it('rejects a parent that is not writable and creates nothing', async () => {
    const { parent } = setup();
    chmodSync(parent, 0o555);
    try {
      expect(await createProject({ parent, name: 'app' })).toEqual({ error: expect.any(String) });
      expect(ls(parent)).toEqual([]);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('rejects a relative parent even when it resolves to an existing folder (assumption)', async () => {
    const { parent } = setup();
    const rel = relative(process.cwd(), parent);
    expect(rel.startsWith('/')).toBe(false);
    expect(await createProject({ parent: rel, name: 'app' })).toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
  });

  it('resolves, not rejects, for a parent containing a NUL', async () => {
    const { base } = setup();
    await expect(createProject({ parent: `${base}/a\0b`, name: 'app' })).resolves.toEqual({ error: expect.any(String) });
  });
});

describe('createProject when git init fails', () => {
  it('removes the folder it created, including what git wrote into it', async () => {
    const { base, parent, bin } = setup();
    const result = await createProject({ parent, name: 'app', git: junkThenFail(bin, base) });
    expect(result).toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
  });

  it('reports git\'s error line (assumption: same rule as clone)', async () => {
    const { base, parent, bin } = setup();
    const result = await createProject({ parent, name: 'app', git: junkThenFail(bin, base) });
    expect(result).toEqual({ error: expect.stringContaining('cannot init here') });
  });

  it('keeps a pre-existing empty folder', async () => {
    const { base, parent, bin } = setup();
    mkdirSync(join(parent, 'mine'));
    await createProject({ parent, name: 'mine', git: junkThenFail(bin, base) });
    expect(existsSync(join(parent, 'mine'))).toBe(true);
    expect(lstatSync(join(parent, 'mine')).isDirectory()).toBe(true);
  });

  it('keeps a symlinked empty folder and the link itself', async () => {
    const { base, parent, bin } = setup();
    mkdirSync(join(base, 'real-empty'));
    symlinkSync(join(base, 'real-empty'), join(parent, 'link'));
    await createProject({ parent, name: 'link', git: junkThenFail(bin, base) });
    expect(lstatSync(join(parent, 'link')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(base, 'real-empty')).isDirectory()).toBe(true);
  });

  it('keeps sibling folders of the parent', async () => {
    const { base, parent, bin } = setup();
    mkdirSync(join(parent, 'sibling'));
    writeFileSync(join(parent, 'sibling', 'f'), 'f');
    await createProject({ parent, name: 'app', git: junkThenFail(bin, base) });
    expect(ls(parent)).toEqual(['sibling']);
    expect(ls(join(parent, 'sibling'))).toEqual(['f']);
  });
});

describe('createProject without git', () => {
  it('reports that git was not found and removes the folder it created', async () => {
    const { base, parent } = setup();
    expect(await createProject({ parent, name: 'app', git: join(base, 'no-such-git') })).toEqual({ error: GIT_NOT_FOUND });
    expect(ls(parent)).toEqual([]);
  });

  it('keeps a pre-existing empty folder when git is missing', async () => {
    const { base, parent } = setup();
    mkdirSync(join(parent, 'mine'));
    expect(await createProject({ parent, name: 'mine', git: join(base, 'no-such-git') })).toEqual({ error: GIT_NOT_FOUND });
    expect(ls(parent)).toEqual(['mine']);
  });

  it('resolves with an error when the git path is a directory', async () => {
    const { parent, bin } = setup();
    await expect(createProject({ parent, name: 'app', git: bin })).resolves.toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
  });
});
