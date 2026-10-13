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
  it('marks an import of a deleted file that an unchanged file still holds as broken, on that import\'s line, and places the deleted file in the part of the nearest directory', async () => {
    const graph = await run({
      changed: [file('app/utils/legacy/throttle.py', 'b1', null, 's5', { removed: 37 })],
      current: [indexed('app/api/routes.py', 'python', ['app.utils.legacy.throttle', 'app.utils.helpers']), indexed('app/utils/helpers.py', 'python', [])],
      readBefore: reader({ 'app/utils/legacy/throttle.py': 'X = 1\n' }),
      readNow: reader({ 'app/api/routes.py': 'import os\nfrom app.utils.legacy.throttle import check\nfrom app.utils.helpers import h\n' }),
    });
    expect(graph.links).toEqual([
      { from: 'api', to: 'utils', state: 'broken', count: 2, evidence: [{ path: 'app/api/routes.py', line: 2, text: 'from app.utils.legacy.throttle import check' }] },
    ]);
    expect(graph.parts.find((part) => part.id === 'utils')).toMatchObject({ status: 'deleted', files: [{ path: 'app/utils/legacy/throttle.py', op: '-' }] });
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

  it('calls a part outside the plan only when there is a plan and no step lists any of its files, external files aside, and a new link to it unplanned', async () => {
    const input = {
      changed: [
        file('app/api/users.py', null, 'h1', 's1'),
        file('app/api/routes.py', null, 'h2', null),
        file('app/utils/helpers.py', null, 'h3', null),
        file('app/services/mailer.py', null, 'h4', null, { external: true }),
      ],
      current: [
        indexed('app/api/users.py', 'python', ['app.utils.helpers']),
        indexed('app/api/routes.py', 'python', []),
        indexed('app/utils/helpers.py', 'python', []),
        indexed('app/services/mailer.py', 'python', []),
      ],
    };
    const plan: PlanRef = { targets: [{ step: 's1', componentId: 'api' }], flow: null };
    const planned = await run({ ...input, plan });
    expect(planned.links.map((link) => [link.from, link.to, link.state])).toEqual([['api', 'utils', 'unplanned']]);
    expect(planned.parts.map((part) => [part.id, part.outside, part.steps])).toEqual([['api', false, ['s1']], ['mailer', false, []], ['utils', true, []]]);
    const unplanned = await run(input);
    expect(unplanned.links.map((link) => link.state)).toEqual(['new']);
    expect(unplanned.parts.filter((part) => part.outside)).toEqual([]);
  });

  it('shows a planned part nothing changed in as missing, and a new link of the plan\'s flow that no code joins as a missing link', async () => {
    const plan: PlanRef = {
      targets: [{ step: 's1', path: 'app/api/users.py' }, { step: 's1', path: 'app/services/user_service.py' }, { step: 's2', path: 'app/services/mailer.py' }],
      flow: {
        nodes: [{ id: 'route', files: ['app/api/users.py'] }, { id: 'svc', files: ['app/services/user_service.py'] }, { id: 'mail', files: ['app/services/mailer.py'] }],
        edges: [{ from: 'route', to: 'svc', state: 'new' }, { from: 'svc', to: 'mail', state: 'new' }, { from: 'mail', to: 'route', state: 'existing' }],
      },
    };
    const graph = await run({
      changed: [file('app/api/users.py', null, 'h1', 's1'), file('app/services/user_service.py', null, 'h2', 's1')],
      current: [indexed('app/api/users.py', 'python', ['app.services.user_service']), indexed('app/services/user_service.py', 'python', []), indexed('app/services/mailer.py', 'python', [])],
      plan,
    });
    expect(graph.parts.map((part) => [part.id, part.status, part.steps])).toEqual([['api', 'created', ['s1']], ['services', 'created', ['s1']], ['mailer', 'missing', ['s2']]]);
    expect(graph.links).toEqual([
      { from: 'api', to: 'services', state: 'new', count: 1, evidence: [] },
      { from: 'services', to: 'mailer', state: 'missing', count: 0, evidence: [] },
    ]);
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

  it('keeps at most 40 parts, leaving out a plain context part before one a flagged link ends in and never a changed one, and says how many it left out', async () => {
    const changedParts = Array.from({ length: 39 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, files: [`pkg${i}/m.py`] }));
    const graph = await run({
      components: [...changedParts, { id: 'hub', name: 'Hub', files: ['hub/h.py'] }, { id: 'old', name: 'Old', files: ['old/o.py'] }],
      changed: changedParts.map((c, i) => (i === 0 ? file(c.files[0]!, 'b0', null) : file(c.files[0]!, null, `h-${c.id}`))),
      current: [
        ...changedParts.slice(1).map((c, i) => indexed(c.files[0]!, 'python', i === 0 ? ['hub.h'] : [])),
        indexed('hub/h.py', 'python', []),
        indexed('old/o.py', 'python', ['pkg0.m']),
      ],
    });
    const ids = graph.parts.map((part) => part.id);
    expect([ids.length, ids.includes('old'), ids.includes('hub')]).toEqual([40, true, false]);
    expect(graph.links.map((link) => [link.from, link.to, link.state])).toEqual([['old', 'c0', 'broken']]);
    expect(graph.partial).toMatch(/\b1 part left out/);
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

  it('draws no link from a changed file that does not parse, on either side, and says so without counting unchanged files', async () => {
    const graph = await run({
      changed: [file('app/api/users.py', 'b1', 'a1'), file('app/api/routes.py', 'b2', 'a2')],
      current: [
        indexed('app/api/users.py', 'python', ['app.services.user_service'], { parseError: true }),
        indexed('app/api/routes.py', 'python', []),
        indexed('app/services/user_service.py', 'python', []),
        indexed('app/utils/helpers.py', 'python', [], { parseError: true }),
      ],
      readBefore: reader({ 'app/api/users.py': 'import os\n', 'app/api/routes.py': 'from app.services.user_service import X\nclass (\n' }),
    });
    expect(graph.links).toEqual([]);
    expect(graph.partial).toMatch(/2 changed files could not be parsed/);
  });

  it('draws a new import as a new link with its line, found also for a from-package-import-module import that never spells the full specifier', async () => {
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
