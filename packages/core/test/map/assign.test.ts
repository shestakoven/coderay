import { describe, expect, it } from 'vitest';
import { assignFiles, nearestComponent, type AssignInput } from '../../src/map/assign';
import type { AiComponent } from '../../src/map/map-file';
import { unit } from '../helpers';

const ai = (id: string, files: string[], globs: string[] = []): AiComponent => ({
  id,
  name: id,
  summary: '',
  description: '',
  keyFiles: [],
  files,
  globs,
});

const API = ai('ai:api', ['src/api/routes.ts', 'src/api/auth.ts'], ['src/api/**']);
const DB = ai('ai:db', ['src/db/client.ts', 'lib/shared/pool.ts', 'lib/shared/queue.ts', 'lib/solo/only.ts']);
const VECTORS = new Map([
  ['src/api/routes.ts', unit(1, 0)],
  ['src/api/auth.ts', unit(1, 0)],
  ['src/db/client.ts', unit(0, 1)],
  ['lib/shared/pool.ts', unit(0, 1)],
]);

const assign = (paths: string[], overrides: Partial<AssignInput> = {}) =>
  assignFiles({
    paths: [...API.files, ...DB.files, ...paths],
    ai: [API, DB],
    manualOwner: new Map(),
    imports: new Map(),
    vector: (path) => VECTORS.get(path),
    rule: null,
    ...overrides,
  });

