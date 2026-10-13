import { beforeAll, describe, expect, it } from 'vitest';
import type { ReviewGraphFile } from '@ide/protocol';
import { createPythonAdapter } from '../../src/lang/python';
import type { LanguageAdapter } from '../../src/lang/types';
import { buildReviewGraph, type PlanRef } from '../../src/review/review-graph';
import { indexed } from '../helpers';

let adapters: LanguageAdapter[];
beforeAll(async () => {
  adapters = [await createPythonAdapter()];
});

const file = (path: string, before: string | null, after: string | null, step: string | null = 's1', extra: Partial<ReviewGraphFile> = {}): ReviewGraphFile =>
  ({ path, before, after, step, external: false, added: 1, removed: 0, ...extra });

const components = [
  { id: 'api', name: 'API', files: ['app/api/routes.py', 'app/api/users.py'] },
  { id: 'services', name: 'Services', files: ['app/services/user_service.py'] },
  { id: 'utils', name: 'Utils', files: ['app/utils/helpers.py'] },
  { id: 'mailer', name: 'Mailer', files: ['app/services/mailer.py'] },
];

const reader = (texts: Record<string, string>) => async (path: string) => texts[path] ?? null;
const nothing = reader({});
const run = (input: Partial<Parameters<typeof buildReviewGraph>[0]> & Pick<Parameters<typeof buildReviewGraph>[0], 'changed' | 'current'>) =>
  buildReviewGraph({ components, adapters, plan: null, readBefore: nothing, readNow: nothing, ...input });

