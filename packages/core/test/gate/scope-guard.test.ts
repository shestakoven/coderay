import { describe, expect, it } from 'vitest';
import type { ControlMode } from '@ide/protocol';
import { covers, escapeGlob, type FrozenScope } from '../../src/gate/scope';
import { decide, type ClassifiedTarget, type PlanGate, type TargetKind } from '../../src/gate/scope-guard';
import { toolClass } from '../../src/gate/tools';

function target(kind: TargetKind, rel: string | null, extra: Partial<ClassifiedTarget> = {}): ClassifiedTarget {
  return { raw: rel ?? 'x', kind, rel, abs: rel ? `/p/${rel}` : '/elsewhere/x', dir: false, mkdir: false, deleting: false, exists: true, guarded: false, why: kind, ...extra };
}

const approved = (activeStep: string | null = 'edit'): PlanGate => ({
  state: 'approved', planId: 'plan-1', version: 2, scope: { paths: ['src/app.ts'], globs: ['src/lib/**'] }, activeStep, followUps: false,
});

const run = (tool: string, targets: ClassifiedTarget[], gate: PlanGate = approved(), mode: ControlMode = 'B') =>
  decide({ tool, toolClass: toolClass(tool), targets, gate, mode });

describe('decide', () => {
  it('allows the IDE tools and never checks read, subagent, configured MCP and interactive tools', () => {
    expect(['mcp__idecore__step', 'Read', 'Agent', 'mcp__docs__search', 'AskUserQuestion'].map((tool) => run(tool, [], { state: 'none' }).outcome))
      .toEqual(['allow', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
  });

  it('lets a shell command that writes no project file run before any plan', () => {
    expect(run('Bash', [target('temp', null), target('recorded', 'dist/a.js')], { state: 'none' }).outcome).toBe('unchecked');
  });

  it('denies a project write before a plan is approved and says to call propose_plan', () => {
    const decision = run('Write', [target('enforced', 'src/app.ts')], { state: 'none' });
    expect([decision.outcome, decision.reason]).toEqual([
      'deny',
      'IDE: no approved plan covers src/app.ts. Call mcp__idecore__propose_plan with your steps and their targets first, and wait for its result.',
    ]);
  });

  it('denies an outside or unresolved target before a plan like any write', () => {
    expect(run('Bash', [target('outside', null)], { state: 'none' }).outcome).toBe('deny');
    expect(run('Bash', [target('unresolved', null, { raw: '$OUT', why: 'the variable $OUT' })], { state: 'none' }).reason)
      .toContain('$OUT (the variable $OUT)');
  });

  it('denies writes while no step is active', () => {
    const decision = run('Edit', [target('enforced', 'src/app.ts')], approved(null));
    expect([decision.outcome, decision.reason]).toEqual([
      'deny',
      'IDE: plan plan-1 is approved, but no step is active. Call mcp__idecore__step with {"key": "<step key>", "phase": "start"} first.',
    ]);
  });

  it('denies writes after the user rejected the plan, and after the plan is closed', () => {
    const rejected = run('Write', [target('enforced', 'src/app.ts')], { state: 'rejected', planId: 'plan-1' });
    const closed = run('Write', [target('enforced', 'src/app.ts')], { state: 'closed', planId: 'plan-1' });
    expect([rejected.outcome, rejected.reason, closed.outcome, closed.reason]).toEqual([
      'deny', "IDE: the user rejected plan plan-1. Stop and wait for the user's next message.",
      'deny', 'IDE: plan plan-1 is closed. Call mcp__idecore__propose_plan for further changes.',
    ]);
  });

  it('allows an in-scope write and stamps it with the plan, version and active step', () => {
    expect(run('Write', [target('enforced', 'src/lib/util.ts')])).toMatchObject({ outcome: 'allow', planId: 'plan-1', version: 2, stepKey: 'edit', outOfScope: [] });
  });

  it.each([
    ['A', 'deny'],
    ['B', 'ask'],
    ['C', 'flag'],
  ] as const)('handles an out-of-scope write in mode %s with %s', (mode, outcome) => {
    const decision = run('Write', [target('enforced', 'src/other.ts')], approved(), mode);
    expect([decision.outcome, decision.outOfScope.map((t) => t.rel)]).toEqual([outcome, ['src/other.ts']]);
  });

  it('never counts an outside or unresolved target as in scope', () => {
    const decision = run('Bash', [target('enforced', 'src/app.ts'), target('outside', null), target('unresolved', null)]);
    expect([decision.outcome, decision.outOfScope.map((t) => t.kind)]).toEqual(['ask', ['outside', 'unresolved']]);
  });

  it('denies a directory delete under a bare wildcard glob in mode A', () => {
    const gate: PlanGate = { state: 'approved', planId: 'plan-1', version: 1, scope: { paths: [], globs: ['*'] }, activeStep: 'edit', followUps: false };
    const decision = run('Bash', [target('enforced', 'packages', { dir: true })], gate, 'A');
    expect([decision.outcome, decision.outOfScope.map((t) => t.rel)]).toEqual(['deny', ['packages']]);
  });

  it('a modify target does not allow rm: mode A denies, mode B asks; a delete target allows it', () => {
    const scope = { paths: ['src/app.ts', 'src/old.ts'], globs: [], deletes: { paths: ['src/old.ts'], globs: [] } };
    const gate: PlanGate = { state: 'approved', planId: 'plan-1', version: 1, scope, activeStep: 'edit', followUps: false };
    const removal = (rel: string) => target('enforced', rel, { deleting: true });
    expect(['A', 'B'].map((mode) => run('Bash', [removal('src/app.ts')], gate, mode as ControlMode).outcome)).toEqual(['deny', 'ask']);
    expect(run('Bash', [removal('src/old.ts')], gate).outcome).toBe('allow');
  });

  it('mv a b needs a delete for a and a write for b', () => {
    const scope = { paths: ['src/a.ts', 'src/b.ts'], globs: [], deletes: { paths: ['src/a.ts'], globs: [] } };
    const gate: PlanGate = { state: 'approved', planId: 'plan-1', version: 1, scope, activeStep: 'edit', followUps: false };
    const move = (from: string, to: string) => [target('enforced', from, { deleting: true }), target('enforced', to)];
    expect(run('Bash', move('src/a.ts', 'src/b.ts'), gate).outcome).toBe('allow');
    expect(run('Bash', move('src/b.ts', 'src/a.ts'), gate).outcome).toBe('ask');
  });

  it('a Write to an existing path is never a delete', () => {
    const scope = { paths: ['src/app.ts'], globs: [], deletes: { paths: [], globs: [] } };
    const gate: PlanGate = { state: 'approved', planId: 'plan-1', version: 1, scope, activeStep: 'edit', followUps: false };
    expect(run('Write', [target('enforced', 'src/app.ts')], gate).outcome).toBe('allow');
  });

  it('an old scope without deletes still allows the delete', () => {
    const removal = target('enforced', 'src/app.ts', { deleting: true });
    expect(run('Bash', [removal]).outcome).toBe('allow');
  });

  it('counts a git work-tree rewrite in scope only when the whole tree is', () => {
    expect(run('Bash', [target('all-tracked', null)]).outcome).toBe('ask');
    const whole: PlanGate = { state: 'approved', planId: 'plan-1', version: 2, scope: { paths: [], globs: ['**'] }, activeStep: 'edit', followUps: false };
    expect(run('Bash', [target('all-tracked', null)], whole).outcome).toBe('allow');
  });

  it('follows the control mode for an unknown tool even without a plan', () => {
    expect(['A', 'B', 'C'].map((mode) => run('BrandNewTool', [], { state: 'none' }, mode as ControlMode).outcome)).toEqual(['deny', 'ask', 'flag']);
  });

  it('says no component owns the directory for a new file in a directory the map does not own', () => {
    const fresh = target('enforced', 'src/notes.md', { exists: false, unowned: true });
    for (const mode of ['A', 'B'] as const) {
      expect(run('Write', [fresh], approved(), mode).reason).toContain('no component owns this directory; name the file in a step, or expand the plan');
    }
    expect(run('Write', [target('enforced', 'src/notes.md', { exists: false })]).reason).not.toContain('no component owns');
  });

  it('lists at most five targets in a reason', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => target('enforced', `x/${name}.ts`));
    expect(run('Bash', many, { state: 'none' }).reason).toContain('x/a.ts, x/b.ts, x/c.ts, x/d.ts, x/e.ts and 2 more');
  });
});

