import { existsSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundAiStatus, FileEdge } from '@ide/protocol';
import { blobHash } from '../../src/history/ide-writes';
import type { EmbeddingRule } from '../../src/map/embedding-check';
import { BackgroundAiOff } from '../../src/models/background-ai';
import type { StructuredRequest } from '../../src/models/types';
import { MapService } from '../../src/map/map-service';
import type { StructuredModel } from '../../src/models/types';
import { indexed, tempDir, waitFor, writeTree } from '../helpers';
import { componentsPerDirectory, FakeEmbedModel, GatedModel, groupingAnswer, promptGroups, ScriptedModel } from '../models/fake-models';

const PROJECT = {
  'src/api/auth.ts': 'export function auth() {}',
  'src/api/handlers.ts': 'export function handle() {}',
  'src/api/routes.ts': 'export function routes() {}',
  'src/db/client.ts': 'export const client = {};',
  'src/db/migrate.ts': 'export function migrate() {}',
  'src/db/schema.ts': 'export const schema = {};',
};

const services: MapService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});

const filesOf = (tree: Record<string, string>) =>
  Object.entries(tree).map(([path, content]) => indexed(path, 'typescript', [], { contentHash: content }));

const noModel: StructuredModel = {
  generate: () => Promise.reject(new Error('the model must not be called')),
};

interface Setup {
  tree?: Record<string, string>;
  edges?: FileEdge[];
  mapJson?: unknown;
  reasoning?: StructuredModel;
  embed?: FakeEmbedModel;
  embeddingRule?: EmbeddingRule | null;
  agentIdle?: boolean;
  settle?: boolean;
  onEmbeddingProgress?: (progress: { done: number; total: number } | null) => void;
  expectWrite?: (rel: string, hash: string) => void;
  root?: string;
  backgroundAi?: () => BackgroundAiStatus;
}

const READY = (): BackgroundAiStatus => ({ state: 'ready', engine: 'claude', modelId: 'haiku', note: null });

async function startService(setup: Setup = {}) {
  const tree = setup.tree ?? PROJECT;
  const root = setup.root ?? tempDir('ide-map-');
  const stateDir = tempDir('ide-state-');
  await writeTree(root, tree);
  if (setup.mapJson !== undefined) {
    const text = typeof setup.mapJson === 'string' ? setup.mapJson : JSON.stringify(setup.mapJson);
    await writeTree(root, { '.ide/map.json': text });
  }
  const service = new MapService({
    root,
    projectName: 'demo',
    stateDir,
    reasoning: setup.reasoning ?? new ScriptedModel(componentsPerDirectory),
    embed: setup.embed ?? new FakeEmbedModel(),
    isAgentIdle: () => setup.agentIdle ?? true,
    onChange: () => undefined,
    backgroundAi: setup.backgroundAi ?? READY,
    embeddingRule: setup.embeddingRule ?? null,
    mapPollMs: 20,
    onEmbeddingProgress: setup.onEmbeddingProgress,
    expectWrite: setup.expectWrite,
  });
  services.push(service);
  await service.start(filesOf(tree), setup.edges ?? []);
  if (setup.settle ?? true) await service.idle();
  return { root, service, tree, stateDir };
}

async function change(root: string, service: MapService, tree: Record<string, string>): Promise<void> {
  await writeTree(root, tree);
  service.update(filesOf(tree), []);
  await service.idle();
}

const readMap = async (root: string) =>
  JSON.parse(await readFile(join(root, '.ide/map.json'), 'utf8')) as {
    groupedAt: string;
    components: { id: string; files: string[]; globs: string[] }[];
    manual: { id: string }[];
  };

const componentOf = (service: MapService, path: string) =>
  service.view().components.find((component) => component.files.includes(path))?.id ?? null;

const WIDE = Object.fromEntries(
  ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].flatMap((dir) =>
    Array.from({ length: 5 }, (_, i) => [`src/${dir}/f${i}.ts`, `export const ${dir}f${i} = ${i};`]),
  ),
);
const WIDE_ALIAS = { 'src/a2': 'src/a1', 'src/a3': 'src/a1', 'src/a4': 'src/a1', 'src/a5': 'src/a1', 'src/b2': 'src/b1', 'src/b3': 'src/b1', 'src/b4': 'src/b1' };
const MARGIN: EmbeddingRule = { kind: 'margin', min: 0.1 };

