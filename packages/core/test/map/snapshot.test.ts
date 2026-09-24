import { beforeAll, describe, expect, it } from 'vitest';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import type { LanguageAdapter } from '../../src/lang/types';
import { buildSnapshot } from '../../src/map/snapshot';
import { fixture, indexed } from '../helpers';

let adapters: LanguageAdapter[];

beforeAll(async () => {
  adapters = [await createTypeScriptAdapter(fixture('ts-paths'))];
});

describe('buildSnapshot', () => {
  it('assigns every file to its folder component and carries parse errors, symbols and edges', () => {
    const symbol = { name: 'handler', kind: 'function' as const, startLine: 1, endLine: 3, exported: true };
    const files = [
      indexed('src/db/b.ts', 'typescript', [], { parseError: true }),
      indexed('src/api/a.ts', 'typescript', ['../db/b'], { symbols: [symbol] }),
    ];
    const snapshot = buildSnapshot(3, 'demo', files, adapters);

    expect(snapshot).toMatchObject({ version: 3, projectName: 'demo' });
    expect(snapshot.files).toEqual([
      { path: 'src/api/a.ts', lang: 'typescript', componentId: 'folder:src/api', symbols: [symbol], parseError: false },
      { path: 'src/db/b.ts', lang: 'typescript', componentId: 'folder:src/db', symbols: [], parseError: true },
    ]);
    expect(snapshot.components.map((c) => c.id)).toEqual(['folder:src/api', 'folder:src/db']);
    expect(snapshot.fileEdges).toEqual([{ from: 'src/api/a.ts', to: 'src/db/b.ts', kind: 'import' }]);
  });
});
