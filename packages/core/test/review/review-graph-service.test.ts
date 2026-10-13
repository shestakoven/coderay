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

const plan = (version: number, targets: PlanView['steps'][number]['targets'], id = 'p1', flow: PlanView['flow'] = null): PlanView => ({
  id, version, goal: 'g', status: 'approved', approvedBy: 'user-card',
  steps: [{ key: 's1', order: 1, title: 't', rationale: 'r', targets, status: 'done' }],
  scope: { paths: [], globs: [] }, owners: {}, review: { auto: false, notes: [] }, feedback: null, flow, proposedAt: 0, decidedAt: 0,
});

const node = (id: string, path: string) => ({ id, title: id, sub: '', kind: 'module' as const, state: 'existing' as const, steps: [], files: [{ op: '~' as const, path }] });

const options = (plans: PlanView[], content: (path: string, hash: string) => Promise<string | null>) => ({
  files: () => [indexed('app/a.py', 'python', [])],
  components: () => ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), files: [`app/${id}.py`] })),
  adapters: () => adapters,
  plans: () => plans,
  content,
  readNow: async () => null,
});

describe('ReviewGraphService', () => {
  it('compares against the latest version of the plan the request names: its component and path targets and its flow', async () => {
    const latest = plan(2, [{ componentId: 'b', op: 'create' }, { path: 'app/d.py', op: 'modify' }], 'p1', {
      nodes: [node('na', 'app/a.py'), node('nb', 'app/b.py')],
      edges: [{ from: 'na', to: 'nb', label: '', state: 'new' }],
    });
    const service = new ReviewGraphService(options([plan(1, [{ componentId: 'a', op: 'create' }]), latest, plan(3, [{ componentId: 'c', op: 'create' }], 'p2')], async () => null));
    const graph = await service.graph({ planId: 'p1', files: [{ path: 'app/a.py', before: null, after: 'h', step: 's1', external: false, added: 1, removed: 0 }] });
    expect(graph.parts.map((part) => [part.id, part.status, part.steps])).toEqual([['a', 'created', []], ['b', 'missing', ['s1']], ['d', 'missing', ['s1']]]);
    expect(graph.links).toEqual([{ from: 'a', to: 'b', state: 'missing', count: 0, evidence: [] }]);
  });

  it('treats a version it may not read as unreadable instead of failing the graph', async () => {
    const service = new ReviewGraphService(options([], async () => { throw new Error('no recorded version'); }));
    const graph = await service.graph({ planId: null, files: [{ path: 'app/a.py', before: 'x', after: 'y', step: null, external: false, added: 1, removed: 1 }] });
    expect(graph.partial).toMatch(/could not be read/);
  });

  it('reads the version the request names as before, and draws the import that version had and the file lost', async () => {
    const sources: Record<string, string> = { 'b-hash': 'from app.b import X\n', 'a-hash': 'import os\n' };
    const reads: string[] = [];
    const content = async (path: string, hash: string) => {
      reads.push(`${path}@${hash}`);
      return sources[hash] ?? null;
    };
    const service = new ReviewGraphService({ ...options([], content), files: () => [indexed('app/a.py', 'python', []), indexed('app/b.py', 'python', [])] });
    const graph = await service.graph({ planId: null, files: [{ path: 'app/a.py', before: 'b-hash', after: 'a-hash', step: null, external: false, added: 0, removed: 1 }] });
    expect([...new Set(reads)]).toEqual(['app/a.py@b-hash']);
    expect(graph.links).toEqual([{ from: 'a', to: 'b', state: 'removed', count: 1, evidence: [{ path: 'app/a.py', line: 1, text: 'from app.b import X' }] }]);
  });
});
