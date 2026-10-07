import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitOps } from '../../src/history/git-ops';
import { tempDir, writeTree } from '../helpers';
import { git, isolateGit, tryGit } from '../worktree-fixture';

isolateGit();

describe('GitOps after a rebase that stops on a conflict', () => {
  it('names as git what now holds what HEAD holds, what git deleted and its conflict, but not what was written over or brought back', async () => {
    const root = tempDir('git-ops-');
    git(root, 'init', '-q');
    await writeTree(root, { 'x.txt': 'x\n', 'y.txt': 'y\n', 'z.txt': 'z\n', 'd.txt': 'd\n', 'c.txt': 'c\n' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'branch', '-M', 'main');
    git(root, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(root, 'c.txt'), 'feat\n');
    git(root, 'commit', '-q', '-am', 'feat');
    git(root, 'checkout', '-q', 'main');
    await writeTree(root, { 'x.txt': 'x2\n', 'y.txt': 'y2\n', 'c.txt': 'main\n' });
    git(root, 'rm', '-q', 'z.txt', 'd.txt');
    git(root, 'commit', '-q', '-am', 'main');
    git(root, 'checkout', '-q', 'feat');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    tryGit(root, 'rebase', 'main');
    await writeTree(root, { 'y.txt': 'agent\n', 'z.txt': 'agent\n' });

    const ops = new GitOps({ root, settle: async () => {} });
    ops.begin({
      toolUseId: 't1', parentToolUseId: null, tool: 'Bash', toolClass: 'shell', targets: [], allTracked: false, cwdRel: null, background: false,
      allowedOnce: false, history: [{ dir: '', top: root, head }],
    });
    await ops.end('t1');

    expect([...ops.moved('t1')!].sort()).toEqual(['c.txt', 'd.txt', 'x.txt']);
  });
});
