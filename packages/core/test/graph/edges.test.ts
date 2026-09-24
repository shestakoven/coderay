import { beforeAll, describe, expect, it } from 'vitest';
import type { FileEdge } from '@ide/protocol';
import { computeFileEdges } from '../../src/graph/edges';
import { createPythonAdapter } from '../../src/lang/python';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import type { LanguageAdapter } from '../../src/lang/types';
import { fixture, indexed } from '../helpers';

let adapters: LanguageAdapter[];
const pairs = (edges: FileEdge[]) => edges.map((e) => `${e.from} -> ${e.to}`).sort();

beforeAll(async () => {
  adapters = [await createTypeScriptAdapter(fixture('ts-paths')), await createPythonAdapter()];
});

describe('computeFileEdges', () => {
  it('turns resolvable TypeScript imports into edges and drops packages', () => {
    const files = [
      indexed('src/main.ts', 'typescript', ['./server', '@/config', './lazy.js', 'express']),
      indexed('src/server.ts', 'typescript', ['@/config']),
      indexed('src/config/index.ts', 'typescript', []),
      indexed('src/lazy.ts', 'typescript', []),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual([
      'src/main.ts -> src/config/index.ts',
      'src/main.ts -> src/lazy.ts',
      'src/main.ts -> src/server.ts',
      'src/server.ts -> src/config/index.ts',
    ]);
  });

  it('turns resolvable Python imports into edges', () => {
    const files = [
      indexed('app/main.py', 'python', ['.db', '.db.connect', 'app.models', 'os']),
      indexed('app/db.py', 'python', []),
      indexed('app/models/__init__.py', 'python', ['.user']),
      indexed('app/models/user.py', 'python', []),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual([
      'app/main.py -> app/db.py',
      'app/main.py -> app/models/__init__.py',
      'app/models/__init__.py -> app/models/user.py',
    ]);
  });

  it('ignores self-imports and imports of files that are not indexed', () => {
    const files = [indexed('src/a.ts', 'typescript', ['./a', './missing'])];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });
});
