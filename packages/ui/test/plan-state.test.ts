import { describe, expect, it } from 'vitest';
import type { C4Container, GatePromptView, PlanView } from '@ide/protocol';
import {
  badgeText, circled, classifyTargets, containerMark, drawsOverlay, EMPTY_MARKS, initialPlanState, panelOpenByDefault, pendingPrompts, planMarks, planOnMap, planReducer, planTitle,
  waitsForUser,
} from '../src/plan/plan-state';
import { demoSnapshot } from './snapshot';

const plan = (overrides: Partial<PlanView> = {}): PlanView => ({
  id: 'plan-1', version: 1, goal: 'Fix', status: 'approved', approvedBy: 'user-card',
  steps: [
    { key: 'a', order: 1, title: 'API', rationale: '', status: 'done', targets: [{ path: 'src/api/a.ts', op: 'modify' }, { path: 'src/api/new.ts', op: 'create' }] },
    { key: 'b', order: 2, title: 'DB', rationale: '', status: 'active', targets: [{ componentId: 'folder:src/db', op: 'modify' }, { path: 'README.md', op: 'modify' }] },
  ],
  scope: { paths: [], globs: [] },
  owners: { 'src/api/a.ts': 'folder:src/api', 'src/api/new.ts': 'folder:src/api', 'README.md': null },
  review: { auto: false, notes: [] }, feedback: null, proposedAt: 1, decidedAt: 2,
  ...overrides,
});

const container = (id: string, components: string[], group: string | null = null): C4Container => ({
  id, name: id, role: 'api', tech: 'Python', launch: [], entryFiles: [], entryMissing: [], files: 0,
  components: components.map((component) => ({ id: component, files: 1, near: 1, containers: 1 })), componentLinks: [], group, evidence: [],
});

describe('planMarks', () => {
  it('marks each affected component with its steps, files and planned new files, and lists files off the map', () => {
    const marks = planMarks(plan(), demoSnapshot());
    expect([...marks.components].map(([id, mark]) => [id, mark.steps, [...mark.files], mark.creates, mark.whole])).toEqual([
      ['folder:src/api', [{ n: 1, status: 'done' }], ['src/api/a.ts', 'src/api/new.ts'], 1, false],
      ['folder:src/db', [{ n: 2, status: 'active' }], ['src/db/c.ts'], 0, true],
    ]);
    expect(marks.files.get('src/api/a.ts')).toEqual([{ n: 1, status: 'done' }]);
    expect(marks.ghosts).toEqual([{ path: 'src/api/new.ts', componentId: 'folder:src/api', step: { n: 1, status: 'done' } }]);
    expect(marks.other).toEqual([{ path: 'README.md', op: 'modify', step: 2 }]);
    expect(marks.stepComponents).toEqual([['folder:src/api'], ['folder:src/db']]);
  });

  it('marks every component with files under a directory target', () => {
    const directory = plan({
      steps: [{ key: 'a', order: 1, title: 'All', rationale: '', status: 'pending', targets: [{ path: 'src', op: 'modify' }] }],
      owners: {},
    });
    const marks = planMarks(directory, demoSnapshot());
    expect([[...marks.components].map(([id, mark]) => [id, mark.files.size]), marks.other]).toEqual([[['folder:src/api', 2], ['folder:src/db', 1]], []]);
  });

  it('plans a new file created by two steps as one ghost that carries both steps', () => {
    const twice = plan({
      steps: [
        { key: 'a', order: 1, title: 'A', rationale: '', status: 'done', targets: [{ path: 'src/api/new.ts', op: 'create' }] },
        { key: 'b', order: 2, title: 'B', rationale: '', status: 'active', targets: [{ path: 'src/api/new.ts', op: 'create' }] },
      ],
    });
    const marks = planMarks(twice, demoSnapshot());
    expect([marks.ghosts.map((ghost) => ghost.path), marks.components.get('folder:src/api')?.creates, marks.files.get('src/api/new.ts')?.map((step) => step.n)]).toEqual([
      ['src/api/new.ts'], 1, [1, 2],
    ]);
  });

  it('draws nothing for a rejected, withdrawn or finished plan', () => {
    for (const status of ['rejected', 'withdrawn', 'done'] as const) expect(planMarks(plan({ status }), demoSnapshot())).toBe(EMPTY_MARKS);
  });
});

describe('planOnMap', () => {
  it('shows the waiting version of the latest plan, else its enforced version, else its latest version', () => {
    const v1 = plan();
    expect(planOnMap([v1, plan({ version: 2, status: 'proposed' })])?.version).toBe(2);
    expect(planOnMap([plan({ status: 'superseded' }), plan({ version: 2 })])?.version).toBe(2);
    expect(planOnMap([v1, plan({ version: 2, status: 'changes-requested' })])?.version).toBe(1);
    expect(planOnMap([plan({ status: 'rejected' })])?.status).toBe('rejected');
    expect(planOnMap([plan({ status: 'done' }), plan({ id: 'plan-2', status: 'proposed' })])?.id).toBe('plan-2');
    expect(planOnMap([])).toBeNull();
  });
});

describe('planTitle', () => {
  it('names the state of the plan', () => {
    expect([
      planTitle(plan({ status: 'proposed' })),
      planTitle(plan()),
      planTitle(plan({ approvedBy: 'auto', steps: plan().steps.map((step) => ({ ...step, status: 'pending' as const })) })),
      planTitle(plan({ status: 'done' })),
      planTitle(plan({ status: 'changes-requested' })),
    ]).toEqual(['Plan v1 · waiting for you', 'Plan v1 · step 2/2', 'Plan v1 · approved automatically', 'Plan v1 · done', 'Plan v1 · changes requested']);
  });
});