describe('decide for a file of a nested worktree', () => {
  const REAL = '.worktrees/wt1/backend/src';
  const gate = (scope: FrozenScope): PlanGate => ({ state: 'approved', planId: 'plan-1', version: 2, scope, activeStep: 'edit', followUps: false });
  const inWorktree = (name: string, extra: Partial<ClassifiedTarget> = {}) => target('enforced', `${REAL}/${name}`, { scopeRel: `backend/src/${name}`, ...extra });

  it('allows a write the plan covers by the path inside the worktree and stamps it like any in-scope write', () => {
    const decision = run('Write', [inWorktree('a.py')], gate({ paths: ['backend/src/a.py'], globs: [] }));
    expect(decision).toMatchObject({ outcome: 'allow', planId: 'plan-1', version: 2, stepKey: 'edit', outOfScope: [] });
  });

  it('refuses a write to another file of the worktree and names it by its real path', () => {
    const decision = run('Write', [inWorktree('other.py')], gate({ paths: ['backend/src/a.py'], globs: [] }));
    expect([decision.outcome, decision.outOfScope.map((t) => t.rel)]).toEqual(['ask', [`${REAL}/other.py`]]);
  });

  it.each([
    ['A', 'deny'],
    ['B', 'ask'],
    ['C', 'flag'],
  ] as const)('handles an out-of-scope write to a worktree in mode %s with %s', (mode, outcome) => {
    expect(run('Write', [inWorktree('other.py')], gate({ paths: ['backend/src/a.py'], globs: [] }), mode).outcome).toBe(outcome);
  });

  it('allows a write under a glob of the plan by the path inside the worktree, and not outside the glob', () => {
    const scope = gate({ paths: [], globs: ['backend/src/**'] });
    const outside = target('enforced', '.worktrees/wt1/backend/lib/x.py', { scopeRel: 'backend/lib/x.py' });
    expect([run('Write', [inWorktree('deep/x.py')], scope).outcome, run('Write', [outside], scope).outcome]).toEqual(['allow', 'ask']);
  });

  it('judges a file of the worktree only by its path inside it, not by the real path the plan names', () => {
    const decision = run('Write', [inWorktree('a.py')], gate({ paths: [`${REAL}/a.py`], globs: [] }));
    expect(decision.outcome).toBe('ask');
  });

  it('does not let the path inside the worktree make a file outside it in scope', () => {
    const scope = gate({ paths: ['backend/src/a.py'], globs: [] });
    expect(run('Write', [target('enforced', 'frontend/backend/src/a.py')], scope).outcome).toBe('ask');
  });

  it('judges a delete in the worktree by the deletes of the plan, by the path inside the worktree', () => {
    const scope = gate({ paths: ['backend/src/a.py', 'backend/src/old.py'], globs: [], deletes: { paths: ['backend/src/old.py'], globs: [] } });
    const removal = (name: string) => inWorktree(name, { deleting: true });
    expect([run('Bash', [removal('old.py')], scope).outcome, run('Bash', [removal('a.py')], scope).outcome]).toEqual(['allow', 'ask']);
  });

  it('refuses the whole call when only one of its targets is out of scope', () => {
    const scope = gate({ paths: ['backend/src/a.py'], globs: [] });
    const decision = run('Bash', [inWorktree('a.py'), inWorktree('other.py')], scope);
    expect([decision.outcome, decision.outOfScope.map((t) => t.scopeRel)]).toEqual(['ask', ['backend/src/other.py']]);
  });
});