describe('buildReviewGraph', () => {
  it('draws a new import between created files as a new link with its line', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', null, 'h1'), file('app/services/user_service.py', null, 'h2')],
      current: [indexed('app/api/users.py', 'python', ['app.services.user_service']), indexed('app/services/user_service.py', 'python', [])],
      readNow: reader({ 'app/api/users.py': 'from app.services.user_service import X\n' }),
    });
    expect(graph.links).toEqual([
      { from: 'api', to: 'services', state: 'new', count: 1, evidence: [{ path: 'app/api/users.py', line: 1, text: 'from app.services.user_service import X' }] },
    ]);
    expect(graph.parts.map((part) => [part.id, part.status])).toEqual([['api', 'created'], ['services', 'created']]);
  });

  it('draws an import that the change removed as a removed link, read from the file as it was', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', 'b1', 'a1')],
      current: [indexed('app/api/users.py', 'python', []), indexed('app/services/user_service.py', 'python', [])],
      readBefore: reader({ 'app/api/users.py': 'import os\nfrom app.services.user_service import X\n' }),
    });
    expect(graph.links).toEqual([
      { from: 'api', to: 'services', state: 'removed', count: 1, evidence: [{ path: 'app/api/users.py', line: 2, text: 'from app.services.user_service import X' }] },
    ]);
  });

  it('marks an import of a deleted file that an unchanged file still holds as broken, and places the deleted file in the nearest part', async () => {
    const graph = await run({
      changed: [file('app/utils/throttle.py', 'b1', null, 's5', { removed: 37 })],
      current: [indexed('app/api/routes.py', 'python', ['app.utils.throttle']), indexed('app/utils/helpers.py', 'python', [])],
      readBefore: reader({ 'app/utils/throttle.py': 'X = 1\n' }),
      readNow: reader({ 'app/api/routes.py': 'import os\nfrom app.utils.throttle import check\n' }),
    });
    expect(graph.links).toEqual([
      { from: 'api', to: 'utils', state: 'broken', count: 1, evidence: [{ path: 'app/api/routes.py', line: 2, text: 'from app.utils.throttle import check' }] },
    ]);
    expect(graph.parts.find((part) => part.id === 'utils')).toMatchObject({ status: 'deleted', files: [{ path: 'app/utils/throttle.py', op: '-' }] });
  });

  it('keeps an import of a deleted file that stays inside one part as evidence on that part', async () => {
    const graph = await run({
      changed: [file('app/utils/throttle.py', 'b1', null, 's5')],
      current: [indexed('app/utils/helpers.py', 'python', ['app.utils.throttle'])],
      readBefore: reader({ 'app/utils/throttle.py': 'X = 1\n' }),
      readNow: reader({ 'app/utils/helpers.py': 'from app.utils.throttle import X\n' }),
    });
    expect(graph.links).toEqual([]);
    expect(graph.parts.find((part) => part.id === 'utils')?.broken).toEqual([
      { path: 'app/utils/helpers.py', line: 1, text: 'from app.utils.throttle import X' },
    ]);
  });

  it('calls a new link unplanned only when a plan exists and a part of it is outside the plan', async () => {
    const input = {
      changed: [file('app/api/users.py', null, 'h1', null), file('app/services/user_service.py', null, 'h2', 's1')],
      current: [indexed('app/api/users.py', 'python', ['app.services.user_service']), indexed('app/services/user_service.py', 'python', [])],
    };
    const plan: PlanRef = { targets: [{ step: 's1', componentId: 'services' }], flow: null };
    const planned = await run({ ...input, plan });
    expect(planned.links[0]?.state).toBe('unplanned');
    expect(planned.parts.find((part) => part.id === 'api')).toMatchObject({ outside: true, steps: [] });
    expect(planned.parts.find((part) => part.id === 'services')).toMatchObject({ outside: false, steps: ['s1'] });
    expect((await run(input)).links[0]?.state).toBe('new');
  });

  it('shows a planned part nothing changed in as missing, and a planned link the code lacks as a missing link', async () => {
    const plan: PlanRef = {
      targets: [{ step: 's1', componentId: 'services' }, { step: 's2', componentId: 'mailer' }],
      flow: {
        nodes: [{ id: 'svc', files: ['app/services/user_service.py'] }, { id: 'mail', files: ['app/services/mailer.py'] }],
        edges: [{ from: 'svc', to: 'mail', state: 'new' }],
      },
    };
    const graph = await run({
      changed: [file('app/services/user_service.py', null, 'h1', 's1')],
      current: [indexed('app/services/user_service.py', 'python', []), indexed('app/services/mailer.py', 'python', [])],
      plan,
    });
    expect(graph.parts.find((part) => part.id === 'mailer')).toMatchObject({ status: 'missing', steps: ['s2'], files: [] });
    expect(graph.links).toEqual([{ from: 'services', to: 'mailer', state: 'missing', count: 0, evidence: [] }]);
  });

  it('adds an unchanged neighbour as context and leaves links between unchanged parts out', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', 'b1', 'a1')],
      current: [
        indexed('app/api/users.py', 'python', ['app.utils.helpers']),
        indexed('app/utils/helpers.py', 'python', []),
        indexed('app/services/user_service.py', 'python', ['app.utils.helpers']),
      ],
      readBefore: reader({ 'app/api/users.py': 'from app.utils.helpers import h\n' }),
    });
    expect(graph.parts.map((part) => [part.id, part.status])).toEqual([['api', 'modified'], ['utils', 'untouched']]);
    expect(graph.links).toEqual([{ from: 'api', to: 'utils', state: 'existing', count: 1, evidence: [] }]);
  });

  it('keeps at most 40 parts and says how many it left out', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, files: [`pkg${i}/m.py`] }));
    const graph = await run({
      components: many,
      changed: many.map((c) => file(c.files[0]!, null, `h-${c.id}`)),
      current: many.map((c) => indexed(c.files[0]!, 'python', [])),
    });
    expect(graph.parts).toHaveLength(40);
    expect(graph.partial).toMatch(/20 parts? left out/);
  });

  it('puts every change in one unassigned part and says so when the map has no components', async () => {
    const graph = await run({
      components: [],
      changed: [file('app/api/users.py', null, 'h1')],
      current: [indexed('app/api/users.py', 'python', [])],
    });
    expect(graph.parts.map((part) => part.id)).toEqual(['unassigned']);
    expect(graph.partial).toMatch(/no components/i);
  });

  it('still answers, with a note, when a file cannot be read as it was', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', 'b1', 'a1')],
      current: [indexed('app/api/users.py', 'python', ['app.services.user_service']), indexed('app/services/user_service.py', 'python', [])],
    });
    expect(graph.partial).toMatch(/could not be read/);
    expect(graph.parts.map((part) => part.id)).toContain('api');
  });

  it('draws no link from a changed file that does not parse, on either side, and says so', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', 'b1', 'a1'), file('app/api/routes.py', 'b2', 'a2')],
      current: [
        indexed('app/api/users.py', 'python', ['app.services.user_service'], { parseError: true }),
        indexed('app/api/routes.py', 'python', []),
        indexed('app/services/user_service.py', 'python', []),
      ],
      readBefore: reader({ 'app/api/users.py': 'import os\n', 'app/api/routes.py': 'from app.services.user_service import X\nclass (\n' }),
    });
    expect(graph.links).toEqual([]);
    expect(graph.partial).toMatch(/2 changed files could not be parsed/);
  });

  it('finds the line of a from-package-import-module import that never spells the full specifier', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', null, 'h1'), file('app/services/user_service.py', null, 'h2')],
      current: [indexed('app/api/users.py', 'python', ['app.services', 'app.services.user_service']), indexed('app/services/user_service.py', 'python', [])],
      readNow: reader({ 'app/api/users.py': 'import os\nfrom app.services import user_service\n' }),
    });
    expect(graph.links).toEqual([
      { from: 'api', to: 'services', state: 'new', count: 1, evidence: [{ path: 'app/api/users.py', line: 2, text: 'from app.services import user_service' }] },
    ]);
  });

  it('puts a deleted file whose directory is gone in unassigned when the directories above hold several parts', async () => {
    const graph = await run({
      changed: [file('app/legacy/old.py', 'b1', null)],
      current: [indexed('app/api/routes.py', 'python', ['app.legacy.old']), indexed('app/services/user_service.py', 'python', [])],
      readBefore: reader({ 'app/legacy/old.py': 'X = 1\n' }),
      readNow: reader({ 'app/api/routes.py': 'from app.legacy.old import X\n' }),
    });
    expect(graph.parts.find((part) => part.id === 'unassigned')?.files.map((item) => item.path)).toEqual(['app/legacy/old.py']);
    expect(graph.parts.filter((part) => part.id !== 'unassigned').flatMap((part) => part.files)).toEqual([]);
    expect(graph.links.map((link) => [link.from, link.to, link.state])).toEqual([['api', 'unassigned', 'broken']]);
  });

  it('says so when a changed file is in a language the map does not read, and draws no link for it', async () => {
    const graph = await run({ changed: [file('cmd/main.go', null, 'h1')], current: [] });
    expect(graph.links).toEqual([]);
    expect(graph.partial).toMatch(/1 changed file is in a language the map does not read/);
  });

  it('says that namespace imports carry no line when a changed file belongs to an adapter that imports by name', async () => {
    const byName: LanguageAdapter = { lang: 'csharp', handles: (path) => path.endsWith('.cs'), parse: () => ({ imports: [], symbols: [], parseError: false }), resolve: () => null, resolveAll: () => [] };
    const graph = await run({ adapters: [byName], changed: [file('Api/Users.cs', null, 'h1')], current: [indexed('Api/Users.cs', 'csharp', [])] });
    expect(graph.partial).toMatch(/namespace imports/);
  });
});
