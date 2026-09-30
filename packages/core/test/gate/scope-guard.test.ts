import { describe, expect, it } from 'vitest';
import type { ControlMode } from '@ide/protocol';
import { covers, escapeGlob } from '../../src/gate/scope';
import { decide, type ClassifiedTarget, type PlanGate, type TargetKind } from '../../src/gate/scope-guard';
import { toolClass } from '../../src/gate/tools';

function target(kind: TargetKind, rel: string | null, extra: Partial<ClassifiedTarget> = {}): ClassifiedTarget {
  return { raw: rel ?? 'x', kind, rel, abs: rel ? `/p/${rel}` : '/elsewhere/x', dir: false, mkdir: false, exists: true, guarded: false, why: kind, ...extra };
}

const approved = (activeStep: string | null = 'edit'): PlanGate => ({
  state: 'approved', planId: 'plan-1', version: 2, scope: { paths: ['src/app.ts'], globs: ['src/lib/**'] }, activeStep,
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

  it('denies writes after the user rejected the plan, and after the plan is done', () => {
    const rejected = run('Write', [target('enforced', 'src/app.ts')], { state: 'rejected', planId: 'plan-1' });
    const done = run('Write', [target('enforced', 'src/app.ts')], { state: 'done', planId: 'plan-1' });
    expect([rejected.outcome, rejected.reason, done.outcome, done.reason]).toEqual([
      'deny', "IDE: the user rejected plan plan-1. Stop and wait for the user's next message.",
      'deny', 'IDE: plan plan-1 is done. Call mcp__idecore__propose_plan for further changes.',
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
    const gate: PlanGate = { state: 'approved', planId: 'plan-1', version: 1, scope: { paths: [], globs: ['*'] }, activeStep: 'edit' };
    const decision = run('Bash', [target('enforced', 'packages', { dir: true })], gate, 'A');
    expect([decision.outcome, decision.outOfScope.map((t) => t.rel)]).toEqual(['deny', ['packages']]);
  });

  it('counts a git work-tree rewrite in scope only when the whole tree is', () => {
    expect(run('Bash', [target('all-tracked', null)]).outcome).toBe('ask');
    const whole: PlanGate = { state: 'approved', planId: 'plan-1', version: 2, scope: { paths: [], globs: ['**'] }, activeStep: 'edit' };
    expect(run('Bash', [target('all-tracked', null)], whole).outcome).toBe('allow');
  });

  it('follows the control mode for an unknown tool even without a plan', () => {
    expect(['A', 'B', 'C'].map((mode) => run('BrandNewTool', [], { state: 'none' }, mode as ControlMode).outcome)).toEqual(['deny', 'ask', 'flag']);
  });

  it('lists at most five targets in a reason', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => target('enforced', `x/${name}.ts`));
    expect(run('Bash', many, { state: 'none' }).reason).toContain('x/a.ts, x/b.ts, x/c.ts, x/d.ts, x/e.ts and 2 more');
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