describe('assignFiles', () => {
  it('keeps a grouped file in its component even when its vector moved to another one', () => {
    const vector = (path: string) => (path === 'src/api/auth.ts' ? unit(0, 1) : VECTORS.get(path));
    const result = assign([], { vector, rule: { kind: 'threshold', min: 0.5 } });
    expect([result.owner.get('src/api/auth.ts'), result.evidence.get('src/api/auth.ts')]).toEqual(['ai:api', 'grouped']);
  });

  it('gives manual evidence precedence over the grouping', () => {
    const result = assign([], { manualOwner: new Map([['src/api/auth.ts', 'auth']]) });
    expect([result.owner.get('src/api/auth.ts'), result.evidence.get('src/api/auth.ts')]).toEqual(['auth', 'manual']);
  });

  it('places a new file under the stored glob of an AI component', () => {
    expect(assign(['src/api/users/list.ts']).owner.get('src/api/users/list.ts')).toBe('ai:api');
  });

  it('places a new test file with the code it imports, even under the glob of another component', () => {
    const imports = new Map([['src/api/client.test.ts', ['src/db/client.ts']]]);
    const result = assign(['src/api/client.test.ts'], { imports });
    expect([result.owner.get('src/api/client.test.ts'), result.evidence.get('src/api/client.test.ts')]).toEqual(['ai:db', 'test']);
  });

  it('leaves a new file unassigned when it has a single sibling', () => {
    expect(assign(['lib/solo/extra.ts']).unassigned).toEqual(['lib/solo/extra.ts']);
  });

  it('places a new file with its siblings when at least two of them all belong to one component', () => {
    const result = assign(['lib/shared/retry.ts']);
    expect([result.owner.get('lib/shared/retry.ts'), result.evidence.get('lib/shared/retry.ts')]).toEqual(['ai:db', 'directory']);
  });

  it('leaves a new file unassigned when its siblings are not all in one AI component', () => {
    const result = assign(['lib/shared/retry.ts'], { manualOwner: new Map([['lib/shared/pool.ts', 'pools']]) });
    expect(result.unassigned).toEqual(['lib/shared/retry.ts']);
  });

  it('leaves a file that no other rule places unassigned while the embedding rule is off', () => {
    const vector = (path: string) => (path === 'tools/gen.ts' ? unit(1, 0.05) : VECTORS.get(path));
    expect(assign(['tools/gen.ts'], { vector }).unassigned).toEqual(['tools/gen.ts']);
  });

  it('places such a file with the nearest component when the embedding rule accepts it', () => {
    const vector = (path: string) => (path === 'tools/gen.ts' ? unit(1, 0.05) : VECTORS.get(path));
    const result = assign(['tools/gen.ts'], { vector, rule: { kind: 'threshold', min: 0.9 } });
    expect([result.owner.get('tools/gen.ts'), result.evidence.get('tools/gen.ts')]).toEqual(['ai:api', 'embedding']);
  });

  it('places nothing by embedding while only one component has a centroid', () => {
    const vector = (path: string) => (path === 'tools/gen.ts' ? unit(0, 1) : VECTORS.get(path));
    const result = assign(['tools/gen.ts'], { vector, rule: { kind: 'margin', min: 0 }, ai: [API] });
    expect(result.unassigned).toContain('tools/gen.ts');
  });

  it('keeps a file pending while its vector is missing and the embedding rule is on', () => {
    const result = assign(['tools/gen.ts'], { rule: { kind: 'threshold', min: 0.9 } });
    expect([result.pending, result.unassigned]).toEqual([['tools/gen.ts'], []]);
  });

  it('matches a "dir/**" AI glob by prefix, and not a sibling directory that merely starts with the same name', () => {
    const result = assign(['src/apiExtra/file.ts']);
    expect(result.owner.get('src/apiExtra/file.ts')).toBeUndefined();
    expect(assign(['src/api/nested/deep/file.ts']).owner.get('src/api/nested/deep/file.ts')).toBe('ai:api');
  });

  it('matches a "**" AI glob against any path', () => {
    const catchAll = ai('ai:catchall', [], ['**']);
    const result = assignFiles({
      paths: [...catchAll.files, 'anything/at/all.ts'],
      ai: [catchAll],
      manualOwner: new Map(),
      imports: new Map(),
      vector: () => undefined,
      rule: null,
    });
    expect(result.owner.get('anything/at/all.ts')).toBe('ai:catchall');
  });

  it('falls back to a general glob matcher for a stored AI glob of any other shape', () => {
    const custom = ai('ai:custom', [], ['tools/*.ts']);
    const result = assignFiles({
      paths: [...custom.files, 'tools/gen.ts', 'tools/nested/gen.ts'],
      ai: [custom],
      manualOwner: new Map(),
      imports: new Map(),
      vector: () => undefined,
      rule: null,
    });
    expect([result.owner.get('tools/gen.ts'), result.owner.get('tools/nested/gen.ts')]).toEqual(['ai:custom', undefined]);
  });

  it('falls back to a general glob matcher when the "dir/**" prefix itself contains glob metacharacters', () => {
    const generated = ai('ai:generated', [], ['src/*/generated/**']);
    const result = assignFiles({
      paths: [...generated.files, 'src/a/generated/x.ts'],
      ai: [generated],
      manualOwner: new Map(),
      imports: new Map(),
      vector: () => undefined,
      rule: null,
    });
    expect(result.owner.get('src/a/generated/x.ts')).toBe('ai:generated');
  });

  it('places 2,000 files under 300 "dir/**" AI globs well under the cost of a general glob matcher', () => {
    const components = Array.from({ length: 300 }, (_, i) => ai(`ai:d${i}`, [], [`d${i}/**`]));
    const paths = Array.from({ length: 2000 }, (_, i) => `d${i % 300}/f${i}.ts`);
    const run = () => assignFiles({
      paths,
      ai: components,
      manualOwner: new Map(),
      imports: new Map(),
      vector: () => undefined,
      rule: null,
    });
    const timings: number[] = [];
    let result = run();
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      result = run();
      timings.push(performance.now() - start);
    }
    expect(Math.min(...timings)).toBeLessThan(200);
    expect(result.owner.get('d17/f17.ts')).toBe('ai:d17');
    expect(result.unassigned).toEqual([]);
  });
});

describe('nearestComponent', () => {
  const centroids = new Map([
    ['ai:a', unit(1, 0)],
    ['ai:b', unit(0, 1)],
  ]);

  it('accepts the nearest component in threshold mode only when it is similar enough', () => {
    const rule = { kind: 'threshold', min: 0.9 } as const;
    expect([nearestComponent(unit(0.9, 0.3), centroids, rule), nearestComponent(unit(1, 1), centroids, rule)]).toEqual(['ai:a', null]);
  });

  it('accepts the nearest component in margin mode only when it leads the second one by the margin', () => {
    const rule = { kind: 'margin', min: 0.3 } as const;
    expect([nearestComponent(unit(0.9, 0.3), centroids, rule), nearestComponent(unit(1, 0.8), centroids, rule)]).toEqual(['ai:a', null]);
  });
});