describe('decide for a worktree that lies in a directory the plan covers', () => {
  const gate = (scope: FrozenScope): PlanGate => ({ state: 'approved', planId: 'plan-1', version: 2, scope, activeStep: 'edit', followUps: false });
  const over = gate({ paths: [], globs: ['src/**'] });
  const inWorktree = (inner: string, extra: Partial<ClassifiedTarget> = {}) => target('enforced', `src/wt/${inner}`, { scopeRel: inner, ...extra });

  it('does not let the real path under the covered directory put a file the plan has no name for in scope', () => {
    const decision = run('Write', [inWorktree('package.json')], over);
    expect([decision.outcome, decision.outOfScope.map((t) => t.rel)]).toEqual(['ask', ['src/wt/package.json']]);
  });

  it('allows that very path when it is no worktree file, which shows the inner name is what is judged', () => {
    expect(run('Write', [target('enforced', 'src/wt/package.json')], over).outcome).toBe('allow');
  });

  it('allows a file of the worktree whose inner path the glob covers', () => {
    expect(run('Write', [inWorktree('src/deep/x.ts')], over).outcome).toBe('allow');
  });

  it('refuses a call that writes a covered and an uncovered file of the worktree, naming only the uncovered one', () => {
    const decision = run('Bash', [inWorktree('src/x.ts'), inWorktree('package.json')], over);
    expect([decision.outcome, decision.outOfScope.map((t) => t.scopeRel)]).toEqual(['ask', ['package.json']]);
  });

  it('judges a deletion by the deletes of the plan with the inner path, not with the real one', () => {
    const scope = gate({ paths: [], globs: ['src/**'], deletes: { paths: ['src/wt/old.ts'], globs: [] } });
    expect(run('Bash', [inWorktree('old.ts', { deleting: true })], scope).outcome).toBe('ask');
    const covered = gate({ paths: [], globs: ['src/**'], deletes: { paths: ['old.ts'], globs: [] } });
    expect(run('Bash', [inWorktree('old.ts', { deleting: true })], covered).outcome).toBe('allow');
  });

  it('does not cover the file of another repository by the path inside it', () => {
    const scope = gate({ paths: [], globs: ['lib/**'] });
    expect(run('Write', [target('enforced', 'deps/foo/lib/x.ex')], scope).outcome).toBe('ask');
    expect(run('Write', [target('enforced', 'deps/foo/lib/x.ex', { scopeRel: 'lib/x.ex' })], scope).outcome).toBe('allow');
  });
});

