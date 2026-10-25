import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homesOf, scratchProblem } from '../../scripts/background-smoke';
import { tempDir } from '../helpers';

describe('the background smoke guard', () => {
  it('refuses any home that is inside, holds or links into ~/.ide, ~/.codex or an opencode home, an account home of any engine included, and lets scratch homes through', () => {
    const owner = tempDir('bg-smoke-owner-');
    for (const dir of ['.ide', 'dotfiles/codex', '.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cache/opencode']) mkdirSync(join(owner, dir), { recursive: true });
    // An owner home that is itself a link, as dotfile managers make them.
    symlinkSync(join(owner, 'dotfiles', 'codex'), join(owner, '.codex'));
    const scratch = tempDir('bg-smoke-scratch-');
    const refused = (homes: Array<readonly [string, string | undefined]>): string | null => scratchProblem(homes, owner);

    expect(refused([['--ide-home', scratch], ['IDE_HOME', undefined], ['XDG_DATA_HOME', ''], ['CODEX_HOME', join(owner, '.idea')]])).toBeNull();
    expect(refused([['--ide-home', join(owner, '.ide', 'smoke')]])).toContain(join(owner, '.ide'));
    expect(refused([['IDE_HOME', owner]])).toMatch(/^IDE_HOME .* overlaps/);
    expect(refused([['XDG_CONFIG_HOME', join(owner, '.config')]])).toContain(join(owner, '.config', 'opencode'));
    expect(refused([['XDG_CACHE_HOME', join(owner, '.cache', 'opencode', 'deeper')]])).toContain('.cache/opencode');

    // A Codex account home linked to ~/.codex in an otherwise scratch IDE home, and the XDG homes of the environment.
    mkdirSync(join(scratch, 'codex-accounts'));
    symlinkSync(join(owner, '.codex'), join(scratch, 'codex-accounts', 'linked'));
    expect(refused(homesOf(scratch, {}))).toMatch(/^the Codex account home linked .* overlaps .*dotfiles\/codex/);
    expect(refused(homesOf(undefined, { IDE_HOME: scratch }))).toMatch(/^the Codex account home linked/);
    // So are an opencode or Claude profile home linked into an opencode home or ~/.ide.
    const other = tempDir('bg-smoke-scratch-');
    for (const dir of ['opencode-accounts', 'claude-accounts']) mkdirSync(join(other, dir));
    symlinkSync(join(owner, '.config', 'opencode'), join(other, 'opencode-accounts', 'work'));
    symlinkSync(join(owner, '.ide'), join(other, 'claude-accounts', 'home'));
    expect(homesOf(other, {}).map((home) => refused([home])).filter((problem) => problem !== null)).toEqual([
      expect.stringMatching(/^the Claude Code account home home .* overlaps .*\/\.ide/), expect.stringMatching(/^the opencode account home work .* overlaps .*\/\.config\/opencode/),
    ]);
    expect(refused(homesOf(undefined, { XDG_STATE_HOME: join(owner, '.local', 'state'), CODEX_HOME: scratch }))).toMatch(/^XDG_STATE_HOME/);
    expect(refused(homesOf(undefined, { CODEX_HOME: join(owner, 'dotfiles', 'codex', 'sub') }))).toMatch(/^CODEX_HOME/);
  });
});
