import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectories } from '../../src/project/browse';
import { tempDir } from '../helpers';

const names = (listing: { entries: { name: string }[] }) => listing.entries.map((e) => e.name);

describe('listDirectories', () => {
  it('lists only directories, not files', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'file.txt'), 'x');
    const listing = listDirectories(root, '/unused');
    expect(names(listing)).toEqual(['dir']);
    expect(listing).toMatchObject({ path: root, error: null });
  });

  it('hides directories whose name starts with a dot', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, '.hidden'));
    mkdirSync(join(root, 'shown'));
    expect(names(listDirectories(root, '/unused'))).toEqual(['shown']);
  });

  it('marks a folder with a .git directory as a git project', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'plain'));
    expect(listDirectories(root, '/unused').entries).toEqual([
      { name: 'plain', isGit: false },
      { name: 'repo', isGit: true },
    ]);
  });

  it('marks a folder with a .git file (worktree) as a git project', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'wt'));
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere');
    expect(listDirectories(root, '/unused').entries).toEqual([{ name: 'wt', isGit: true }]);
  });

  it('sorts names case-insensitively', () => {
    const root = tempDir('ide-browse-');
    for (const name of ['beta', 'Alpha', 'gamma', 'Delta', 'Zulu', 'apple']) mkdirSync(join(root, name));
    expect(names(listDirectories(root, '/unused'))).toEqual(['Alpha', 'apple', 'beta', 'Delta', 'gamma', 'Zulu']);
  });

  it('lists a symlink to a directory as a directory', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'target'));
    symlinkSync(join(root, 'target'), join(root, 'link'));
    expect(names(listDirectories(root, '/unused'))).toEqual(['link', 'target']);
  });

  it('skips a symlink to a file and a dangling symlink without failing', () => {
    const root = tempDir('ide-browse-');
    writeFileSync(join(root, 'f'), 'x');
    symlinkSync(join(root, 'f'), join(root, 'to-file'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    mkdirSync(join(root, 'real'));
    const listing = listDirectories(root, '/unused');
    expect(names(listing)).toEqual(['real']);
    expect(listing.error).toBeNull();
  });

  it('reports the real path when the requested path is a symlink', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'target', 'inner'), { recursive: true });
    symlinkSync(join(root, 'target'), join(root, 'link'));
    const listing = listDirectories(join(root, 'link'), '/unused');
    expect(listing.path).toBe(join(root, 'target'));
    expect(names(listing)).toEqual(['inner']);
  });

  it('returns the parent directory of the listed folder', () => {
    const root = tempDir('ide-browse-');
    mkdirSync(join(root, 'child'));
    expect(listDirectories(join(root, 'child'), '/unused').parent).toBe(root);
  });

  it('returns an error and no entries for a nonexistent path without throwing', () => {
    const root = tempDir('ide-browse-');
    const listing = listDirectories(join(root, 'nope'), '/unused');
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeTruthy();
    expect(listing.parent).toBeNull();
  });

  it('returns an error and no entries when the path is a file', () => {
    const root = tempDir('ide-browse-');
    writeFileSync(join(root, 'f.txt'), 'x');
    const listing = listDirectories(join(root, 'f.txt'), '/unused');
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeTruthy();
  });

  it('lists the home directory when the path is null', () => {
    const home = tempDir('ide-home-');
    mkdirSync(join(home, 'projects'));
    const listing = listDirectories(null, home);
    expect(listing).toMatchObject({ path: home, error: null });
    expect(names(listing)).toEqual(['projects']);
  });

  it('has no parent at the filesystem root', () => {
    const listing = listDirectories('/', '/unused');
    expect(listing.path).toBe('/');
    expect(listing.parent).toBeNull();
    expect(listing.error).toBeNull();
  });
});