describe('covers', () => {
  const scope = { paths: ['src/app.ts', 'pkg/new/mod.py'], globs: ['src/lib/**', `${escapeGlob('app/[id]')}/**`] };

  it('covers exact paths and files under a glob', () => {
    expect([
      covers(scope, { rel: 'src/app.ts', dir: false, mkdir: false }),
      covers(scope, { rel: 'src/lib/a/b.ts', dir: false, mkdir: false }),
      covers(scope, { rel: 'src/other.ts', dir: false, mkdir: false }),
    ]).toEqual([true, true, false]);
  });

  it('covers a directory only when a glob covers everything under it', () => {
    expect([
      covers(scope, { rel: 'src/lib', dir: true, mkdir: false }),
      covers(scope, { rel: 'src/lib/deep', dir: true, mkdir: false }),
      covers(scope, { rel: 'src', dir: true, mkdir: false }),
    ]).toEqual([true, true, false]);
  });

  it('does not let a glob with a wildcard directory cover a sibling directory', () => {
    expect(covers({ paths: [], globs: ['src/*/x/**'] }, { rel: 'src/other', dir: true, mkdir: false })).toBe(false);
  });

  it('lets mkdir create the directories that planned files need', () => {
    expect([
      covers(scope, { rel: 'pkg/new', dir: false, mkdir: true }),
      covers(scope, { rel: 'pkg', dir: false, mkdir: true }),
      covers(scope, { rel: 'pkg/else', dir: false, mkdir: true }),
    ]).toEqual([true, true, false]);
  });

  it('matches a directory whose name has glob characters literally', () => {
    expect([
      covers(scope, { rel: 'app/[id]/page.tsx', dir: false, mkdir: false }),
      covers(scope, { rel: 'app/i/page.tsx', dir: false, mkdir: false }),
    ]).toEqual([true, false]);
  });

  it('covers a mkdir target that the scope lists as a path', () => {
    expect(covers({ paths: ['newdir'], globs: [] }, { rel: 'newdir', dir: false, mkdir: true })).toBe(true);
  });

  it('does not let a bare wildcard glob cover a directory delete', () => {
    expect([
      covers({ paths: [], globs: ['*'] }, { rel: 'packages', dir: true, mkdir: false }),
      covers({ paths: [], globs: ['src/*'] }, { rel: 'src/sub', dir: true, mkdir: false }),
    ]).toEqual([false, false]);
  });
});
