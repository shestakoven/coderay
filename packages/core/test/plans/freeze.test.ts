import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanStep, PlanTarget, Policy } from '@ide/protocol';
import { freezeScope, ownerIndex, reviewPlan } from '../../src/plans/freeze';
import { parsePlanInput, type ComponentRef } from '../../src/plans/plan-input';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { tempDir, writeTree } from '../helpers';

const components: ComponentRef[] = [
  { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts', 'src/extra.ts', 'src/ui/one.ts'], globs: [] },
  { id: 'lib', name: 'Lib', files: ['src/lib/util.ts'], globs: ['src/lib/**'] },
];

async function project(): Promise<string> {
  const root = tempDir('ide-freeze-');
  await writeTree(root, {
    'src/app.ts': '', 'src/other.ts': '', 'src/extra.ts': '', 'src/ui/one.ts': '', 'src/lib/util.ts': '',
    'README.md': '', '.gitignore': 'dist/\n', 'dist/out.js': '', '.env': '',
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const steps = (...targets: PlanTarget[][]): PlanStep[] =>
  targets.map((list, index) => ({ key: `s${index + 1}`, order: index + 1, title: `Step ${index + 1}`, rationale: '', targets: list }));

async function review(root: string, plan: PlanStep[], policy: Partial<Policy> = {}) {
  return reviewPlan(plan, { root, policy: { ...DEFAULT_POLICY, ...policy }, components, tempRoots: [] });
}

describe('freezeScope', () => {
  it('freezes a component to its files and globs, a file to its path and a directory to an escaped glob', async () => {
    const root = await project();
    await writeTree(root, { 'app/[id]/page.tsx': '' });
    expect(freezeScope(steps(
      [{ componentId: 'lib', op: 'modify' }],
      [{ path: 'src/app.ts', op: 'modify' }, { path: 'app/[id]', op: 'modify' }, { path: 'src/app.ts', op: 'modify' }],
    ), root, components)).toMatchObject({ paths: ['src/app.ts', 'src/lib/util.ts'], globs: ['app/[[]id[]]/**', 'src/lib/**'] });
  });
});

describe('freezeScope deletes', () => {
  it('collects delete targets: a path, a directory as dir/**, a component as its files and globs', async () => {
    const root = await project();
    expect(freezeScope(steps(
      [{ path: 'src/app.ts', op: 'delete' }, { path: 'src/other.ts', op: 'modify' }],
      [{ path: 'src/ui', op: 'delete' }, { componentId: 'lib', op: 'delete' }],
    ), root, components)).toMatchObject({
      paths: ['src/app.ts', 'src/lib/util.ts', 'src/other.ts'],
      deletes: { paths: ['src/app.ts', 'src/lib/util.ts'], globs: ['src/lib/**', 'src/ui/**'] },
    });
  });

  it('gives empty deletes to a plan without delete targets', async () => {
    const root = await project();
    expect(freezeScope(steps([{ path: 'src/app.ts', op: 'modify' }]), root, components).deletes).toEqual({ paths: [], globs: [] });
  });
});

describe('reviewPlan', () => {
  it('approves up to three changed files of one component automatically', async () => {
    const result = await review(await project(), steps([{ path: 'src/app.ts', op: 'modify' }, { path: 'src/other.ts', op: 'modify' }]));
    expect(result).toEqual({ review: { auto: true, notes: ['2 files in App'] }, owners: { 'src/app.ts': 'app', 'src/other.ts': 'app' } });
  });

  it('approves exactly three changed files of one component, the default limit', async () => {
    const result = await review(await project(), steps([
      { path: 'src/app.ts', op: 'modify' }, { path: 'src/other.ts', op: 'modify' }, { path: 'src/extra.ts', op: 'modify' },
    ]));
    expect(result).toEqual({
      review: { auto: true, notes: ['3 files in App'] },
      owners: { 'src/app.ts': 'app', 'src/other.ts': 'app', 'src/extra.ts': 'app' },
    });
  });

  it('counts an existing file the map does not index as no component', async () => {
    const result = await review(await project(), steps([{ path: 'src/app.ts', op: 'modify' }, { path: 'README.md', op: 'modify' }]));
    expect(result).toEqual({ review: { auto: true, notes: ['2 files in App'] }, owners: { 'src/app.ts': 'app', 'README.md': null } });
  });

  it('counts an existing file the map does not index as no component, even inside a component glob', async () => {
    const root = await project();
    await writeTree(root, { 'src/lib/notes.md': '' });
    const result = await review(root, steps([{ path: 'src/lib/util.ts', op: 'modify' }, { path: 'src/lib/notes.md', op: 'modify' }]));
    expect(result.owners).toEqual({ 'src/lib/util.ts': 'lib', 'src/lib/notes.md': null });
  });

  it('places a new file by the glob of its component', async () => {
    const result = await review(await project(), steps([{ path: 'src/lib/new.ts', op: 'create' }]));
    expect(result).toEqual({ review: { auto: true, notes: ['1 file in Lib'] }, owners: { 'src/lib/new.ts': 'lib' } });
  });

  it('places a new file by at least two indexed siblings that share a component', async () => {
    const result = await review(await project(), steps([{ path: 'src/new.ts', op: 'create' }]));
    expect(result.owners).toEqual({ 'src/new.ts': 'app' });
    expect(result.review.auto).toBe(true);
  });

  it('does not place a new file when its indexed siblings belong to different components', async () => {
    const mixed: ComponentRef[] = [
      { id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts', 'src/extra.ts', 'src/ui/one.ts', 'src/mixed/a.ts', 'src/mixed/b.ts'], globs: [] },
      { id: 'lib', name: 'Lib', files: ['src/lib/util.ts', 'src/mixed/c.ts'], globs: ['src/lib/**'] },
    ];
    const result = await reviewPlan(steps([{ path: 'src/mixed/new.ts', op: 'create' }]), {
      root: await project(), policy: DEFAULT_POLICY, components: mixed, tempRoots: [],
    });
    expect(result.owners).toEqual({ 'src/mixed/new.ts': null });
    expect(result.review).toEqual({ auto: false, notes: ['the map cannot place the new file src/mixed/new.ts in a component'] });
  });

  it('waits for the user when the map cannot place a new file', async () => {
    const result = await review(await project(), steps([{ path: 'src/ui/two.ts', op: 'create' }]));
    expect(result.review).toEqual({ auto: false, notes: ['the map cannot place the new file src/ui/two.ts in a component'] });
  });

  it.each([
    ['a whole component', [{ componentId: 'app', op: 'modify' }], 'it targets the whole component App', {}],
    ['a directory', [{ path: 'src/lib', op: 'modify' }], 'it targets the directory src/lib', {}],
    ['a delete', [{ path: 'src/app.ts', op: 'delete' }], 'it deletes src/app.ts', {}],
    ['four files', ['src/app.ts', 'src/other.ts', 'src/extra.ts', 'src/ui/one.ts'].map((path) => ({ path, op: 'modify' })), '4 files (the limit is 3)', {}],
    ['two components', [{ path: 'src/app.ts', op: 'modify' }, { path: 'src/lib/util.ts', op: 'modify' }], 'files in 2 components (App, Lib)', {}],
    ['a guarded file', [{ path: '.env', op: 'modify' }], '.env is a guarded path', {}],
    ['the git exclude file', [{ path: '.git/info/exclude', op: 'modify' }], '.git/info/exclude is a guarded path', {}],
    ['a gitignored file', [{ path: 'dist/out.js', op: 'modify' }], 'dist/out.js is gitignored', {}],
    ['a harness file', [{ path: '.omc/state.json', op: 'create' }], '.omc/state.json is a harness path', {}],
    ['automatic approval off', [{ path: 'src/app.ts', op: 'modify' }], 'automatic approval is off', { autoApproveMaxFiles: 0 }],
  ] as const)('waits for the user for %s', async (_name, targets, note, policy) => {
    const result = await review(await project(), steps([...targets] as PlanTarget[]), policy);
    expect([result.review.auto, result.review.notes]).toEqual([false, expect.arrayContaining([note])]);
  });

  it('does not let letter case hide that a plan spans two components', async () => {
    const root = await project();
    const caseInsensitive = existsSync(join(root, 'SRC/APP.TS'));
    const raw = {
      goal: 'g',
      steps: [{ key: 's1', title: 'Step 1', rationale: '', targets: [{ path: 'SRC/APP.TS', op: 'modify' }, { path: 'src/lib/util.ts', op: 'modify' }] }],
    };
    const parsed = parsePlanInput(raw, root, components);
    if (typeof parsed === 'string') throw new Error(parsed);
    const result = await review(root, parsed.steps);
    expect(result.review.auto).toBe(false);
    if (caseInsensitive) {
      expect(result.owners).toEqual({ 'src/app.ts': 'app', 'src/lib/util.ts': 'lib' });
      expect(result.review.notes).toEqual(expect.arrayContaining(['files in 2 components (App, Lib)']));
    } else {
      // A case-sensitive filesystem treats "SRC/APP.TS" as a new, unindexed path rather than src/app.ts.
      expect(result.owners).toEqual({ 'SRC/APP.TS': null, 'src/lib/util.ts': 'lib' });
      expect(result.review.notes).toEqual(expect.arrayContaining(['the map cannot place the new file SRC/APP.TS in a component']));
    }
  });
});

describe('overlapping component globs', () => {
  const nested: ComponentRef[] = [
    { id: 'a', name: 'A', files: [], globs: ['src/**'] },
    { id: 'b', name: 'B', files: [], globs: ['src/x/**'] },
  ];
  const tie: ComponentRef[] = [
    { id: 'a', name: 'A', files: [], globs: ['src/x/**'] },
    { id: 'b', name: 'B', files: [], globs: ['src/x/**'] },
  ];

  it('gives a new file to the component with the most specific glob, and the parent outside the nested directory', () => {
    const owner = ownerIndex(nested);
    expect([owner('src/x/new.ts', false), owner('src/x/deep/new.ts', false), owner('src/y/new.ts', false)]).toEqual(['b', 'b', 'a']);
  });

  it('lets a root ** component lose to any more specific glob', () => {
    const owner = ownerIndex([{ id: 'root', name: 'Root', files: [], globs: ['**'] }, ...nested]);
    expect([owner('src/x/new.ts', false), owner('src/y/new.ts', false), owner('docs/new.md', false)]).toEqual(['b', 'a', 'root']);
  });

  it('gives a new file matched at equal specificity by two components no owner', () => {
    expect(ownerIndex(tie)('src/x/new.ts', false)).toBeNull();
  });

  it('lets a listed file keep its owner even when globs match it', () => {
    expect(ownerIndex([{ ...nested[0]!, files: ['src/x/old.ts'] }, nested[1]!])('src/x/old.ts', true)).toBe('a');
  });

  it('waits with a note naming both components on an equal-specificity tie', async () => {
    const root = await project();
    const result = await reviewPlan(steps([{ path: 'src/x/new.ts', op: 'create' }]), { root, policy: DEFAULT_POLICY, components: tie, tempRoots: [] });
    expect(result.review.auto).toBe(false);
    expect(result.review.notes).toContain('src/x/new.ts matches the globs of A and B');
    expect(result.owners['src/x/new.ts']).toBeNull();
  });

  it('still auto-approves a small plan that creates a file in a nested-owned directory', async () => {
    const root = await project();
    const result = await reviewPlan(steps([{ path: 'src/x/new.ts', op: 'create' }]), { root, policy: DEFAULT_POLICY, components: nested, tempRoots: [] });
    expect([result.review.auto, result.owners['src/x/new.ts']]).toEqual([true, 'b']);
  });
});
