import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FileEdge, MapComponent, MapOverview } from '@ide/protocol';
import { OverviewService, prepareOverview } from '../../src/map/overview';
import type { IndexedFile } from '../../src/model';
import type { StructuredModel } from '../../src/models/types';
import { GatedModel, ScriptedModel } from '../models/fake-models';
import { indexed, tempDir } from '../helpers';

const component = (id: string, name: string, files: string[], summary = ''): MapComponent => ({
  id, name, summary, description: '', files, keyFiles: [], globs: [], source: 'ai', stale: false,
});
const edge = (from: string, to: string): FileEdge => ({ from, to, kind: 'import' });
const filesOf = (components: MapComponent[]) =>
  components.flatMap((c) => c.files.filter((path) => !path.endsWith('.sql')).map((path) => indexed(path, path.endsWith('.py') ? 'python' : 'typescript', [])));
const under = (dir: string, names: string[]) => names.map((name) => `${dir}/${name}`);

// Lines of one section of the payload, up to the next blank line.
function section(prompt: string, heading: string): string[] {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line === '');
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

// The folder parts the payload lists under one component.
function folders(prompt: string, short: string) {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${short} · `));
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return block.flatMap((line) => {
    const match = /^ {2}p\d+ (.+?) (\d+)(?: \((.*)\))? · (.*)$/.exec(line);
    return match ? [{ label: match[1]!, files: Number(match[2]), sub: match[3], names: match[4] ? match[4].split(', ') : [] }] : [];
  });
}

const payload = (components: MapComponent[], edges: FileEdge[] = []) => prepareOverview('shop', components, filesOf(components), edges).prompt;

// web/ splits into four folder parts: p1 pages (5), p2 components (5), p3 styles (4), p4 lib (3).
const WEB = component('cmp-web', 'Web', [
  ...under('web/pages', ['home.tsx', 'about.tsx', 'cart.tsx', 'login.tsx', 'order.tsx']),
  ...under('web/components', ['button.tsx', 'modal.tsx', 'table.tsx', 'field.tsx', 'badge.tsx']),
  ...under('web/styles', ['theme.ts', 'colors.ts', 'spacing.ts', 'fonts.ts']),
  ...under('web/lib', ['fetch.ts', 'money.ts', 'dates.ts']),
]);
const MAP = [
  WEB,
  component('cmp-api', 'Api', ['api/orders.py', 'api/users.py']),
  component('cmp-db', 'Db', ['db/schema.py']),
  component('cmp-vendor', 'Vendor', ['node_modules/react/index.js']),
];
const TOTAL_FILES = MAP.reduce((sum, c) => sum + c.files.length, 0);
const renamed = MAP.map((c) => (c.id === 'cmp-api' ? { ...c, name: 'Orders API' } : c));

const ANSWER = {
  groups: [
    { name: 'Storefront', summary: 'What shoppers use', lane: 'interface', noise: false, components: ['c1'] },
    { name: 'Backend', summary: 'Orders and data', lane: 'core', noise: false, components: ['c2', 'c3'] },
    { name: 'Vendored', summary: 'Third-party code', lane: 'noise', noise: true, components: ['c4'] },
  ],
  components: [],
  links: [],
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function overviewOf(model: StructuredModel, stateDir = tempDir('ide-overview-')) {
  const changes = { count: 0 };
  const service = new OverviewService({ model, stateDir, projectName: 'shop', onChange: () => (changes.count += 1) });
  return { service, changes, stateDir, build: (components = MAP, edges: FileEdge[] = []) => service.build(components, filesOf(components), edges) };
}

async function answered(raw: unknown, edges: FileEdge[] = [], map = MAP): Promise<MapOverview> {
  const { build } = overviewOf(new ScriptedModel(raw));
  build(map, edges);
  await settle();
  return build(map, edges);
}

const placement = (overview: MapOverview) => overview.groups.map((group) => [group.name, group.components.map((c) => c.id)]);

describe('overview payload', () => {
  it('lists every component in map order with its short id, file count, languages and summary', () => {
    const prompt = payload([
      component('cmp-web', 'Web', ['web/a.ts', 'web/b.ts', 'web/c.py'], 'Screens shoppers use'),
      component('cmp-api', 'Api', ['api/x.py']),
      component('cmp-db', 'Db', ['db/y.ts', 'db/z.ts', 'db/schema.sql']),
    ]);
    expect(prompt.split('\n').filter((line) => /^Components \(|^c\d+ · |^ {2}summary: /.test(line))).toEqual([
      'Components (3, 7 source files):',
      'c1 · Web · 3 files · typescript 67%, python 33%',
      '  summary: Screens shoppers use',
      'c2 · Api · 1 file · python',
      'c3 · Db · 3 files · typescript 67%, other 33%',
    ]);
  });

  it('lists each folder part with its size, its largest sub-folders and up to six sample names, one per name family', () => {
    const ui = under('pkg/ui', ['orderBookView.tsx', 'orderForm.tsx', 'chart.tsx', 'index.ts', 'toolbar.tsx', 'menu.tsx', 'dialog.test.tsx', 'footer.tsx', 'zoom.tsx', 'zoom.test.tsx']);
    const lib = [
      ...under('pkg/lib/s1', ['symbolTable.py', 'symbolCache.py', 'symbolTableView.py']),
      'pkg/lib/s2/symbolLoader.py',
      'pkg/lib/s3/symbolWriter.py',
      'pkg/lib/s4/symbolReader.py',
      'pkg/lib/s5/symbol_parser.py',
      'pkg/lib/s6/__init__.py',
      ...under('pkg/lib/s7', ['symbolIndex.py', 'symbolIndexer.py']),
    ];
    const prompt = payload([component('cmp-pkg', 'Pkg', [...ui, ...lib]), MAP[1]!, MAP[2]!]);
    expect(folders(prompt, 'c1')).toEqual([
      { label: 'pkg/ui/', files: 10, sub: undefined, names: ['orderForm', 'chart', 'toolbar', 'menu', 'dialog', 'footer'] },
      {
        label: 'pkg/lib/',
        files: 10,
        sub: 's1 3, s7 2, s2 1, s3 1, s4 1, s5 1, …',
        names: ['symbolTable', 'symbolCache', 'symbolLoader', 'symbolWriter', 'symbolReader', 'symbol_parser'],
      },
    ]);
  });

  const families = (dir: string) => [
    ...Array.from({ length: 10 }, (_, i) => `${dir}/order-step-${i}.ts`),
    ...Array.from({ length: 10 }, (_, i) => `${dir}/price-feed-${i}.ts`),
    ...Array.from({ length: 10 }, (_, i) => `${dir}/risk-check-${i}.ts`),
  ];
  it.each([
    [
      'splits a dominant folder into its sub-folders, keeps small siblings together and collapses single-child chains',
      [
        ...Array.from({ length: 12 }, (_, i) => `svc/api/handlers/orders/o${i}.py`),
        ...Array.from({ length: 10 }, (_, i) => `svc/api/handlers/users/u${i}.py`),
        ...Array.from({ length: 8 }, (_, i) => `svc/api/handlers/auth/a${i}.py`),
        ...Array.from({ length: 18 }, (_, i) => `svc/db/d${i}.py`),
        'svc/cli/run.py', 'svc/cli/args.py', 'svc/docs/guide.py', 'svc/docs/faq.py',
        ...under('svc/tools/bin/x', ['lint.py', 'fmt.py', 'seed.py', 'dump.py']),
        'svc/main.py', 'svc/config.py', 'svc/app.py', 'svc/settings.py',
      ],
      [['svc/db/', 18], ['svc/api/handlers/orders/', 12], ['svc/api/handlers/users/', 10], ['svc/api/handlers/auth/', 8], ['svc/tools/bin/x/', 4], ['svc/ 2 smaller folders', 4], ['svc/* (loose files)', 4]],
    ],
    ['splits one large folder of plain files by file-name prefix', families('lib'), [['lib/order*', 10], ['lib/price*', 10], ['lib/risk*', 10]]],
    ['never splits a vendored folder by file name', families('node_modules/pkg'), [['node_modules/pkg/', 30]]],
    ['never splits site-packages by file name', families('env/lib/python3.12/site-packages'), [['env/lib/python3.12/site-packages/', 30]]],
    ['gives a two-file component its own folder', ['cli/run.py', 'cli/args.py'], [['cli/', 2]]],
    [
      'keeps at most sixteen folder parts and gathers the rest in one',
      Array.from({ length: 20 }, (_, f) => [0, 1, 2].map((i) => `r/f${String(f).padStart(2, '0')}/${i}.ts`)).flat(),
      [...Array.from({ length: 16 }, (_, f) => [`r/f${String(f).padStart(2, '0')}/`, 3]), ['(other small folders)', 12]],
    ],
  ] as const)('%s', (_name, paths, expected) => {
    const parts = folders(payload([component('cmp-x', 'X', [...paths]), MAP[1]!, MAP[2]!]), 'c1');
    expect(parts.map((part) => [part.label, part.files])).toEqual(expected);
    expect(parts.reduce((sum, part) => sum + part.files, 0)).toBe(paths.length);
  });

  it('sums imports between components and between parts of different components, strongest first', () => {
    const a = component('cmp-a', 'A', [...Array.from({ length: 6 }, (_, i) => `a/x/${i}.ts`), ...Array.from({ length: 6 }, (_, i) => `a/y/${i}.ts`)]);
    const b = component('cmp-b', 'B', ['b/0.ts', 'b/1.ts', 'b/2.ts']);
    const c = component('cmp-c', 'C', ['c/0.ts', 'c/1.ts', 'c/2.ts']);
    const prompt = payload([a, b, c], [
      edge('a/x/0.ts', 'b/0.ts'),
      edge('a/x/1.ts', 'b/1.ts'),
      edge('a/y/0.ts', 'b/0.ts'),
      edge('b/0.ts', 'a/x/0.ts'),
      edge('a/x/0.ts', 'a/y/0.ts'),
      edge('a/x/0.ts', 'a/x/1.ts'),
      edge('c/0.ts', 'b/0.ts'),
      edge('c/1.ts', 'b/1.ts'),
      edge('a/x/0.ts', 'ext/lib.ts'),
    ]);
    expect(section(prompt, 'Imports between components')).toEqual(['c1 -> c2: 3', 'c3 -> c2: 2', 'c2 -> c1: 1']);
    expect(section(prompt, 'Imports between parts of different components')).toEqual(['c1.p1 -> c2.p1: 2', 'c3.p1 -> c2.p1: 2', 'c1.p2 -> c2.p1: 1', 'c2.p1 -> c1.p1: 1']);
  });


  it('keeps the 160 strongest links between components and between their parts, strongest first', () => {
    const map = Array.from({ length: 18 }, (_, i) => component(`m${i}`, `M${i}`, [`m${i}/f.ts`]));
    const edges = map.flatMap((a, i) => map.flatMap((b, j) => (i === j ? [] : [edge(a.files[0]!, b.files[0]!)])));
    edges.push(edge('m17/f.ts', 'm16/f.ts'), edge('m17/f.ts', 'm16/f.ts'), edge('m1/f.ts', 'm0/f.ts'));
    const prompt = payload(map, edges);
    const components = section(prompt, 'Imports between components');
    const parts = section(prompt, 'Imports between parts of different components');
    expect([components.length, components.slice(0, 3), parts.length, parts[0]]).toEqual([160, ['c18 -> c17: 3', 'c2 -> c1: 2', 'c1 -> c2: 1'], 160, 'c18.p1 -> c17.p1: 3']);
  });
});

describe('OverviewService cache', () => {
  it.each([
    ['fewer than three components with files', [MAP[0]!, MAP[1]!, component('cmp-empty', 'Empty', [])], null],
    ['more than 60 components', Array.from({ length: 61 }, (_, i) => component(`m${i}`, `M${i}`, [`m${i}/f.ts`])), 'The overview handles up to 60 components; this map has 61.'],
  ])('waits without asking the model given %s', (_name, map, reason) => {
    const model = new ScriptedModel(ANSWER);
    const overview = overviewOf(model).build(map);
    expect([overview.state, overview.error, model.requests.length]).toEqual(['waiting', reason, 0]);
  });

  const SETTLED = 'settled map';
  it.each([
    ['nothing cached', null, ['waiting', false, 0]],
    ['an answer cached for this map', SETTLED, ['ready', true, 3]],
    ['an answer cached for an earlier map', 'renamed', ['waiting', false, 3]],
  ] as const)('does not ask about a map that is still settling, given %s', async (_name, cached, [state, current, groups]) => {
    const seed = overviewOf(new ScriptedModel(ANSWER));
    if (cached) {
      seed.build(cached === SETTLED ? MAP : MAP.map((c) => (c.id === 'cmp-db' ? { ...c, name: 'Store' } : c)));
      await settle();
    }
    const model = new ScriptedModel(ANSWER);
    const { service } = overviewOf(model, seed.stateDir);
    const overview = service.build(MAP, filesOf(MAP), [], false);
    await settle();
    expect([overview.state, overview.basedOnCurrentMap, overview.groups.length, model.requests.length]).toEqual([state, current, groups, 0]);
  });

  it('falls back to the answer last on screen, not to the one fetched last', async () => {
    const other = { ...ANSWER, groups: ANSWER.groups.map((group) => ({ ...group, name: `${group.name} Two` })) };
    const { build } = overviewOf(new ScriptedModel(ANSWER, other));
    build();
    await settle();
    build(renamed);
    await settle();
    build();
    const shown = build(MAP.map((c) => (c.id === 'cmp-db' ? { ...c, name: 'Store' } : c)));
    await settle();
    expect(placement(shown).map(([name]) => name)).toEqual(['Storefront', 'Backend', 'Vendored']);
  });

  it('drops the request for a map that changed and asks about the new one, without a failure for the old', async () => {
    const model = new GatedModel();
    const { build } = overviewOf(model);
    build();
    const next = build(renamed);
    await settle();
    expect([model.cancelled, next.state, build(renamed).state, model.requests.length]).toEqual([true, 'running', 'running', 2]);
    model.answer(ANSWER);
    await settle();
    const back = build();
    expect([build(renamed).state, back.state, back.error, model.requests.length]).toEqual(['ready', 'running', null, 3]);
  });

  it('keeps a fresh answer when the cache cannot be written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());
    const blocker = join(tempDir('ide-overview-'), 'not-a-folder');
    writeFileSync(blocker, '');
    const model = new ScriptedModel(ANSWER);
    const { build } = overviewOf(model, blocker);
    build();
    await settle();
    expect([build().state, model.requests.length, errors.mock.calls.length > 0]).toEqual(['ready', 1, true]);
  });

  it('forgets the answer on disk on Rebuild, so a restart does not bring it back', async () => {
    const { build, service, stateDir } = overviewOf(new ScriptedModel(ANSWER));
    build();
    await settle();
    service.rebuild();
    const model = new ScriptedModel(ANSWER);
    const restarted = overviewOf(model, stateDir).build();
    expect([restarted.state, restarted.groups, model.requests.length]).toEqual(['running', [], 1]);
  });

  it.each([
    ['reuses the drawn overview for the same files and imports', (files: IndexedFile[], edges: FileEdge[]): [IndexedFile[], FileEdge[]] => [files, edges], true],
    ['redraws the overview for a new file list', (files: IndexedFile[], edges: FileEdge[]): [IndexedFile[], FileEdge[]] => [[...files], edges], false],
    ['redraws the overview for new imports', (files: IndexedFile[], edges: FileEdge[]): [IndexedFile[], FileEdge[]] => [files, [...edges]], false],
  ])('%s', async (_name, next, reused) => {
    const { service } = overviewOf(new ScriptedModel(ANSWER));
    const files = filesOf(MAP);
    const edges = [edge('web/pages/home.tsx', 'api/orders.py')];
    service.build(MAP, files, edges);
    await settle();
    const first = service.build(MAP, files, edges);
    const [nextFiles, nextEdges] = next(files, edges);
    expect(service.build(MAP, nextFiles, nextEdges).groups === first.groups).toBe(reused);
  });

  it('redraws the parts after a regroup that swaps files between components of the same size', async () => {
    const { service } = overviewOf(new ScriptedModel(ANSWER));
    const files = filesOf(MAP);
    const edges: FileEdge[] = [];
    service.build(MAP, files, edges);
    await settle();
    service.build(MAP, files, edges);
    const swapped = MAP.map((c) => (c.id === 'cmp-api' ? { ...c, files: ['api/orders.py', 'db/schema.py'] } : c.id === 'cmp-db' ? { ...c, files: ['api/users.py'] } : c));
    const db = service.build(swapped, files, edges).groups.flatMap((group) => group.components).find((c) => c.id === 'cmp-db')!;
    expect(db.parts.map((part) => part.dirs)).toEqual([['api/']]);
  });

  it('asks once per map, reports the answer, and serves it from the cache after a restart unless the prompt version changed', async () => {
    const model = new GatedModel();
    const { build, changes, stateDir } = overviewOf(model);
    expect([build().state, build().state, model.requests.length]).toEqual(['running', 'running', 1]);
    model.answer(ANSWER);
    await settle();
    expect([changes.count, build().state, model.requests.length]).toEqual([1, 'ready', 1]);

    const fresh = new ScriptedModel(ANSWER);
    const restarted = overviewOf(fresh, stateDir).build();
    expect([restarted.state, restarted.basedOnCurrentMap, placement(restarted).length, fresh.requests.length]).toEqual(['ready', true, 3, 0]);

    const file = join(stateDir, 'overview-cache.json');
    const cache = JSON.parse(readFileSync(file, 'utf8')) as { version: number };
    writeFileSync(file, JSON.stringify({ ...cache, version: cache.version - 1 }));
    const outdated = new ScriptedModel(ANSWER);
    expect([overviewOf(outdated, stateDir).build().state, outdated.requests.length]).toEqual(['running', 1]);
  });

  it.each([
    ['renaming a component', renamed, false, ['running', false, 2]],
    ['renaming a component across a restart', renamed, true, ['running', false, 2]],
    ['adding a file to a component', MAP.map((c) => (c.id === 'cmp-api' ? { ...c, files: [...c.files, 'api/refunds.py'] } : c)), false, ['ready', true, 1]],
  ] as const)('after %s, keeps the last answer on screen and asks again only for a new map identity', async (_name, changed, restart, [state, current, requests]) => {
    const model = new ScriptedModel(ANSWER);
    const first = overviewOf(model);
    first.build();
    await settle();
    const next = (restart ? overviewOf(model, first.stateDir) : first).build([...changed]);
    expect([next.state, next.basedOnCurrentMap, placement(next).length, model.requests.length]).toEqual([state, current, 3, requests]);
  });

  it.each([
    ['an Error', new Error('rate limited\nretry later'), 'rate limited'],
    ['a bare string', 'rate limited', 'rate limited'],
    ['undefined', undefined, expect.any(String)],
  ])('shows a failure from %s without retrying on its own, and Rebuild asks again for a failed or a cached answer', async (_name, reason, message) => {
    const model = new ScriptedModel(() => {
      throw reason;
    }, ANSWER);
    const { build, service, changes } = overviewOf(model);
    build();
    await settle();
    const failed = build();
    build();
    expect([failed.state, failed.error, failed.groups, model.requests.length]).toEqual(['failed', message, [], 1]);

    service.rebuild();
    expect(changes.count).toBe(2);
    build();
    await settle();
    expect([build().state, model.requests.length]).toEqual(['ready', 2]);

    service.rebuild();
    build();
    expect(model.requests.length).toBe(3);
  });

  it.each([
    ['without groups', { components: {}, labels: [] }],
    ['without labels', { groups: [], components: {} }],
    ['with a part that has no folders', { groups: [], components: { 'cmp-web': { role: '', noise: false, parts: [{ name: 'Screens' }] } }, labels: [] }],
    ['with a group whose components are not a list', { groups: [{ name: 'App', lane: 'core', components: 5 }], components: {}, labels: [] }],
    ['with a group in an unknown lane', { groups: [{ name: 'App', lane: 'backend', components: ['cmp-web'] }], components: {}, labels: [] }],
    ['with a nameless group', { groups: [{ lane: 'core', components: ['cmp-web'] }], components: {}, labels: [] }],
    ['with a component whose parts are not a list', { groups: [], components: { 'cmp-web': { role: '', noise: false, parts: 'Screens' } }, labels: [] }],
  ])('treats a cached answer %s as a miss instead of crashing the snapshot', async (_name, broken) => {
    const { build, stateDir } = overviewOf(new ScriptedModel(ANSWER));
    build();
    await settle();
    const file = join(stateDir, 'overview-cache.json');
    const cache = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, { answer: unknown }> };
    for (const entry of Object.values(cache.entries)) entry.answer = broken;
    writeFileSync(file, JSON.stringify(cache));
    const model = new ScriptedModel(ANSWER);
    const restarted = overviewOf(model, stateDir).build();
    expect([restarted.state, model.requests.length]).toEqual(['running', 1]);
  });
});

describe('OverviewService answer repair', () => {
  it.each([
    [
      'unknown ids and real ids in place of short ones, leaving the rest unsorted',
      { groups: [{ name: 'App', summary: '', lane: 'core', noise: false, components: ['c99', 'cmp-web', 'c2'] }] },
      [['App', ['cmp-api']], ['Unsorted', ['cmp-web', 'cmp-db', 'cmp-vendor']]],
    ],
    [
      'a component claimed by two groups, which stays in the first',
      {
        groups: [
          { name: 'Front', summary: '', lane: 'interface', noise: false, components: ['c1', 'c2'] },
          { name: 'Back', summary: '', lane: 'core', noise: false, components: ['c2', 'c3'] },
          { name: 'Junk', summary: '', lane: 'noise', noise: true, components: ['c4'] },
        ],
      },
      [['Front', ['cmp-web', 'cmp-api']], ['Back', ['cmp-db']], ['Junk', ['cmp-vendor']]],
    ],
    [
      'a group with no known component, which is dropped',
      {
        groups: [
          { name: 'Ghost', summary: '', lane: 'core', noise: false, components: ['c9'] },
          { name: 'All', summary: '', lane: 'core', noise: false, components: ['c1', 'c2', 'c3', 'c4'] },
        ],
      },
      [['All', ['cmp-web', 'cmp-api', 'cmp-db', 'cmp-vendor']]],
    ],
  ])('places every component in exactly one group given %s', async (_name, raw, expected) => {
    const overview = await answered(raw);
    expect(placement(overview)).toEqual(expected);
    expect(overview.groups.reduce((sum, group) => sum + group.files, 0)).toBe(TOTAL_FILES);
  });

  // k1..k10 hold 10..1 files; the answer puts each in its own group.
  const TEN = Array.from({ length: 10 }, (_, i) => component(`k${i + 1}`, `K${i + 1}`, Array.from({ length: 10 - i }, (_, j) => `k${i + 1}/f${j}.ts`)));
  const TEN_LANES = ['core', 'core', 'interface', 'interface', 'integrations', 'integrations', 'platform', 'platform', 'core', 'noise'];
  const g = (name: string, lane: string, components: string[], noise = false) => ({ name, summary: '', lane, noise, components });
  it.each([
    [
      'more than eight groups, the smallest joining the largest group of its lane',
      TEN,
      { groups: TEN_LANES.map((lane, i) => g(`G${i + 1}`, lane, [`c${i + 1}`], lane === 'noise')) },
      [['G3', 'interface', ['k3']], ['G4', 'interface', ['k4']], ['G1', 'core', ['k1', 'k9']], ['G2', 'core', ['k2']], ['G5', 'integrations', ['k5']], ['G6', 'integrations', ['k6']], ['G7', 'platform', ['k7', 'k8']], ['G10', 'noise', ['k10']]],
    ],
    [
      'eight groups and components left over, which leaves room for Unsorted',
      TEN,
      { groups: TEN_LANES.slice(0, 8).map((lane, i) => g(`G${i + 1}`, lane, [`c${i + 1}`])) },
      [['G3', 'interface', ['k3']], ['G4', 'interface', ['k4']], ['G1', 'core', ['k1']], ['G2', 'core', ['k2']], ['Unsorted', 'core', ['k9', 'k10']], ['G5', 'integrations', ['k5']], ['G6', 'integrations', ['k6']], ['G7', 'platform', ['k7', 'k8']]],
    ],
    [
      'two vendored groups, which become one',
      MAP,
      { groups: [g('Junk', 'noise', ['c4'], true), g('App', 'core', ['c1', 'c2']), g('Generated', 'noise', ['c3'])] },
      [['App', 'core', ['cmp-web', 'cmp-api']], ['Junk', 'noise', ['cmp-vendor', 'cmp-db']]],
    ],
    [
      'a vendored group placed in another lane, which moves to the vendored strip',
      MAP,
      { groups: [g('App', 'core', ['c1', 'c2', 'c3']), g('Generated', 'platform', ['c4'], true)] },
      [['App', 'core', ['cmp-web', 'cmp-api', 'cmp-db']], ['Generated', 'noise', ['cmp-vendor']]],
    ],
  ])('merges groups given %s', async (_name, map, raw, expected) => {
    const overview = await answered(raw, [], map);
    expect(overview.groups.map((group) => [group.name, group.lane, group.components.map((c) => c.id)])).toEqual(expected);
    expect(overview.groups.reduce((sum, group) => sum + group.files, 0)).toBe(map.reduce((sum, c) => sum + c.files.length, 0));
  });

  it.each([['no answer at all', null], ['groups naming no known component', { groups: [{ name: 'Ghost', summary: '', lane: 'core', noise: false, components: ['c9'] }] }]])(
    'fails without caching anything given %s',
    async (_name, raw) => {
      const overview = await answered(raw);
      expect([overview.state, overview.groups]).toEqual(['failed', []]);
    },
  );

  it('shows a component listed twice in one group once', async () => {
    const overview = await answered({ groups: [{ name: 'App', summary: '', lane: 'core', noise: false, components: ['c1', 'c1', 'c2', 'c3', 'c4'] }] });
    expect(placement(overview)).toEqual([['App', ['cmp-web', 'cmp-api', 'cmp-db', 'cmp-vendor']]]);
  });

  const LONG = {
    groups: [
      { name: 'Order Routing And Settlement Engine For Venues', summary: 'x'.repeat(300), lane: 'backend', noise: false, components: ['c1'] },
      { name: '', summary: '', lane: 'noise', noise: false, components: ['c4'] },
    ],
    components: [{ id: 'c1', role: 'r'.repeat(200), noise: false, parts: [{ name: '', summary: 's'.repeat(300), noise: false, folders: ['p1'] }] }],
    links: [],
  };
  it.each([
    ['cuts a group name to 40 characters', (o: MapOverview) => o.groups[0]!.name, 'Order Routing And Settlement Engine For'],
    ['cuts a group summary to 120 characters', (o: MapOverview) => o.groups[0]!.summary.length, 120],
    ['cuts a role to 48 and a part summary to 100 characters', (o: MapOverview) => [o.groups[0]!.components[0]!.role.length, o.groups[0]!.components[0]!.parts[0]!.summary.length], [48, 100]],
    ['names a nameless group and part', (o: MapOverview) => [o.groups.at(-1)!.name, o.groups[0]!.components[0]!.parts[0]!.name], ['Group', 'Part']],
    ['puts an unknown lane in core and treats the noise lane as noise', (o: MapOverview) => o.groups.map((g) => [g.name, g.lane, g.noise]), [['Order Routing And Settlement Engine For', 'core', false], ['Unsorted', 'core', false], ['Group', 'noise', true]]],
  ])('%s', async (_name, pick, expected) => {
    expect(pick(await answered(LONG))).toEqual(expected);
  });

  it('turns folder ids into parts: first claim wins, another component\'s folder ids are ignored, unclaimed folders get their own part, empty parts go, noise parts last', async () => {
    const overview = await answered({
      groups: [{ name: 'All', summary: '', lane: 'core', noise: false, components: ['c1', 'c2', 'c3', 'c4'] }],
      components: [
        {
          id: 'c1',
          role: 'storefront',
          noise: false,
          parts: [
            { name: 'Vendor Styles', summary: '', noise: true, folders: ['p3'] },
            { name: 'Screens', summary: '', noise: false, folders: ['c1.p1', ' p2 '] },
            { name: 'Dup', summary: '', noise: false, folders: ['p2'] },
            { name: 'Ghost', summary: '', noise: false, folders: ['p9', 'web/lib/', 'c3.p4'] },
          ],
        },
      ],
      links: [],
    });
    const web = overview.groups.flatMap((group) => group.components).find((c) => c.id === 'cmp-web')!;
    expect(web.parts.map((part) => [part.id, part.name, part.files, part.dirs, part.noise])).toEqual([
      ['cmp-web#web/pages/', 'Screens', 10, ['web/pages/', 'web/components/'], false],
      ['cmp-web#web/lib/', 'lib', 3, ['web/lib/'], false],
      ['cmp-web#web/styles/', 'Vendor Styles', 4, ['web/styles/'], true],
    ]);
  });

  it('orders groups by lane from users to infrastructure and gives the same ids when the answer lists groups and parts in another order', async () => {
    const screens = { name: 'Screens', summary: '', noise: false, folders: ['p1', 'p2'] };
    const styles = { name: 'Styles', summary: '', noise: false, folders: ['p3'] };
    const groups = [
      { name: 'Ops', summary: '', lane: 'platform', noise: false, components: ['c3'] },
      { name: 'Shop', summary: '', lane: 'interface', noise: false, components: ['c1'] },
      { name: 'Junk', summary: '', lane: 'noise', noise: true, components: ['c4'] },
      { name: 'Logic', summary: '', lane: 'core', noise: false, components: ['c2'] },
    ];
    const first = await answered({ groups, components: [{ id: 'c1', role: '', noise: false, parts: [screens, styles] }] });
    expect(first.groups.map((group) => [group.id, group.name])).toEqual([['group:cmp-web', 'Shop'], ['group:cmp-api', 'Logic'], ['group:cmp-db', 'Ops'], ['group:cmp-vendor', 'Junk']]);
    const reordered = await answered({ groups: [...groups].reverse(), components: [{ id: 'c1', role: '', noise: false, parts: [styles, { ...screens, folders: ['p2', 'p1'] }] }] });
    expect(reordered).toEqual(first);
  });

  it('counts imports between parts and keeps only labels between two different known components', async () => {
    const overview = await answered(
      {
        groups: [{ name: 'All', summary: '', lane: 'core', noise: false, components: ['c1', 'c2', 'c3', 'c4'] }],
        components: [],
        links: [
          { from: 'c1', to: 'c2', label: 'places orders via' },
          { from: 'c2', to: 'c2', label: 'calls itself' },
          { from: 'c9', to: 'c3', label: 'ghost' },
          { from: 'c2', to: 'c3', label: 'x'.repeat(60) },
        ],
      },
      [
        edge('web/pages/home.tsx', 'api/orders.py'),
        edge('web/pages/cart.tsx', 'api/orders.py'),
        edge('web/components/button.tsx', 'api/users.py'),
        edge('web/pages/home.tsx', 'web/pages/cart.tsx'),
        edge('web/pages/home.tsx', 'web/lib/fetch.ts'),
        edge('api/orders.py', 'db/schema.py'),
        edge('api/orders.py', 'api/users.py'),
      ],
    );
    expect(overview.links).toEqual([
      { from: 'cmp-web#web/pages/', to: 'cmp-api#api/', count: 2 },
      { from: 'cmp-web#web/components/', to: 'cmp-api#api/', count: 1 },
      { from: 'cmp-web#web/pages/', to: 'cmp-web#web/lib/', count: 1 },
      { from: 'cmp-api#api/', to: 'cmp-db#db/', count: 1 },
    ]);
    expect(overview.labels).toEqual([
      { from: 'cmp-web', to: 'cmp-api', label: 'places orders via' },
      { from: 'cmp-api', to: 'cmp-db', label: 'x'.repeat(40) },
    ]);
  });
});
