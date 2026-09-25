import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyMapFile, readMapFile, watchMapFile, writeMapFile, type AiComponent } from '../../src/map/map-file';
import { tempDir, writeTree } from '../helpers';

async function rootWithMap(content: string): Promise<string> {
  const root = tempDir('ide-mapfile-');
  await writeTree(root, { '.ide/map.json': content });
  return root;
}

const API: AiComponent = {
  id: 'ai:api',
  name: 'API',
  summary: 'Serves HTTP requests',
  description: 'Routes and handlers.',
  keyFiles: ['src/api/routes.ts'],
  files: ['src/api/routes.ts'],
  globs: ['src/api/**'],
};

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('map.json', () => {
  it('reads a missing map.json as no AI map, no manual components and no assignments', async () => {
    expect(await readMapFile(tempDir('ide-mapfile-'))).toEqual(emptyMapFile());
  });

  it('writes the AI components and keeps every key it does not own exactly as it was written', async () => {
    const user = {
      version: 1,
      manual: [{ id: 'auth', name: 'Auth', files: ['src/auth.ts'], note: 'kept as written' }],
      assignments: { 'src/util.ts': 'ai:api' },
      owner: 'platform team',
    };
    const root = await rootWithMap(JSON.stringify(user));
    const before = await readMapFile(root);

    const written = await writeMapFile(root, { ai: [API], groupedAt: '2026-09-24T10:00:00.000Z', raw: before.raw }, before.hash);
    const saved = JSON.parse(await readFile(join(root, '.ide/map.json'), 'utf8')) as Record<string, unknown>;

    expect(saved).toEqual({ ...user, groupedAt: '2026-09-24T10:00:00.000Z', components: [API] });
    expect(written).toEqual(await readMapFile(root));
  });

  it('strips bidi overrides and zero-width characters from a loaded component and bounds an over-long summary', async () => {
    const root = await rootWithMap(
      JSON.stringify({
        version: 1,
        components: [{ ...API, name: 'Map\u200bUI\u202e Core', summary: 'y'.repeat(200) }],
        manual: [{ id: 'auth', name: 'Auth\u200bentication', files: [], globs: [] }],
      }),
    );
    const read = await readMapFile(root);
    expect(read.ai?.[0]).toMatchObject({ name: 'MapUI Core', summary: 'y'.repeat(120) });
    expect(read.manual[0]?.name).toBe('Authentication');
  });

  it('never splits a surrogate pair when bounding a summary to its max length', async () => {
    const summary = `${'a'.repeat(119)}\u{1F600}`;
    const root = await rootWithMap(JSON.stringify({ version: 1, components: [{ ...API, summary }] }));
    const cleaned = (await readMapFile(root)).ai?.[0]?.summary ?? '';
    expect(cleaned).toBe('a'.repeat(119));
    expect(/[\ud800-\udbff]$/.test(cleaned)).toBe(false);
  });

  it('normalizes an AI component id whose invisible characters can simply be stripped, and rejects one whose shape stays unsafe', async () => {
    const root = await rootWithMap(
      JSON.stringify({
        version: 1,
        components: [
          { ...API, id: 'ai:\u200bapi' },
          { ...API, id: 'ai:Not Safe!', name: 'Other' },
        ],
      }),
    );
    const read = await readMapFile(root);
    expect(read.ai?.map((component) => component.id)).toEqual(['ai:api']);
    expect(read.warnings).toEqual(['.ide/map.json: components[1] is invalid; it was ignored']);
  });

  it('keeps a manual component name written in Cyrillic', async () => {
    const root = await rootWithMap(
      JSON.stringify({ version: 1, components: [], manual: [{ id: 'auth', name: 'Аутентификация', files: [], globs: [] }] }),
    );
    expect((await readMapFile(root)).manual[0]?.name).toBe('Аутентификация');
  });

  it('keeps a manual component name written in CJK', async () => {
    const root = await rootWithMap(JSON.stringify({ version: 1, components: [], manual: [{ id: 'auth', name: '认证服务', files: [], globs: [] }] }));
    expect((await readMapFile(root)).manual[0]?.name).toBe('认证服务');
  });

  it('keeps accented Latin characters in a manual component name', async () => {
    const root = await rootWithMap(
      JSON.stringify({ version: 1, components: [], manual: [{ id: 'reports', name: 'Génération de rapports', files: [], globs: [] }] }),
    );
    expect((await readMapFile(root)).manual[0]?.name).toBe('Génération de rapports');
  });

  it('cleans a bidi override and a zero-width character from a manual component name without touching its script', async () => {
    const root = await rootWithMap(
      JSON.stringify({ version: 1, components: [], manual: [{ id: 'auth', name: '\u202eАутент\u200bификация', files: [], globs: [] }] }),
    );
    expect((await readMapFile(root)).manual[0]?.name).toBe('Аутентификация');
  });

  it('still bounds an AI component name to its Latin whitelist, unlike a manual name', async () => {
    const root = await rootWithMap(JSON.stringify({ version: 1, components: [{ ...API, name: 'Аутентификация' }] }));
    const read = await readMapFile(root);
    expect([read.ai, read.warnings]).toEqual([null, ['.ide/map.json: components[0] is invalid; it was ignored']]);
  });

  it('ignores an invalid manual entry and says why', async () => {
    const root = await rootWithMap(
      JSON.stringify({
        version: 1,
        components: [],
        manual: [{ id: 'auth', name: 'Auth' }, { name: 'No id' }, { id: 'ai:reserved', name: 'Reserved' }],
      }),
    );
    const read = await readMapFile(root);
    expect(read.manual.map((component) => component.id)).toEqual(['auth']);
    expect(read.warnings).toHaveLength(2);
  });

  it('ignores an assignment whose value is not a component id and says why', async () => {
    const root = await rootWithMap(JSON.stringify({ version: 1, components: [], assignments: { 'src/a.ts': 'auth', 'src/b.ts': 3 } }));
    const read = await readMapFile(root);
    expect(read.assignments).toEqual(new Map([['src/a.ts', 'auth']]));
    expect(read.warnings).toEqual(['.ide/map.json: assignments["src/b.ts"] must be a component id; it was ignored']);
  });

  it('marks a map.json that is not valid JSON as not writable', async () => {
    const read = await readMapFile(await rootWithMap('{ "version": 1, broken'));
    expect(read).toMatchObject({ ai: null, manual: [], writable: false });
    expect(read.warnings[0]).toContain('is not valid JSON');
  });

  it('does not write over a map.json that changed since it was read', async () => {
    const root = await rootWithMap(JSON.stringify({ version: 1, components: [] }));
    const { hash, raw } = await readMapFile(root);
    await writeFile(join(root, '.ide/map.json'), JSON.stringify({ version: 1, components: [], manual: [{ id: 'new', name: 'New' }] }));

    const result = await writeMapFile(root, { ai: [API], groupedAt: '2026-09-24T10:00:00.000Z', raw }, hash);

    expect(result).toBe('conflict');
    expect((await readMapFile(root)).manual.map((component) => component.id)).toEqual(['new']);
    expect(await readdir(join(root, '.ide'))).toEqual(['map.json']);
  });

  it('reports when map.json appears or changes on disk', async () => {
    const root = tempDir('ide-mapfile-');
    let changes = 0;
    const watch = watchMapFile(root, () => (changes += 1), 60_000);
    stops.push(watch.stop);
    const replace = async (content: string) => {
      await writeTree(root, { '.ide/next.json': content });
      await rename(join(root, '.ide/next.json'), join(root, '.ide/map.json'));
    };

    await watch.check();
    await replace('{}');
    await watch.check();
    await watch.check();
    await replace('{ "version": 1 }');
    await watch.check();

    expect(changes).toBe(2);
  });
});
