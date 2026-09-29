import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectDir } from '../../src/home';
import { DEFAULT_POLICY, PolicyStore } from '../../src/policy/policy';
import { tempDir } from '../helpers';

function setup(home = tempDir('ide-home-')) {
  const root = tempDir('ide-root-');
  return { home, root, policy: new PolicyStore({ home, root }) };
}

describe('PolicyStore', () => {
  it('uses the default policy when no policy file exists', () => {
    expect(setup().policy.effective()).toEqual(DEFAULT_POLICY);
  });

  it('protects secrets, git hooks, config and exclude rules, the IDE config and Claude settings by default, and allows Claude plan and memory files outside the project', () => {
    expect(DEFAULT_POLICY).toEqual({
      mode: 'B',
      guarded: ['.env*', '.git/hooks/', '.git/config', '.git/info/', '.ide/mcp.json', '.claude/'],
      harness: ['.omc/'],
      outsideAllowed: ['~/.claude/plans/', '~/.claude/projects/*/memory/'],
      autoApproveMaxFiles: 3,
    });
  });

  it('lets the project override replace only the IDE-level fields it sets', () => {
    const { policy } = setup();
    policy.save('ide', { mode: 'A', autoApproveMaxFiles: 2 });
    policy.save('project', { mode: 'C', guarded: ['.env*'] });
    expect(policy.effective()).toEqual({ ...DEFAULT_POLICY, mode: 'C', autoApproveMaxFiles: 2, guarded: ['.env*'] });
  });

  it('keeps the overrides of two projects on one machine apart', () => {
    const first = setup();
    const second = setup(first.home);
    first.policy.save('project', { mode: 'A' });
    expect([first.policy.effective().mode, second.policy.effective().mode]).toEqual(['A', 'B']);
  });

  it('clears the project override when it is saved empty', () => {
    const { policy } = setup();
    policy.save('project', { mode: 'C' });
    policy.save('project', {});
    expect(policy.effective()).toEqual(DEFAULT_POLICY);
  });

  it('writes both policy files readable only by the user', () => {
    const { home, root, policy } = setup();
    policy.save('ide', { mode: 'A' });
    policy.save('project', { mode: 'C' });
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect([mode(join(home, 'policy.json')), mode(join(projectDir(home, root), 'policy.json'))]).toEqual([0o600, 0o600]);
  });

  it('refuses an unknown mode, a file limit outside 0–50, a relative outside path and an unknown field', () => {
    const { policy } = setup();
    expect(() => policy.save('ide', { mode: 'D' })).toThrow('"mode" must be "A", "B" or "C"');
    expect(() => policy.save('ide', { autoApproveMaxFiles: -1 })).toThrow('"autoApproveMaxFiles" must be a whole number from 0 to 50');
    expect(() => policy.save('ide', { autoApproveMaxFiles: 51 })).toThrow('"autoApproveMaxFiles" must be a whole number from 0 to 50');
    expect(() => policy.save('ide', { outsideAllowed: ['notes/'] })).toThrow('"outsideAllowed" entries must be absolute paths or start with ~/');
    expect(() => policy.save('ide', { colour: 'red' })).toThrow('unknown policy field "colour"');
  });

  it('refuses an empty pattern in a list', () => {
    expect(() => setup().policy.save('project', { guarded: ['.env*', ' '] })).toThrow('"guarded" entries must be non-empty');
  });

  it('ignores a policy file edited outside Settings until the edit is confirmed', () => {
    const { home, policy } = setup();
    policy.save('ide', { mode: 'A' });
    writeFileSync(join(home, 'policy.json'), JSON.stringify({ mode: 'C', guarded: [] }));
    const view = policy.view();
    expect([view.effective, view.externalEdits]).toEqual([DEFAULT_POLICY, { ide: true, project: false }]);
    expect(view.problems).toEqual([`${join(home, 'policy.json')} was edited outside Settings and is ignored until you confirm it: the IDE level falls back to the defaults, the project level to the IDE level`]);
    expect(view.edited).toEqual({ ide: JSON.stringify({ mode: 'C', guarded: [] }), project: null });
    policy.confirmExternalEdits(view.hashes);
    expect(policy.effective()).toEqual({ ...DEFAULT_POLICY, mode: 'C', guarded: [] });
  });

  it('refuses to save a level whose file was edited outside Settings', () => {
    const { home, policy } = setup();
    writeFileSync(join(home, 'policy.json'), JSON.stringify({ mode: 'C' }));
    expect(() => policy.save('ide', { mode: 'B' })).toThrow('edited outside Settings; confirm that edit first');
  });

  it('refuses to confirm when a policy file changed after Settings showed it', () => {
    const { home, policy } = setup();
    writeFileSync(join(home, 'policy.json'), JSON.stringify({ mode: 'C' }));
    const shown = policy.view().hashes;
    writeFileSync(join(home, 'policy.json'), JSON.stringify({ mode: 'A' }));
    expect(() => policy.confirmExternalEdits(shown)).toThrow('changed again after Settings showed them');
  });

  it('reports a confirmed policy file that is not valid and uses the defaults for that level', () => {
    const { root, home, policy } = setup();
    mkdirSync(projectDir(home, root), { recursive: true });
    writeFileSync(join(projectDir(home, root), 'policy.json'), '{ nope');
    policy.confirmExternalEdits(policy.view().hashes);
    const view = policy.view();
    expect([view.effective, view.problems]).toEqual([DEFAULT_POLICY, [`project level: ${join(projectDir(home, root), 'policy.json')} is not valid JSON`]]);
  });

  it('does not let a corrupt ledger and an absent IDE-level policy file cancel each other out to hide an outside edit', () => {
    const { home, policy } = setup();
    policy.save('project', { mode: 'C' });
    writeFileSync(join(home, 'policy-ledger.json'), '{ corrupt');
    expect(policy.view().externalEdits.ide).toBe(true);
  });
});
