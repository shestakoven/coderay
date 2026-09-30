import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchManual, ownedGlobs, projectComponents } from '../../src/map/component-map';
import type { AiComponent, ManualComponent } from '../../src/map/map-file';

const PATHS = ['src/api/auth.ts', 'src/api/routes.ts', 'src/db/client.ts', 'src/db/schema.ts', 'src/main.ts'];

const ai = (id: string, files: string[], keyFiles: string[] = []): AiComponent => ({
  id,
  name: id.slice(3),
  summary: `${id} summary`,
  description: `${id} description`,
  keyFiles,
  files,
  globs: [`${id.slice(3)}/**`],
});

const manual = (id: string, files: string[], globs: string[] = []): ManualComponent => ({
  id,
  name: id,
  summary: '',
  description: '',
  files,
  globs,
});

describe('matchManual', () => {
  it('gives an assignment precedence over the files and globs of manual components', () => {
    const { owner } = matchManual(PATHS, [manual('storage', [], ['src/db/**'])], new Map([['src/db/client.ts', 'ai:api']]), new Set(['ai:api', 'storage']));
    expect(owner).toEqual(new Map([['src/db/client.ts', 'ai:api'], ['src/db/schema.ts', 'storage']]));
  });

  it('reports an assignment to an unknown component and ignores it', () => {
    const { owner, dangling } = matchManual(PATHS, [], new Map([['src/main.ts', 'ai:gone']]), new Set(['ai:api']));
    expect([owner.size, dangling]).toEqual([0, ['src/main.ts']]);
  });
});

describe('ownedGlobs', () => {
  it('gives a component globs only for the directories whose files all belong to it', () => {
    const components = [
      { id: 'ai:api', files: ['src/api/auth.ts', 'src/api/routes.ts', 'src/db/schema.ts'] },
      { id: 'ai:db', files: ['src/db/client.ts'] },
    ];
    expect(ownedGlobs(components, PATHS)).toEqual(
      new Map([
        ['ai:api', ['src/api/**']],
        ['ai:db', []],
      ]),
    );
  });
});

describe('ownedGlobs escaping', () => {
  it('escapes a directory once so a literal app/[id] glob matches only that directory', () => {
    const files = ['app/[id]/page.ts', 'app/[id]/x.ts', 'lib/a(b)/y.ts'];
    const globs = ownedGlobs([{ id: 'ai:web', files }], [...files, 'app/i/page.ts', 'lib/z.ts']).get('ai:web')!;
    expect(globs).toEqual(['app/[[]id[]]/**', 'lib/a[(]b[)]/**']);
    expect(globs.some((glob) => posix.matchesGlob('app/[id]/page.ts', glob))).toBe(true);
    expect(globs.some((glob) => posix.matchesGlob('app/i/page.ts', glob))).toBe(false);
  });
});

describe('projectComponents', () => {
  it('uses folder components for the files that are not manual when there is no AI map', () => {
    const components = projectComponents({ paths: PATHS, manual: [manual('entry', ['src/main.ts'])], ai: null, owner: new Map([['src/main.ts', 'entry']]) });
    expect(components.map((component) => [component.id, component.source, component.files])).toEqual([
      ['folder:src/api', 'folder', ['src/api/auth.ts', 'src/api/routes.ts']],
      ['folder:src/db', 'folder', ['src/db/client.ts', 'src/db/schema.ts']],
      ['entry', 'manual', ['src/main.ts']],
    ]);
  });

  it('builds AI components from their current members, keeps their stored globs and drops the empty ones', () => {
    const owner = new Map([
      ['src/api/auth.ts', 'ai:api'],
      ['src/api/routes.ts', 'ai:api'],
      ['src/main.ts', 'ai:api'],
    ]);
    const components = projectComponents({
      paths: PATHS,
      manual: [],
      ai: [ai('ai:api', ['src/api/auth.ts', 'src/api/gone.ts'], ['src/api/gone.ts', 'src/api/routes.ts']), ai('ai:old', ['src/old/x.ts'])],
      owner,
    });
    expect(components.map((component) => [component.id, component.files, component.keyFiles, component.globs])).toEqual([
      ['ai:api', ['src/api/auth.ts', 'src/api/routes.ts', 'src/main.ts'], ['src/api/routes.ts'], ['api/**']],
    ]);
  });
});
