import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Policy } from '@ide/protocol';
import { classifyPaths, realTarget } from '../../src/gate/paths';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { tempDir, writeTree } from '../helpers';

async function project(files: Record<string, string> = {}, git = true): Promise<string> {
  const root = tempDir('ide-gate-');
  await writeTree(root, { 'src/app.ts': 'export {};\n', ...files });
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

interface Options {
  policy?: Partial<Policy>;
  home?: string;
  tempRoots?: string[];
}

async function classes(root: string, paths: string[], options: Options = {}) {
  const infos = await classifyPaths(paths.map((path) => (path.startsWith('/') ? path : join(root, path))), {
    root,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    home: options.home ?? tempDir('ide-fake-home-'),
    tempRoots: options.tempRoots ?? [],
  });
  return infos.map((info) => [info.rel ?? info.abs, info.cls, info.why]);
}

describe('realTarget', () => {
  it('resolves a relative path against the working directory', () => {
    const root = tempDir('ide-gate-');
    expect(realTarget('src/app.ts', root)).toBe(join(root, 'src/app.ts'));
  });

  it('resolves a file that does not exist yet through the real path of its nearest existing ancestor', () => {
    const real = tempDir('ide-real-');
    const alias = join(tempDir('ide-alias-'), 'alias');
    symlinkSync(real, alias);
    expect(realTarget(join(alias, 'a', 'b.txt'), '/')).toBe(join(real, 'a', 'b.txt'));
  });

  it('follows a symlink inside the project to where it points', async () => {
    const root = await project();
    const outside = tempDir('ide-outside-');
    symlinkSync(outside, join(root, 'link'));
    expect(realTarget('link/f.txt', root)).toBe(join(outside, 'f.txt'));
  });

  it('normalizes .. before resolving', () => {
    const root = tempDir('ide-gate-');
    expect(realTarget('src/../../escape.txt', root)).toBe(join(dirname(root), 'escape.txt'));
  });

  it('resolves a wrong-case existing path to the on-disk case (or a different, new path on a case-sensitive filesystem)', () => {
    const root = tempDir('ide-gate-');
    writeFileSync(join(root, 'CaseFile.txt'), '');
    const caseInsensitive = existsSync(join(root, 'casefile.txt'));
    const target = realTarget('casefile.txt', root);
    if (caseInsensitive) {
      expect(target).toBe(join(root, 'CaseFile.txt'));
    } else {
      expect(target).toBe(join(root, 'casefile.txt'));
    }
  });
});

describe('classifyPaths', () => {
  it('enforces existing and new project files', async () => {
    const root = await project();
    expect(await classes(root, ['src/app.ts', 'src/new.ts'])).toEqual([
      ['src/app.ts', 'enforced', 'a project file'],
      ['src/new.ts', 'enforced', 'a project file'],
    ]);
  });

  it('records gitignored files, existing or not', async () => {
    const root = await project({ '.gitignore': 'dist/\n', 'dist/app.js': '' });
    expect(await classes(root, ['dist/app.js', 'dist/new.js'])).toEqual([
      ['dist/app.js', 'recorded', 'gitignored'],
      ['dist/new.js', 'recorded', 'gitignored'],
    ]);
  });

  it('honors a nested .gitignore', async () => {
    const root = await project({ 'sub/.gitignore': '*.log\n' });
    expect(await classes(root, ['sub/x.log', 'x.log'])).toEqual([
      ['sub/x.log', 'recorded', 'gitignored'],
      ['x.log', 'enforced', 'a project file'],
    ]);
  });

  it('keeps a tracked file enforced when a gitignore pattern matches it', async () => {
    const root = await project({ 'build/keep.txt': 'k' });
    execFileSync('git', ['add', 'build/keep.txt'], { cwd: root });
    await writeTree(root, { '.gitignore': 'build/\n' });
    expect(await classes(root, ['build/keep.txt', 'build/other.txt'])).toEqual([
      ['build/keep.txt', 'enforced', 'a project file'],
      ['build/other.txt', 'recorded', 'gitignored'],
    ]);
  });

  it('guards secrets at any depth even when they are gitignored', async () => {
    const root = await project({ '.gitignore': '.env*\n' });
    const infos = await classifyPaths([join(root, '.env.local'), join(root, 'backend/.env')], { root, policy: DEFAULT_POLICY, tempRoots: [] });
    expect(infos.map((info) => [info.rel, info.cls, info.guarded])).toEqual([
      ['.env.local', 'enforced', true],
      ['backend/.env', 'enforced', true],
    ]);
  });

  it('records harness paths and git internals, and guards git hooks and git config', async () => {
    const root = await project();
    expect(await classes(root, ['.omc/state.json', '.git/HEAD', '.git/hooks/pre-commit', '.git/config'])).toEqual([
      ['.omc/state.json', 'recorded', 'a harness path'],
      ['.git/HEAD', 'recorded', 'git internals'],
      ['.git/hooks/pre-commit', 'enforced', 'a guarded path'],
      ['.git/config', 'enforced', 'a guarded path'],
    ]);
  });

  it('keeps a guarded path enforced when it is also a harness path', async () => {
    const root = await project();
    expect(await classes(root, ['.claude/settings.json'], { policy: { harness: ['.claude/'] } })).toEqual([
      ['.claude/settings.json', 'enforced', 'a guarded path'],
    ]);
  });

  it('guards a directory target inside the guarded list', async () => {
    const root = await project();
    mkdirSync(join(root, '.claude'));
    expect(await classes(root, ['.claude'])).toEqual([['.claude', 'enforced', 'a guarded path']]);
  });

  it('treats OS temp directories and devices as temp', async () => {
    const root = await project();
    const scratch = tempDir('ide-scratch-');
    expect(await classes(root, [join(scratch, 'x.txt'), '/dev/null'], { tempRoots: [scratch] })).toEqual([
      [join(scratch, 'x.txt'), 'temp', 'a temporary directory'],
      ['/dev/null', 'temp', 'a device'],
    ]);
  });

  it('keeps the files of a project inside a temp directory enforced', async () => {
    const root = await project();
    expect(await classes(root, ['src/app.ts'], { tempRoots: [dirname(root)] })).toEqual([['src/app.ts', 'enforced', 'a project file']]);
  });

  it("allows Claude Code's plan and memory files outside the project, and nothing else under ~/.claude", async () => {
    const root = await project();
    const home = tempDir('ide-fake-home-');
    mkdirSync(join(home, '.claude/plans'), { recursive: true });
    expect(await classes(root, [
      join(home, '.claude/plans/p.md'),
      join(home, '.claude/plans'),
      join(home, '.claude/projects/-work-app/memory/m.md'),
      join(home, '.claude/settings.json'),
    ], { home })).toEqual([
      [join(home, '.claude/plans/p.md'), 'temp', 'allowed outside the project'],
      [join(home, '.claude/plans'), 'temp', 'allowed outside the project'],
      [join(home, '.claude/projects/-work-app/memory/m.md'), 'temp', 'allowed outside the project'],
      [join(home, '.claude/settings.json'), 'outside', 'outside the project'],
    ]);
  });

  it('classifies a write through a symlink by where it lands', async () => {
    const root = await project();
    const outside = tempDir('ide-outside-');
    symlinkSync(outside, join(root, 'link'));
    expect(await classes(root, [realTarget('link/f.txt', root)])).toEqual([[join(outside, 'f.txt'), 'outside', 'outside the project']]);
  });

  it('classifies a dangling symlink in a temp directory by the missing project file it points to', async () => {
    const root = await project();
    const scratch = tempDir('ide-scratch-');
    symlinkSync(join(root, 'src/new.ts'), join(scratch, 'link'));
    expect(await classes(root, [realTarget(join(scratch, 'link'), '/')], { tempRoots: [scratch] })).toEqual([['src/new.ts', 'enforced', 'a project file']]);
  });

  it('classifies a dangling symlink in the project by the missing file outside it points to', async () => {
    const root = await project();
    const outside = tempDir('ide-outside-');
    symlinkSync(join(outside, 'out.ts'), join(root, 'src/out.ts'));
    expect(await classes(root, [realTarget('src/out.ts', root)])).toEqual([[join(outside, 'out.ts'), 'outside', 'outside the project']]);
  });

  it('follows a chain of dangling symlinks, relative targets from the directory of each link', async () => {
    const root = await project();
    const scratch = tempDir('ide-scratch-');
    symlinkSync(join(root, 'src/second'), join(scratch, 'first'));
    symlinkSync('new.ts', join(root, 'src/second'));
    expect(await classes(root, [realTarget(join(scratch, 'first'), '/')], { tempRoots: [scratch] })).toEqual([['src/new.ts', 'enforced', 'a project file']]);
  });

  it('stops following a loop of symlinks', () => {
    const scratch = tempDir('ide-scratch-');
    symlinkSync(join(scratch, 'b'), join(scratch, 'a'));
    symlinkSync(join(scratch, 'a'), join(scratch, 'b'));
    expect([join(scratch, 'a'), join(scratch, 'b')]).toContain(realTarget(join(scratch, 'a'), '/'));
  });

  it('leaves every path enforced when the project is not a git repository', async () => {
    const root = await project({ '.gitignore': 'dist/\n' }, false);
    expect(await classes(root, ['dist/app.js'])).toEqual([['dist/app.js', 'enforced', 'a project file']]);
  });
});
