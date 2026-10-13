import { beforeAll, describe, expect, it } from 'vitest';
import type { FileEdge } from '@ide/protocol';
import { computeFileEdges, unresolvedImports } from '../../src/graph/edges';
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

  it('resolves an import of a deleted file when its path is named as a ghost', () => {
    const files = [indexed('app/api/routes.py', 'python', ['app.utils.throttle'])];
    expect(pairs(computeFileEdges(files, adapters))).toEqual([]);
    expect(pairs(computeFileEdges(files, adapters, ['app/utils/throttle.py']))).toEqual(['app/api/routes.py -> app/utils/throttle.py']);
  });

  it('lets a live file win over a deleted path named as a ghost', () => {
    const files = [indexed('app/api/routes.py', 'python', ['app.utils.throttle']), indexed('app/utils/throttle/__init__.py', 'python', [])];
    expect(pairs(computeFileEdges(files, adapters, ['app/utils/throttle.py']))).toEqual(['app/api/routes.py -> app/utils/throttle/__init__.py']);
  });
});

describe('unresolvedImports', () => {
  it('lists the Python imports of a file that resolve to no indexed file, as written', () => {
    const files = [indexed('app/main.py', 'python', ['.db', 'sqlalchemy.orm', 'os']), indexed('app/db.py', 'python', [])];
    expect(unresolvedImports(files, adapters).get('app/main.py')).toEqual(['sqlalchemy.orm', 'os']);
  });

  it('lists the TypeScript imports of a file that resolve to no indexed file, as written', () => {
    const files = [indexed('src/main.ts', 'typescript', ['./server', 'express', '@aws-sdk/client-s3']), indexed('src/server.ts', 'typescript', [])];
    expect(unresolvedImports(files, adapters).get('src/main.ts')).toEqual(['express', '@aws-sdk/client-s3']);
  });

  it('omits files whose imports all resolve', () => {
    const files = [indexed('src/main.ts', 'typescript', ['./server']), indexed('src/server.ts', 'typescript', [])];
    expect([...unresolvedImports(files, adapters).keys()]).toEqual([]);
  });

  it('lists a relative import of a file that is not indexed', () => {
    const files = [indexed('src/main.ts', 'typescript', ['./missing'])];
    expect(unresolvedImports(files, adapters).get('src/main.ts')).toEqual(['./missing']);
  });
});