describe('containerMark', () => {
  it('sums the steps, components and files of every container that holds an affected component', () => {
    const marks = planMarks(plan(), demoSnapshot());
    expect(containerMark([container('backend', ['folder:src/api', 'folder:src/db'])], marks)).toEqual({
      steps: [{ n: 1, status: 'done' }, { n: 2, status: 'active' }], components: 2, files: 3,
    });
    expect(containerMark([container('worker', ['folder:src/db'])], marks)).toEqual({ steps: [{ n: 2, status: 'active' }], components: 1, files: 1 });
    expect(containerMark([container('ui', ['other'])], marks)).toBeNull();
  });

  it('counts a component held by two containers once', () => {
    const marks = planMarks(plan(), demoSnapshot());
    expect(containerMark([container('w1', ['folder:src/db']), container('w2', ['folder:src/db'])], marks)).toEqual({
      steps: [{ n: 2, status: 'active' }], components: 1, files: 1,
    });
  });
});

describe('plan state', () => {
  it('replaces plans and prompts from their snapshots', () => {
    const withPlans = planReducer(initialPlanState, { type: 'plans', plans: [plan()] });
    expect(planReducer(withPlans, { type: 'prompts', prompts: [] })).toEqual({ plans: [plan()], prompts: [] });
  });

  it('opens the panel for a plan that waits and collapses it otherwise', () => {
    expect([panelOpenByDefault(plan({ status: 'proposed' })), panelOpenByDefault(plan())]).toEqual([true, false]);
  });

  it('numbers steps with circled digits up to twenty', () => {
    expect([circled(1), circled(20), circled(21)]).toEqual(['①', '⑳', '(21)']);
  });
});

const prompt = (id: string, status: GatePromptView['status']): GatePromptView => ({
  id, toolUseId: id, parentToolUseId: null, tool: 'Write', summary: '', preview: { kind: 'command', command: 'ls', truncated: false },
  reason: null, targets: [], canExpand: false, planId: null, mode: 'A', status, answer: null, ts: 1,
});

describe('plan predicates', () => {
  it('keeps only the pending prompts', () => {
    expect(pendingPrompts([prompt('a', 'pending'), prompt('b', 'answered'), prompt('c', 'dropped'), prompt('d', 'pending')]).map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('waits for the user only while the plan is proposed', () => {
    expect([waitsForUser(plan({ status: 'proposed' })), waitsForUser(plan()), waitsForUser(plan({ status: 'changes-requested' })), waitsForUser(null)]).toEqual([true, false, false, false]);
  });

  it('draws the overlay for a proposed or approved plan only', () => {
    expect([
      drawsOverlay(plan({ status: 'proposed' })), drawsOverlay(plan()), drawsOverlay(plan({ status: 'rejected' })), drawsOverlay(plan({ status: 'done' })), drawsOverlay(null),
    ]).toEqual([true, true, false, false, false]);
  });
});

describe('classifyTargets', () => {
  it('sorts targets into whole components, files by owner, directories and files off the map', () => {
    const p = plan({
      steps: [{ key: 'a', order: 1, title: 'All', rationale: '', status: 'pending', targets: [
        { componentId: 'folder:src/db', op: 'modify' }, { path: 'src/api/a.ts', op: 'modify' }, { path: 'README.md', op: 'delete' },
        { path: 'src', op: 'modify' }, { path: 'nowhere', op: 'create' }, { path: 'src/x.ts', op: 'create' },
      ] }],
      owners: { 'src/api/a.ts': 'folder:src/api', 'README.md': null, 'src/x.ts': 'gone' },
    });
    expect(classifyTargets(p.steps[0]!, p, demoSnapshot())).toEqual([
      { kind: 'component', op: 'modify', componentId: 'folder:src/db' },
      { kind: 'file', op: 'modify', path: 'src/api/a.ts', owner: 'folder:src/api' },
      { kind: 'other', op: 'delete', path: 'README.md' },
      { kind: 'directory', op: 'modify', path: 'src', componentIds: ['folder:src/api', 'folder:src/db'] },
      { kind: 'directory', op: 'create', path: 'nowhere', componentIds: [] },
      { kind: 'other', op: 'create', path: 'src/x.ts' },
    ]);
  });
});

describe('badgeText', () => {
  it('shows a check and the number for a done step and a circled number otherwise', () => {
    expect([badgeText({ n: 2, status: 'done' }), badgeText({ n: 3, status: 'active' })]).toEqual(['✓2', '③']);
  });
});

describe('directory targets', () => {
  const withSibling = () => {
    const snapshot = demoSnapshot();
    return { ...snapshot, components: [...snapshot.components, { ...snapshot.components[0]!, id: 'folder:srcx', name: 'srcx', files: ['srcx/y.ts'] }] };
  };
  const directory = plan({
    steps: [{ key: 'a', order: 1, title: 'All', rationale: '', status: 'pending', targets: [{ path: 'src', op: 'modify' }] }],
    owners: {},
  });

  it('claims only components with files inside the directory, not a sibling sharing its prefix', () => {
    expect(classifyTargets(directory.steps[0]!, directory, withSibling())).toEqual([
      { kind: 'directory', op: 'modify', path: 'src', componentIds: ['folder:src/api', 'folder:src/db'] },
    ]);
    expect([...planMarks(directory, withSibling()).components.keys()]).toEqual(['folder:src/api', 'folder:src/db']);
  });
});
