import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discardTarget, prepareTarget } from '../../src/project/target';
import { tempDir } from '../helpers';

const ls = (dir: string): string[] => readdirSync(dir).sort();

function fill(dir: string): void {
  mkdirSync(join(dir, '.git', 'objects', 'ab'), { recursive: true });
  writeFileSync(join(dir, '.git', 'objects', 'ab', 'cd'), 'blob');
  writeFileSync(join(dir, '.gitignore'), 'x');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'a');
}

describe('prepareTarget', () => {
  it('marks a missing target as created by this call', () => {
    const parent = tempDir('ide-target-');
    expect(prepareTarget(parent, 'app')).toEqual({ path: join(parent, 'app'), created: true });
  });

  it('accepts a pre-existing empty folder and says it did not create it', () => {
    const parent = tempDir('ide-target-');
    mkdirSync(join(parent, 'empty'));
    expect(prepareTarget(parent, 'empty')).toEqual({ path: join(parent, 'empty'), created: false });
  });

  it('refuses a non-empty folder with an "already exists" error and leaves it alone', () => {
    const parent = tempDir('ide-target-');
    mkdirSync(join(parent, 'taken'));
    writeFileSync(join(parent, 'taken', 'f'), 'mine');
    expect(prepareTarget(parent, 'taken')).toEqual({ error: expect.stringMatching(/already exists/i) });
    expect(readFileSync(join(parent, 'taken', 'f'), 'utf8')).toBe('mine');
  });

  it('refuses an invalid name and creates nothing', () => {
    const parent = tempDir('ide-target-');
    expect(prepareTarget(parent, 'a/b')).toEqual({ error: expect.any(String) });
    expect(ls(parent)).toEqual([]);
  });

  it('refuses a missing parent without creating it', () => {
    const base = tempDir('ide-target-');
    expect(prepareTarget(join(base, 'nope'), 'app')).toEqual({ error: expect.any(String) });
    expect(existsSync(join(base, 'nope'))).toBe(false);
  });
});

describe('discardTarget', () => {
  it('removes a target the call created, with everything inside it', () => {
    const parent = tempDir('ide-target-');
    const target = prepareTarget(parent, 'app');
    if ('error' in target) throw new Error(target.error);
    fill(target.path);
    discardTarget(target);
    expect(ls(parent)).toEqual([]);
  });

  it('empties but keeps a pre-existing folder, dot-files and nested folders included', () => {
    const parent = tempDir('ide-target-');
    mkdirSync(join(parent, 'mine'));
    const target = prepareTarget(parent, 'mine');
    if ('error' in target) throw new Error(target.error);
    fill(target.path);
    discardTarget(target);
    expect(ls(parent)).toEqual(['mine']);
    expect(ls(join(parent, 'mine'))).toEqual([]);
  });

  it('leaves siblings of the target alone', () => {
    const parent = tempDir('ide-target-');
    mkdirSync(join(parent, 'sibling'));
    writeFileSync(join(parent, 'sibling', 'keep'), 'k');
    const target = prepareTarget(parent, 'app');
    if ('error' in target) throw new Error(target.error);
    discardTarget(target);
    expect(ls(parent)).toEqual(['sibling']);
    expect(ls(join(parent, 'sibling'))).toEqual(['keep']);
  });

  it('does not throw when the target is already gone', () => {
    const parent = tempDir('ide-target-');
    expect(() => discardTarget({ path: join(parent, 'gone'), created: true })).not.toThrow();
    expect(() => discardTarget({ path: join(parent, 'gone'), created: false })).not.toThrow();
  });
});
