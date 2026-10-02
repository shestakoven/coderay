import { describe, expect, it } from 'vitest';
import { gitIgnored } from '../../src/gate/gitignore';
import { tempDir } from '../helpers';
import { addSubmodule, isolateGit, monorepoWithWorktree, projectWithWorktree, submoduleSource } from '../worktree-fixture';

isolateGit();

async function projectWithSubmodules(): Promise<string> {
  const [first, second] = [await submoduleSource(), await submoduleSource()];
  const { root } = await projectWithWorktree({}, '.worktrees/wt1', (repo) => {
    addSubmodule(repo, first, 'vendor/lib');
    addSubmodule(repo, second, 'third/other');
  });
  return root;
}

const sorted = (check: { ignored: Set<string>; submodule: Set<string> }) => ({ ignored: [...check.ignored].sort(), submodule: [...check.submodule].sort() });

describe('gitIgnored', () => {
  it('reports the ignored paths of a batch that holds no submodule path', async () => {
    const root = await projectWithSubmodules();
    expect(sorted(await gitIgnored(root, ['dist/x.js', 'backend/src/a.py', '.worktrees/wt1/README.md']))).toEqual({ ignored: ['.worktrees/wt1/README.md', 'dist/x.js'], submodule: [] });
  });

  it('sets a path inside a submodule apart, which git refuses the whole batch for, and still checks the other paths', async () => {
    const root = await projectWithSubmodules();
    expect(sorted(await gitIgnored(root, ['dist/x.js', 'vendor/lib/lib.py', 'backend/src/a.py']))).toEqual({ ignored: ['dist/x.js'], submodule: ['vendor/lib/lib.py'] });
  });

  it('does so for several submodules and for nested paths in one batch, whatever their order', async () => {
    const root = await projectWithSubmodules();
    const batch = ['third/other/deep/dir/y.py', 'dist/x.js', 'vendor/lib/lib.py', '.worktrees/wt1/q', 'backend/src/a.py', 'vendor/lib/sub/z.py'];
    expect(sorted(await gitIgnored(root, batch))).toEqual({
      ignored: ['.worktrees/wt1/q', 'dist/x.js'],
      submodule: ['third/other/deep/dir/y.py', 'vendor/lib/lib.py', 'vendor/lib/sub/z.py'],
    });
  });

  it('does not take the directory of a submodule itself for a path inside it', async () => {
    const root = await projectWithSubmodules();
    expect(sorted(await gitIgnored(root, ['vendor/lib', 'dist/x.js']))).toEqual({ ignored: ['dist/x.js'], submodule: [] });
  });

  it('names the submodule paths of a project that is a directory of a larger repository, as they were given', async () => {
    const { repo, root } = await monorepoWithWorktree();
    addSubmodule(repo, await submoduleSource(), 'packages/app/vendor/lib');
    expect(sorted(await gitIgnored(root, ['vendor/lib/lib.py', 'dist/x.js', 'src/a.py']))).toEqual({ ignored: ['dist/x.js'], submodule: ['vendor/lib/lib.py'] });
  });

  it('leaves every path enforced when git fails for any other reason', async () => {
    const root = await projectWithSubmodules();
    expect(sorted(await gitIgnored(root, ['dist/x.js', '../outside.py']))).toEqual({ ignored: [], submodule: [] });
    expect(sorted(await gitIgnored(tempDir('gi-plain-'), ['dist/x.js']))).toEqual({ ignored: [], submodule: [] });
  });

  it('answers at once for no paths', async () => {
    expect(sorted(await gitIgnored(tempDir('gi-none-'), []))).toEqual({ ignored: [], submodule: [] });
  });
});
