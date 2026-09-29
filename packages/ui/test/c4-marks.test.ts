import { describe, expect, it } from 'vitest';
import type { C4Container, C4Model, PlanView } from '@ide/protocol';
import { c4NodePlans, locateComponent } from '../src/plan/c4-marks';
import { planMarks } from '../src/plan/plan-state';
import { demoSnapshot } from './snapshot';

const container = (id: string, components: [string, number][], group: string | null = null): C4Container => ({
  id, name: id, role: 'api', tech: 'Python', launch: [], entryFiles: [], entryMissing: [], files: 0,
  components: components.map(([component, near]) => ({ id: component, files: 1, near, containers: 1 })), componentLinks: [], group, evidence: [],
});

const model: C4Model = {
  containers: [
    container('backend', [['folder:src/api', 2], ['folder:src/db', 0]]),
    container('worker-a', [['folder:src/db', 1]], 'workers'),
    container('worker-b', [['folder:src/db', 1]], 'workers'),
  ],
  externals: [], links: [], tooling: [], warnings: [],
};

const plan: PlanView = {
  id: 'p', version: 1, goal: 'g', status: 'proposed', approvedBy: null,
  steps: [
    { key: 'a', order: 1, title: 'A', rationale: '', status: 'pending', targets: [{ path: 'src/api/a.ts', op: 'modify' }, { path: 'src/api/new.ts', op: 'create' }] },
    { key: 'b', order: 2, title: 'B', rationale: '', status: 'pending', targets: [{ componentId: 'folder:src/db', op: 'modify' }] },
  ],
  scope: { paths: [], globs: [] }, owners: { 'src/api/a.ts': 'folder:src/api', 'src/api/new.ts': 'folder:src/api' },
  review: { auto: false, notes: [] }, feedback: null, proposedAt: 1, decidedAt: null,
};

const marks = planMarks(plan, demoSnapshot());

describe('c4NodePlans', () => {
  it('rings every container and group that holds an affected component, with its steps and totals', () => {
    const plans = c4NodePlans([{ id: 'backend', type: 'container' }, { id: 'workers', type: 'c4group' }], model, marks);
    expect([...plans].map(([id, nodePlan]) => [id, nodePlan.steps.map((step) => step.n), nodePlan.line])).toEqual([
      ['backend', [1, 2], 'plan: 2 components · 3 files'],
      ['workers', [2], 'plan: 1 component · 1 file'],
    ]);
  });

  it('marks component cards of an open container, and the Libraries card for the components folded into it', () => {
    const plans = c4NodePlans([
      { id: 'backend', type: 'container' },
      { id: 'backend/folder:src/api', type: 'component', parentId: 'backend' },
      { id: 'backend/shared', type: 'shared', parentId: 'backend' },
    ], model, marks);
    expect([plans.get('backend/folder:src/api'), plans.get('backend/shared')?.line]).toEqual([
      { steps: [{ n: 1, status: 'pending' }], line: '2 files in scope', creates: 1 },
      'plan: 1 component · 1 file',
    ]);
  });
});

describe('locateComponent', () => {
  const nodeIds = (...ids: string[]) => new Set(ids);

  it('points at the container where the component is closest to the entry when nothing is open', () => {
    expect(locateComponent('folder:src/api', model, { expanded: null, root: null, nodeIds: nodeIds('backend', 'workers') }))
      .toEqual({ container: 'backend', node: 'backend' });
  });

  it("points at a group's node when its member holds the component and is not drawn on its own", () => {
    expect(locateComponent('folder:src/db', model, { expanded: null, root: null, nodeIds: nodeIds('backend', 'workers') }))
      .toEqual({ container: 'worker-a', node: 'workers' });
  });

  it("points at the component's card in an open container, or at its Libraries card", () => {
    const open = { expanded: 'backend', root: null, nodeIds: nodeIds('backend', 'backend/folder:src/api', 'backend/shared', 'workers') };
    expect([locateComponent('folder:src/api', model, open).node, locateComponent('folder:src/db', model, open).node])
      .toEqual(['backend/folder:src/api', 'backend/shared']);
  });

  it('points at the root card in a container opened as root', () => {
    expect(locateComponent('folder:src/api', model, { expanded: null, root: 'backend', nodeIds: nodeIds('root', 'root:folder:src/api') }))
      .toEqual({ container: 'backend', node: 'root:folder:src/api' });
  });
});
