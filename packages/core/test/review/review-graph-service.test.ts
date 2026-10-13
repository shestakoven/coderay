import { beforeAll, describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { createPythonAdapter } from '../../src/lang/python';
import type { LanguageAdapter } from '../../src/lang/types';
import { ReviewGraphService } from '../../src/review/review-graph-service';
import { indexed } from '../helpers';

let adapters: LanguageAdapter[];
beforeAll(async () => {
  adapters = [await createPythonAdapter()];
});

const plan = (version: number, componentId: string): PlanView => ({
  id: 'p1', version, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [{ key: 's1', order: 1, title: 't', rationale: 'r', targets: [{ componentId, op: 'create' }], status: 'done' }],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow: null, proposedAt: 0, decidedAt: 0,
});

const options = (plans: PlanView[], content: (path: string, hash: string) => Promise<string | null>) => ({
  files: () => [indexed('app/a.py', 'python', [])],
  components: () => [{ id: 'a', name: 'A', files: ['app/a.py'] }, { id: 'b', name: 'B', files: ['app/b.py'] }],
  adapters: () => adapters,
  plans: () => plans,
  content,
  readNow: async () => null,
});

describe('ReviewGraphService', () => {
  it('compares against the latest version of the plan the request names', async () => {
    const service = new ReviewGraphService(options([plan(1, 'a'), plan(2, 'b')], async () => null));
    const graph = await service.graph({ planId: 'p1', files: [{ path: 'app/a.py', before: null, after: 'h', step: 's1', external: false, added: 1, removed: 0 }] });
    expect(graph.parts.find((part) => part.id === 'b')).toMatchObject({ status: 'missing', steps: ['s1'] });
    expect(graph.parts.find((part) => part.id === 'a')).toMatchObject({ steps: [] });
  });

  it('treats a version it may not read as unreadable instead of failing the graph', async () => {
    const service = new ReviewGraphService(options([], async () => { throw new Error('no recorded version'); }));
    const graph = await service.graph({ planId: null, files: [{ path: 'app/a.py', before: 'x', after: 'y', step: null, external: false, added: 1, removed: 1 }] });
    expect(graph.partial).toMatch(/could not be read/);
  });
});
