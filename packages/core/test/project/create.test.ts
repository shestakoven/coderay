import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/create';
import { GIT_NOT_FOUND } from '../../src/project/git';
import { tempDir } from '../helpers';
import { fakeGit } from './fake-git';

const toplevel = (dir: string): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();

describe('createProject', () => {
  it('creates the folder and makes it its own git repository', async () => {
    const parent = tempDir('ide-create-');
    expect(await createProject({ parent, name: 'app' })).toEqual({ root: join(parent, 'app') });
    expect(toplevel(join(parent, 'app'))).toBe(join(parent, 'app'));
  });

  it('makes no commit', async () => {
    const parent = tempDir('ide-create-');
    await createProject({ parent, name: 'app' });
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: join(parent, 'app'), stdio: 'ignore' })).toThrow();
  });

  it('trims the name', async () => {
    const parent = tempDir('ide-create-');
    expect(await createProject({ parent, name: '  app  ' })).toEqual({ root: join(parent, 'app') });
  });

  it('accepts a non-ASCII name', async () => {
    const parent = tempDir('ide-create-');
    expect(await createProject({ parent, name: 'проект' })).toEqual({ root: join(parent, 'проект') });
  });

  it.each(['', '   ', '.', '..', 'a/b', 'a\0b', 'a'.repeat(256)])('refuses the name %j and creates nothing', async (name) => {
    const parent = tempDir('ide-create-');
    expect(await createProject({ parent, name })).toEqual({ error: expect.any(String) });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('initialises inside an existing empty folder', async () => {
    const parent = tempDir('ide-create-');
    mkdirSync(join(parent, 'app'));
    expect(await createProject({ parent, name: 'app' })).toEqual({ root: join(parent, 'app') });
    expect(toplevel(join(parent, 'app'))).toBe(join(parent, 'app'));
  });

  it('refuses an existing folder that has files and leaves them alone', async () => {
    const parent = tempDir('ide-create-');
    mkdirSync(join(parent, 'app'));
    writeFileSync(join(parent, 'app', 'keep.txt'), 'mine');
    expect(await createProject({ parent, name: 'app' })).toEqual({ error: expect.stringContaining('already exists') });
    expect(readFileSync(join(parent, 'app', 'keep.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(join(parent, 'app'))).toEqual(['keep.txt']);
  });

  it('refuses a name that is an existing file', async () => {
    const parent = tempDir('ide-create-');
    writeFileSync(join(parent, 'app'), 'file');
    expect(await createProject({ parent, name: 'app' })).toEqual({ error: expect.any(String) });
    expect(readFileSync(join(parent, 'app'), 'utf8')).toBe('file');
  });

  it('refuses a relative, a missing and a non-folder parent with different messages', async () => {
    const dir = tempDir('ide-create-');
    writeFileSync(join(dir, 'f'), 'x');
    const results = await Promise.all([
      createProject({ parent: 'relative', name: 'app' }),
      createProject({ parent: join(dir, 'missing'), name: 'app' }),
      createProject({ parent: join(dir, 'f'), name: 'app' }),
    ]);
    const errors = results.map((result) => ('error' in result ? result.error : ''));
    expect(errors.every((error) => error !== '')).toBe(true);
    expect(new Set(errors).size).toBe(3);
  });

  it('resolves a symlinked parent to its real path', async () => {
    const dir = tempDir('ide-create-');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(await createProject({ parent: join(dir, 'link'), name: 'app' })).toEqual({ root: join(dir, 'real', 'app') });
  });

  it('removes the folder it created when git init fails, and reports git\'s last line', async () => {
    const parent = tempDir('ide-create-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'echo "fatal: no" >&2\nexit 1');
    expect(await createProject({ parent, name: 'app', git })).toEqual({ error: 'fatal: no' });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('reports the fatal: line of git init, not the hint that follows it', async () => {
    const parent = tempDir('ide-create-');
    const git = fakeGit(tempDir('ide-fake-git-'), 'echo "fatal: cannot mkdir .git" >&2\necho "hint: try again" >&2\nexit 128');
    expect(await createProject({ parent, name: 'app', git })).toEqual({ error: 'fatal: cannot mkdir .git' });
  });

  it('keeps a pre-existing empty folder when git init fails', async () => {
    const parent = tempDir('ide-create-');
    mkdirSync(join(parent, 'app'));
    const git = fakeGit(tempDir('ide-fake-git-'), 'exit 1');
    expect('error' in (await createProject({ parent, name: 'app', git }))).toBe(true);
    expect(readdirSync(parent)).toEqual(['app']);
  });

  it('says git is missing when the command does not exist, and creates nothing', async () => {
    const parent = tempDir('ide-create-');
    expect(await createProject({ parent, name: 'app', git: '/nonexistent/git' })).toEqual({ error: GIT_NOT_FOUND });
    expect(readdirSync(parent)).toEqual([]);
  });
});
