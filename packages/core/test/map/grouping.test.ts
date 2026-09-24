import { describe, expect, it } from 'vitest';
import type { GroupingPayload } from '@ide/protocol';
import { groupFiles, MAX_AI_FILES, MAX_GROUPS, type GroupingInput } from '../../src/map/grouping';
import type { AiComponent } from '../../src/map/map-file';
import {
  componentPerGroup,
  componentsPerDirectory,
  FakeEmbedModel,
  groupingAnswer,
  promptGroups,
  ScriptedModel,
} from '../models/fake-models';
import { unit } from '../helpers';

const PATHS = ['src/api/auth.ts', 'src/api/handlers.ts', 'src/api/routes.ts', 'src/db/client.ts', 'src/db/migrate.ts', 'src/db/schema.ts'];

function vectorsFor(paths: string[]): Map<string, Float32Array> {
  const fake = new FakeEmbedModel();
  return new Map(paths.map((path) => [path, fake.vectorFor(path)]));
}

const input = (paths: string[], vectors: ReadonlyMap<string, Float32Array> = vectorsFor(paths)): GroupingInput => ({
  projectName: 'demo',
  files: paths.map((path) => ({ path, symbols: [] })),
  vectors,
  edges: [],
  previous: [],
  reservedIds: [],
});

const previousComponent = (id: string, name: string, files: string[]): AiComponent => ({
  id,
  name,
  summary: `${name} summary`,
  description: '',
  keyFiles: [],
  files,
  globs: [],
});