function apiAndDb(request: StructuredRequest): unknown {
  const groups = [...promptGroups(request.prompt)];
  const byName = (prefix: string) => groups.filter(([, paths]) => paths[0]?.startsWith(prefix)).map(([id]) => id);
  return groupingAnswer([
    { name: 'Api', groups: byName('src/a') },
    { name: 'Db', groups: byName('src/b') },
  ]);
}

const wideService = (embed = new FakeEmbedModel({ alias: WIDE_ALIAS })) =>
  startService({ tree: WIDE, embed, reasoning: new ScriptedModel(apiAndDb), embeddingRule: MARGIN });

const API_DB_MAP = {
  version: 1,
  groupedAt: '2026-09-24T09:00:00.000Z',
  components: [
    { id: 'ai:api', name: 'Api', summary: '', description: '', keyFiles: [], files: Object.keys(PROJECT).slice(0, 3), globs: ['src/api/**'] },
    { id: 'ai:db', name: 'Db', summary: '', description: '', keyFiles: [], files: Object.keys(PROJECT).slice(3), globs: ['src/db/**'] },
  ],
  manual: [],
};

describe('MapService', () => {
  it('registers the map save with the hash of the bytes it writes, before writing', async () => {
    const root = tempDir('ide-map-');
    const expected: { rel: string; hash: string; existed: boolean }[] = [];
    await startService({ root, expectWrite: (rel, hash) => expected.push({ rel, hash, existed: existsSync(join(root, rel)) }) });
    const text = await readFile(join(root, '.ide/map.json'), 'utf8');
    expect(expected).toEqual([{ rel: '.ide/map.json', hash: blobHash(text), existed: false }]);
  });

  it('groups a project without a map on first start and saves the AI map with its globs', async () => {
    const { root, service } = await startService();
    expect(service.view().components.map((component) => [component.id, component.files])).toEqual([
      ['ai:api', ['src/api/auth.ts', 'src/api/handlers.ts', 'src/api/routes.ts']],
      ['ai:db', ['src/db/client.ts', 'src/db/migrate.ts', 'src/db/schema.ts']],
    ]);
    expect((await readMap(root)).components.map((component) => [component.id, component.globs])).toEqual([
      ['ai:api', ['src/api/**']],
      ['ai:db', ['src/db/**']],
    ]);
  });

  it('keeps the files of manual components out of the grouping and shows them in their component', async () => {
    const mapJson = { version: 1, components: [], manual: [{ id: 'auth', name: 'Auth', files: ['src/api/auth.ts'] }] };
    const reasoning = new ScriptedModel(componentsPerDirectory);
    const { service } = await startService({ mapJson, reasoning });
    expect(reasoning.requests[0]?.prompt).not.toContain('src/api/auth.ts');
    expect([componentOf(service, 'src/api/auth.ts'), [...service.view().manualFiles]]).toEqual(['auth', ['src/api/auth.ts']]);
  });

  it('applies a manual assignment on top of the AI grouping', async () => {
    const { service } = await startService({ mapJson: { ...API_DB_MAP, assignments: { 'src/api/auth.ts': 'ai:db' } }, reasoning: noModel });
    expect(componentOf(service, 'src/api/auth.ts')).toBe('ai:db');
  });

  it('places a new file in the component that owns its directory', async () => {
    const { root, service } = await startService();
    await change(root, service, { ...PROJECT, 'src/db/seed.ts': 'export function seed() {}' });
    expect(componentOf(service, 'src/db/seed.ts')).toBe('ai:db');
  });

  it('leaves a new file in a new directory unassigned while the embedding rule is off', async () => {
    const { root, service } = await startService();
    await change(root, service, { ...PROJECT, 'src/jobs/worker.ts': 'export function work() {}' });
    expect([componentOf(service, 'src/jobs/worker.ts'), service.view().status.unassigned]).toEqual([null, 1]);
  });

  it('places a new file by embedding when its project passes the placement check', async () => {
    const { root, service } = await wideService();
    await change(root, service, { ...WIDE, 'src/a5/new.ts': 'export const fresh = 1;' });
    expect([componentOf(service, 'src/a5/new.ts'), service.view().status.embeddingPlacement?.on]).toEqual(['ai:api', true]);
  });

  it('keeps embedding placement off for a project whose own grouping fails the check, and says why', async () => {
    const { root, service } = await startService({ embeddingRule: MARGIN });
    await change(root, service, { ...PROJECT, 'src/jobs/worker.ts': 'export function work() {}' });
    const placement = service.view().status.embeddingPlacement;
    expect([componentOf(service, 'src/jobs/worker.ts'), placement?.on]).toEqual([null, false]);
    expect(placement?.detail).toContain('lower bound');
  });

  it('counts files as unassigned only once their vectors have arrived', async () => {
    const embed = new FakeEmbedModel({ alias: WIDE_ALIAS });
    const { root, service } = await wideService(embed);
    const release = embed.hold();
    const jobs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/jobs/j${i}.ts`, `export const j${i} = ${i};`]));
    await writeTree(root, jobs);
    service.update(filesOf({ ...WIDE, ...jobs }), []);
    const waiting = service.view().status;
    release();
    await service.idle();
    const settled = service.view().status;
    expect([waiting.pending, waiting.unassigned, waiting.stale]).toEqual([5, 0, false]);
    expect([settled.pending, settled.unassigned, settled.stale]).toEqual([0, 5, true]);
  });

  it('does not count manual files when deciding whether too many files are unassigned', async () => {
    const vendor = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`src/vendor/v${i}.ts`, `export const v${i} = ${i};`]));
    const mapJson = { ...API_DB_MAP, manual: [{ id: 'vendor', name: 'Vendor', globs: ['src/vendor/**'] }] };
    const { root, service } = await startService({ tree: { ...PROJECT, ...vendor }, mapJson, reasoning: noModel, agentIdle: false });
    const jobs = { 'src/jobs/a.ts': 'export const a = 1;', 'src/jobs/b.ts': 'export const b = 1;', 'src/jobs/c.ts': 'export const c = 1;' };
    await change(root, service, { ...PROJECT, ...vendor, ...jobs });
    expect(service.view().status.staleReasons).toEqual(['3 of 9 files are not in any component']);
  });

  it('keeps the previous map and reports the failure when a regroup answer is invalid', async () => {
    const { service } = await startService({ reasoning: new ScriptedModel(componentsPerDirectory, { components: [] }) });
    await service.regroup();
    const view = service.view();
    expect(view.components.map((component) => component.id)).toEqual(['ai:api', 'ai:db']);
    expect(view.status).toMatchObject({ layer: 'ai', grouping: 'failed', stale: true });
    expect(view.status.groupingError).toContain('invalid grouping');
  });

  it('shows folder components with the error when the first grouping fails', async () => {
    const reasoning = new ScriptedModel(() => {
      throw new Error('claude exited with code 1: not logged in');
    });
    const { service } = await startService({ reasoning });
    const view = service.view();
    expect(view.components.map((component) => component.id)).toEqual(['folder:src/api', 'folder:src/db']);
    expect(view.status).toMatchObject({ layer: 'folder', grouping: 'failed', groupingError: 'claude exited with code 1: not logged in' });
  });

  it('with the background AI off from the start, grouping is skipped, not failed, a map change schedules none, and once it is back a resume groups at once, even after a grouping failed', async () => {
    let status: BackgroundAiStatus = { state: 'checking' };
    const reasoning = new ScriptedModel(() => { throw new BackgroundAiOff('x'); }, () => { throw new Error('the engine left behind failed'); }, componentsPerDirectory);
    const { service, stateDir } = await startService({ reasoning, backgroundAi: () => status });
    const state = JSON.parse(await readFile(join(stateDir, 'regroup-state.json'), 'utf8'));
    expect([service.view().status.grouping, reasoning.requests.length, state]).toEqual(['idle', 1, { lastEndedAt: null, startedAt: null, failures: 0 }]);
    status = { state: 'off', reason: 'none', engine: null, hint: 'No AI engine is installed.' };
    expect([await service.regroup(), reasoning.requests.length, service.view().status.backgroundAi]).toEqual(['skipped', 1, status]);
    rmSync(join(stateDir, 'regroup-state.json'));
    service.onAgentIdle();
    expect(existsSync(join(stateDir, 'regroup-state.json'))).toBe(false);
    status = READY();
    service.onAgentIdle();
    await waitFor(() => service.view().status.grouping === 'failed', 'the failed grouping');
    service.resumeGrouping();
    await waitFor(() => service.view().status.layer === 'ai', 'the AI map');
  });

  it('keeps manual components that were added to map.json while a regroup ran', async () => {
    const model = new GatedModel();
    const { root, service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    await writeTree(root, { '.ide/map.json': JSON.stringify({ version: 1, components: [], manual: [{ id: 'auth', name: 'Auth', files: ['src/api/auth.ts'] }] }) });
    model.answer(componentsPerDirectory);
    await service.idle();

    const saved = await readMap(root);
    expect([saved.manual.map((component) => component.id), saved.components.flatMap((component) => component.files)]).toEqual([
      ['auth'],
      ['src/api/handlers.ts', 'src/api/routes.ts', 'src/db/client.ts', 'src/db/migrate.ts', 'src/db/schema.ts'],
    ]);
    expect(componentOf(service, 'src/api/auth.ts')).toBe('auth');
  });

  it('does not overwrite a map.json that broke after start and keeps the new grouping in memory', async () => {
    const { root, service } = await startService({ mapJson: API_DB_MAP, reasoning: new ScriptedModel(componentsPerDirectory) });
    await writeFile(join(root, '.ide/map.json'), '{ "version": 1, broken');
    await service.regroup();
    await service.idle();

    expect(await readFile(join(root, '.ide/map.json'), 'utf8')).toBe('{ "version": 1, broken');
    expect(service.view().status).toMatchObject({ layer: 'ai', grouping: 'idle' });
    expect(service.view().status.warnings.join('\n')).toContain('kept in memory');
  });

  it('applies a map.json changed on disk', async () => {
    const { root, service } = await startService({ mapJson: API_DB_MAP, reasoning: noModel });
    await writeTree(root, { '.ide/map.json': JSON.stringify({ ...API_DB_MAP, manual: [{ id: 'auth', name: 'Auth', files: ['src/api/auth.ts'] }] }) });
    await waitFor(() => componentOf(service, 'src/api/auth.ts') === 'auth', 'the edited map applied');
  });

  it('adopts a grouping that another process wrote while its own regroup ran', async () => {
    const model = new GatedModel();
    const { root, service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    const other = {
      version: 1,
      groupedAt: '2026-09-24T11:00:00.000Z',
      components: [{ id: 'ai:backend', name: 'Backend', summary: '', description: '', keyFiles: [], files: Object.keys(PROJECT), globs: ['src/**'] }],
    };
    await writeTree(root, { '.ide/map.json': JSON.stringify(other) });
    model.answer(componentsPerDirectory);
    await service.idle();

    expect(service.view().components.map((component) => component.id)).toEqual(['ai:backend']);
    expect((await readMap(root)).groupedAt).toBe('2026-09-24T11:00:00.000Z');
  });

  it('measures staleness against a map.json from another grouping only from the moment it arrives', async () => {
    const tree = Object.fromEntries(['a', 'b', 'c', 'd'].flatMap((dir) => [[`${dir}/one.ts`, `${dir}1`], [`${dir}/two.ts`, `${dir}2`]]));
    const edges = [
      { from: 'a/one.ts', to: 'b/one.ts', kind: 'import' as const },
      { from: 'b/one.ts', to: 'c/one.ts', kind: 'import' as const },
      { from: 'c/one.ts', to: 'd/one.ts', kind: 'import' as const },
      { from: 'd/one.ts', to: 'a/one.ts', kind: 'import' as const },
    ];
    const component = (id: string, dirs: string[]) => ({
      id,
      name: id,
      summary: '',
      description: '',
      keyFiles: [],
      files: dirs.flatMap((dir) => [`${dir}/one.ts`, `${dir}/two.ts`]),
      globs: dirs.map((dir) => `${dir}/**`),
    });
    const before = { version: 1, groupedAt: 'T1', components: ['a', 'b', 'c', 'd'].map((dir) => component(`ai:${dir}`, [dir])) };
    const { root, service } = await startService({ tree, edges, mapJson: before, reasoning: noModel });
    const after = { version: 1, groupedAt: 'T2', components: [component('ai:ab', ['a', 'b']), component('ai:cd', ['c', 'd'])] };
    await writeTree(root, { '.ide/map.json': JSON.stringify(after) });
    await waitFor(() => componentOf(service, 'a/one.ts') === 'ai:ab', 'the other grouping applied');
    await service.idle();

    expect(service.view().status).toMatchObject({ stale: false, staleReasons: [] });
  });

  it('groups by folders and still places new files by their directory when the embedding model is unavailable', async () => {
    const embed = new FakeEmbedModel({ status: { state: 'unavailable', reason: 'offline' } });
    const { root, service } = await startService({ embed, embeddingRule: { kind: 'threshold', min: 0.9 } });
    await change(root, service, { ...PROJECT, 'src/db/seed.ts': 'export function seed() {}', 'src/jobs/run.ts': 'export function run() {}' });
    expect([componentOf(service, 'src/db/seed.ts'), componentOf(service, 'src/jobs/run.ts')]).toEqual(['ai:db', null]);
    expect(service.view().status).toMatchObject({ embeddings: 'unavailable', embeddingsError: 'offline', pending: 0, unassigned: 1 });
  });

  it('cancels a running grouping when it stops and writes no map.json', async () => {
    const model = new GatedModel();
    const { root, service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    await service.stop();
    expect([model.cancelled, existsSync(join(root, '.ide/map.json'))]).toEqual([true, false]);
  });

  it('leaves files deleted while a regroup ran out of the new map', async () => {
    const model = new GatedModel();
    const { root, service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    const { 'src/db/schema.ts': _removed, ...rest } = PROJECT;
    service.update(filesOf(rest), []);
    model.answer(componentsPerDirectory);
    await service.idle();
    const saved = await readMap(root);
    expect(saved.components.flatMap((component) => component.files)).not.toContain('src/db/schema.ts');
    expect(saved.components.find((component) => component.id === 'ai:db')?.globs).toEqual(['src/db/**']);
  });

  it('stops without waiting for embeddings that are still running', async () => {
    const embed = new FakeEmbedModel();
    embed.hold();
    const { service } = await startService({ embed, settle: false });
    await waitFor(() => embed.calls.length === 1, 'embedding started');
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('applies a map.json edit while embeddings are still running', async () => {
    const embed = new FakeEmbedModel();
    const { root, service } = await startService({ mapJson: API_DB_MAP, reasoning: noModel, embed });
    const release = embed.hold();
    const extra = { 'src/api/extra.ts': 'export const extra = 1;' };
    await writeTree(root, extra);
    service.update(filesOf({ ...PROJECT, ...extra }), []);
    await writeTree(root, { '.ide/map.json': JSON.stringify({ ...API_DB_MAP, manual: [{ id: 'auth', name: 'Auth', files: ['src/api/auth.ts'] }] }) });
    await waitFor(() => componentOf(service, 'src/api/auth.ts') === 'auth', 'the edit applied while embedding');
    release();
  });

  it('neither groups nor writes a map for a project whose files are all manual', async () => {
    const mapJson = { version: 1, components: [], manual: [{ id: 'all', name: 'All', globs: ['src/**'] }] };
    const { root, service } = await startService({ mapJson, reasoning: noModel });
    expect([await readFile(join(root, '.ide/map.json'), 'utf8'), service.view().status.grouping]).toEqual([JSON.stringify(mapJson), 'idle']);
  });

  it('does not rewrite map.json when a regroup gives the same grouping', async () => {
    const { root, service } = await startService();
    const before = await readFile(join(root, '.ide/map.json'), 'utf8');
    await service.regroup();
    await service.idle();
    expect(await readFile(join(root, '.ide/map.json'), 'utf8')).toBe(before);
  });

  it('writes the newest in-memory grouping once a broken map.json is repaired', async () => {
    const renamed = (request: StructuredRequest) =>
      groupingAnswer([...promptGroups(request.prompt)].map(([id, paths]) => ({ name: paths[0]!.includes('/api/') ? 'Http' : 'Storage', groups: [id] })));
    const { root, service } = await startService({ mapJson: API_DB_MAP, reasoning: new ScriptedModel(componentsPerDirectory, renamed) });
    await writeFile(join(root, '.ide/map.json'), '{ "version": 1, broken');
    await service.regroup();
    await service.regroup();
    await writeTree(root, { '.ide/map.json': JSON.stringify(API_DB_MAP) });
    await waitFor(async () => (await readFile(join(root, '.ide/map.json'), 'utf8')).includes('"Http"'), 'the newest grouping written');
  });

  it('keeps the globs of a grouping when a file appears while it runs', async () => {
    const model = new GatedModel();
    const { root, service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    const late = { 'src/api/late.ts': 'export const late = 1;' };
    await writeTree(root, late);
    service.update(filesOf({ ...PROJECT, ...late }), []);
    model.answer(componentsPerDirectory);
    await service.idle();
    const api = (await readMap(root)).components.find((component) => component.id === 'ai:api');
    expect([api?.globs, componentOf(service, 'src/api/late.ts')]).toEqual([['src/api/**'], 'ai:api']);
  });

  it('shows what the running grouping sends until it finishes', async () => {
    const model = new GatedModel();
    const { service } = await startService({ reasoning: model, settle: false });
    await waitFor(() => model.requests.length === 1, 'the grouping asked the model');
    const running = service.view().status;
    model.answer(componentsPerDirectory);
    await service.idle();
    expect([running.grouping, running.sending, service.view().status.sending]).toEqual(['running', { paths: 6, symbols: 0, links: 0 }, null]);
  });

  it('publishes an embedding status change even while the pass it started is still running', async () => {
    const embed = new FakeEmbedModel({ status: { state: 'downloading', bytes: 1000 } });
    const release = embed.hold();
    let changes = 0;
    const root = tempDir('ide-map-');
    await writeTree(root, PROJECT);
    const service = new MapService({
      root,
      projectName: 'demo',
      stateDir: tempDir('ide-state-'),
      reasoning: new ScriptedModel(componentsPerDirectory),
      embed,
      isAgentIdle: () => true,
      onChange: () => (changes += 1),
      backgroundAi: READY,
      mapPollMs: 20,
    });
    services.push(service);
    await service.start(filesOf(PROJECT), []);
    await waitFor(() => embed.calls.length === 1, 'embedding started');
    service.view();
    changes = 0;

    embed.setStatus({ state: 'ready' });

    expect(changes).toBeGreaterThan(0);
    release();
    await service.idle();
  });

  it('does not group a project with more files than AI grouping allows', async () => {
    const reasoning = new ScriptedModel(componentsPerDirectory);
    const root = tempDir('ide-map-');
    const service = new MapService({
      root,
      projectName: 'huge',
      stateDir: tempDir('ide-state-'),
      reasoning,
      embed: new FakeEmbedModel({ status: { state: 'unavailable', reason: 'offline' } }),
      isAgentIdle: () => true,
      onChange: () => undefined,
      backgroundAi: READY,
    });
    services.push(service);
    await service.start(filesOf(Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`src/f${i}.ts`, `${i}`]))), []);
    await service.idle();
    expect([service.view().status.grouping, reasoning.requests.length]).toEqual(['too-large', 0]);
  });

  it('reports embedding progress during the first pass and clears it at the end', async () => {
    const progress: ({ done: number; total: number } | null)[] = [];
    await startService({ onEmbeddingProgress: (current) => progress.push(current) });
    expect(progress[0]).toEqual({ done: 0, total: Object.keys(PROJECT).length });
    expect(progress.at(-1)).toBeNull();
  });

  it('ignores an idle signal before it has started', async () => {
    const service = new MapService({
      root: tempDir('ide-map-'), projectName: 'demo', stateDir: tempDir('ide-state-'),
      reasoning: noModel, embed: new FakeEmbedModel(), isAgentIdle: () => true, onChange: () => undefined, backgroundAi: READY, embeddingRule: null,
    });
    services.push(service);
    service.onAgentIdle();
    await service.idle();
    expect(service.view().status.grouping).toBe('idle');
  });
});