describe('groupFiles', () => {
  it('returns named components with their sorted files and ids derived from the names', async () => {
    expect(await groupFiles(input(PATHS), new ScriptedModel(componentsPerDirectory))).toEqual([
      { id: 'ai:api', name: 'Api', summary: 'Api summary', description: 'Api description.', keyFiles: [], files: PATHS.slice(0, 3), globs: [] },
      { id: 'ai:db', name: 'Db', summary: 'Db summary', description: 'Db description.', keyFiles: [], files: PATHS.slice(3), globs: [] },
    ]);
  });

  it('splits a large folder into groups of similar files', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${String(i + 1).padStart(2, '0')}.ts`);
    const vectors = new Map(
      paths.map((path, i) => {
        const values = new Array<number>(15).fill(0);
        values[Math.floor(i / 4)] = 1;
        values[3 + i] = 0.05;
        return [path, unit(...values)] as const;
      }),
    );
    const result = await groupFiles(input(paths, vectors), new ScriptedModel(componentPerGroup));
    expect(result.map((component) => component.files)).toEqual([paths.slice(0, 4), paths.slice(4, 8), paths.slice(8)]);
  });

  it('keeps the files of a large folder that have no vector together in their own group', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${String(i + 1).padStart(2, '0')}.ts`);
    const model = new ScriptedModel(componentPerGroup);
    await groupFiles(input(paths, vectorsFor(paths.slice(0, 8))), model);
    expect([...promptGroups(model.requests[0]!.prompt).values()]).toContainEqual(paths.slice(8));
  });

  it('groups by folders when no vectors are available', async () => {
    const result = await groupFiles(input(PATHS, new Map()), new ScriptedModel(componentsPerDirectory));
    expect(result.map((component) => component.files)).toEqual([PATHS.slice(0, 3), PATHS.slice(3)]);
  });

  it('moves a file into the component the model names for it', async () => {
    const reply = groupingAnswer(
      [
        { name: 'Api', groups: ['g1'] },
        { name: 'Db', groups: ['g2'] },
      ],
      [{ file: 'src/db/client.ts', component: 'Api' }],
    );
    const [api, db] = await groupFiles(input(PATHS), new ScriptedModel(reply));
    expect(api?.files).toContain('src/db/client.ts');
    expect(db?.files).not.toContain('src/db/client.ts');
  });

  it('puts a test file in the component of the code it imports', async () => {
    const paths = [...PATHS, 'test/api.test.ts'];
    const grouping = { ...input(paths), edges: [{ from: 'test/api.test.ts', to: 'src/api/routes.ts', kind: 'import' as const }] };
    const result = await groupFiles(grouping, new ScriptedModel(componentsPerDirectory));
    expect(result.map((component) => [component.name, component.files.length])).toEqual([
      ['Api', 4],
      ['Db', 3],
    ]);
  });

  it('keeps the id of the previous component that a renamed component mostly overlaps', async () => {
    const reply = groupingAnswer([
      { name: 'HTTP Layer', groups: ['g1'] },
      { name: 'Db', groups: ['g2'] },
    ]);
    const grouping = { ...input(PATHS), previous: [previousComponent('ai:api', 'Api', PATHS.slice(0, 3))] };
    const [http] = await groupFiles(grouping, new ScriptedModel(reply));
    expect([http?.id, http?.name]).toEqual(['ai:api', 'HTTP Layer']);
  });

  it('does not give a new component the id of an unrelated previous one', async () => {
    const grouping = { ...input(PATHS), previous: [previousComponent('ai:db', 'Db', ['src/old/store.ts'])] };
    const result = await groupFiles(grouping, new ScriptedModel(componentsPerDirectory));
    expect(result.map((component) => component.id)).toEqual(['ai:api', 'ai:db-2']);
  });

  it('keeps an id that a manual assignment uses on the part of its split component that overlaps it most', async () => {
    const backend = previousComponent('ai:backend', 'Backend', [...PATHS, 'src/old/gone.ts']);
    const grouping = { ...input(PATHS), previous: [backend], reservedIds: ['ai:backend'] };
    const result = await groupFiles(grouping, new ScriptedModel(componentsPerDirectory));
    expect(result.map((component) => [component.id, component.name])).toEqual([
      ['ai:backend', 'Api'],
      ['ai:db', 'Db'],
    ]);
  });

  it('never gives a new component an id that a manual assignment names', async () => {
    const result = await groupFiles({ ...input(PATHS), reservedIds: ['ai:api'] }, new ScriptedModel(componentsPerDirectory));
    expect(result.map((component) => component.id)).toEqual(['ai:api-2', 'ai:db']);
  });

  it('tells the model which previous component each group mostly came from', async () => {
    const model = new ScriptedModel(componentsPerDirectory);
    await groupFiles({ ...input(PATHS), previous: [previousComponent('ai:api', 'Api', PATHS.slice(0, 3))] }, model);
    expect(model.requests[0]?.prompt).toContain('g1 (3 files, previously: Api):');
  });

  it('cleans control characters and unsafe characters from names and caps text lengths', async () => {
    const reply = {
      components: [{ name: 'Map\u0007 UI: Core', summary: 'x'.repeat(500), description: 'Draws\nthe map.', keyFiles: [] }],
      groups: { g1: 'Map\u0007 UI: Core', g2: 'Map\u0007 UI: Core' },
      moves: [],
    };
    const [component] = await groupFiles(input(PATHS), new ScriptedModel(reply));
    expect([component?.name, component?.summary.length, component?.description]).toEqual(['Map UI Core', 120, 'Draws the map.']);
  });

  it('retries once when an assigned component is not described and accepts the corrected answer', async () => {
    const undescribed = { ...groupingAnswer([{ name: 'Api', groups: ['g1'] }]), groups: { g1: 'Api', g2: 'Storage' } };
    const model = new ScriptedModel(undescribed, componentsPerDirectory);
    const result = await groupFiles(input(PATHS), model);
    expect(result.map((component) => component.name)).toEqual(['Api', 'Db']);
    expect(model.requests[1]?.prompt).toContain('not described in "components": "Storage"');
  });

  it('keeps a component without a description when the retry does not describe it either', async () => {
    const undescribed = { ...groupingAnswer([{ name: 'Api', groups: ['g1'] }]), groups: { g1: 'Api', g2: 'Storage' } };
    const model = new ScriptedModel(undescribed);
    const result = await groupFiles(input(PATHS), model);
    expect(result.map((component) => [component.name, component.summary, component.files.length])).toEqual([
      ['Api', 'Api summary', 3],
      ['Storage', '', 3],
    ]);
    expect(model.requests).toHaveLength(2);
  });

  it('fails after a second invalid answer', async () => {
    const model = new ScriptedModel({ components: [] });
    await expect(groupFiles(input(PATHS), model)).rejects.toThrow(
      'the model returned an invalid grouping: the answer needs a "components" list and a "groups" object',
    );
    expect(model.requests).toHaveLength(2);
  });

  it('reports how many paths, symbol names and dependency counts it sends before calling the model', async () => {
    const events: (GroupingPayload | 'model called')[] = [];
    const grouping = {
      ...input(PATHS),
      files: PATHS.map((path) => ({ path, symbols: ['first', 'second'] })),
      edges: [{ from: 'src/api/routes.ts', to: 'src/db/client.ts', kind: 'import' as const }],
    };
    const model = new ScriptedModel((request: unknown) => {
      events.push('model called');
      return componentsPerDirectory(request as never);
    });
    await groupFiles(grouping, model, { onSend: (payload) => events.push(payload) });
    expect(events).toEqual([{ paths: 6, symbols: 12, links: 1 }, 'model called']);
  });

  it('keeps the prompt within its budget for a project with thousands of files', async () => {
    const paths = Array.from({ length: 50 }, (_, dir) => Array.from({ length: 100 }, (_, file) => `pkg${dir}/file${file}.ts`)).flat();
    const model = new ScriptedModel(componentPerGroup);
    const result = await groupFiles(input(paths), model);
    expect(model.requests[0]!.prompt.split('\n').length).toBeLessThan(2500);
    expect(result.flatMap((component) => component.files)).toHaveLength(5000);
  });

  it('packs many small folders into at most the maximum number of groups', async () => {
    const paths = Array.from({ length: 600 }, (_, i) => [`packages/p${i}/a.ts`, `packages/p${i}/b.ts`]).flat();
    const model = new ScriptedModel(componentPerGroup);
    const result = await groupFiles(input(paths, new Map()), model);
    expect(promptGroups(model.requests[0]!.prompt).size).toBeLessThanOrEqual(MAX_GROUPS);
    expect(result.flatMap((component) => component.files)).toHaveLength(1200);
  });

  it('merges neighbouring groups of any size when packing small folders is not enough', async () => {
    const paths = Array.from({ length: 600 }, (_, i) => Array.from({ length: 13 }, (_, f) => `packages/p${i}/f${f}.ts`)).flat();
    const model = new ScriptedModel(componentPerGroup);
    const result = await groupFiles(input(paths, new Map()), model);
    expect(promptGroups(model.requests[0]!.prompt).size).toBeLessThanOrEqual(MAX_GROUPS);
    expect(result.flatMap((component) => component.files)).toHaveLength(7800);
  });

  it('refuses a project above the AI grouping limit without calling the model', async () => {
    const paths = Array.from({ length: MAX_AI_FILES + 1 }, (_, i) => `src/f${i}.ts`);
    const model = new ScriptedModel(componentsPerDirectory);
    await expect(groupFiles(input(paths, new Map()), model)).rejects.toThrow(`limited to ${MAX_AI_FILES} files`);
    expect(model.requests).toEqual([]);
  });
});
