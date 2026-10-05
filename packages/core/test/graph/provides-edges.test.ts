import { beforeAll, describe, expect, it } from 'vitest';
import type { FileEdge, Lang } from '@ide/protocol';
import { computeFileEdges, unresolvedImports } from '../../src/graph/edges';
import type { LanguageAdapter } from '../../src/lang/types';
import { indexed } from '../helpers';

const pairs = (edges: FileEdge[]) => edges.map((e) => `${e.from} -> ${e.to}`).sort();

const byName = (lang: Lang): LanguageAdapter => ({
  lang,
  handles: () => true,
  parse: () => ({ imports: [], symbols: [], parseError: false }),
  resolve: () => null,
  resolveAll: (specifier, providers) => providers(specifier),
});

const byPath: LanguageAdapter = {
  lang: 'typescript',
  handles: () => true,
  parse: () => ({ imports: [], symbols: [], parseError: false }),
  resolve: (_from, specifier, exists) => [`${specifier}.ts`].find(exists) ?? null,
};

describe('computeFileEdges with a name-based adapter', () => {
  const adapters = [byName('csharp')];

  it('links an import to every file that provides the imported name and to no other file', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop.Models']),
      indexed('user.cs', 'csharp', [], { provides: ['Shop.Models'] }),
      indexed('order.cs', 'csharp', [], { provides: ['Shop.Models'] }),
      indexed('other.cs', 'csharp', [], { provides: ['Shop.Other'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['main.cs -> order.cs', 'main.cs -> user.cs']);
  });

  it('marks the edges as imports', () => {
    const files = [indexed('main.cs', 'csharp', ['Shop']), indexed('user.cs', 'csharp', [], { provides: ['Shop'] })];
    expect(computeFileEdges(files, adapters)).toEqual([{ from: 'main.cs', to: 'user.cs', kind: 'import' }]);
  });

  it('adds no self-edge when a file provides the name it imports', () => {
    const files = [
      indexed('a.cs', 'csharp', ['Shop'], { provides: ['Shop'] }),
      indexed('b.cs', 'csharp', [], { provides: ['Shop'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['a.cs -> b.cs']);
  });

  it('adds no edge at all when the only provider of the imported name is the importer', () => {
    const files = [indexed('a.cs', 'csharp', ['Shop'], { provides: ['Shop'] })];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });

  it('gives one edge when several imports of a file resolve to the same provider', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop.A', 'Shop.B']),
      indexed('lib.cs', 'csharp', [], { provides: ['Shop.A', 'Shop.B'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['main.cs -> lib.cs']);
  });

  it('links each importer to a file that provides several names', () => {
    const files = [
      indexed('a.cs', 'csharp', ['X']),
      indexed('b.cs', 'csharp', ['Y']),
      indexed('lib.cs', 'csharp', [], { provides: ['X', 'Y'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['a.cs -> lib.cs', 'b.cs -> lib.cs']);
  });

  it('does not link a name that no indexed file provides', () => {
    const files = [indexed('main.cs', 'csharp', ['System']), indexed('user.cs', 'csharp', [], { provides: ['Shop'] })];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });

  it('copes with files that have no provides or an empty one', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop']),
      indexed('plain.cs', 'csharp', []),
      indexed('empty.cs', 'csharp', [], { provides: [] }),
      indexed('user.cs', 'csharp', [], { provides: ['Shop'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['main.cs -> user.cs']);
  });

  it('uses the paths the adapter returns for an import', () => {
    const fixed: LanguageAdapter = { ...byName('csharp'), resolveAll: () => ['x.cs', 'y.cs'] };
    const files = [indexed('main.cs', 'csharp', ['Anything']), indexed('x.cs', 'csharp', []), indexed('y.cs', 'csharp', [])];
    expect(pairs(computeFileEdges(files, [fixed]))).toEqual(['main.cs -> x.cs', 'main.cs -> y.cs']);
  });
});

describe('computeFileEdges across languages that resolve by name', () => {
  const adapters = [byName('csharp'), byName('swift')];

  it('does not link a csharp import to a swift file providing the same name', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop.Models']),
      indexed('models.swift', 'swift', [], { provides: ['Shop.Models'] }),
    ];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });

  it('does not link a swift import to a csharp file providing the same name', () => {
    const files = [
      indexed('main.swift', 'swift', ['Shop.Models']),
      indexed('models.cs', 'csharp', [], { provides: ['Shop.Models'] }),
    ];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });

  it('links each language only to providers of its own language when both provide the name', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop']),
      indexed('main.swift', 'swift', ['Shop']),
      indexed('shop.cs', 'csharp', [], { provides: ['Shop'] }),
      indexed('shop.swift', 'swift', [], { provides: ['Shop'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['main.cs -> shop.cs', 'main.swift -> shop.swift']);
  });
});

describe('unresolvedImports with a name-based adapter', () => {
  const adapters = [byName('csharp'), byName('swift')];

  it('lists, as written and in order, only the specifiers that no file provides', () => {
    const files = [
      indexed('main.cs', 'csharp', ['System', 'Shop.Models', 'Missing.Ns', 'System.Linq']),
      indexed('user.cs', 'csharp', [], { provides: ['Shop.Models'] }),
    ];
    expect(unresolvedImports(files, adapters).get('main.cs')).toEqual(['System', 'Missing.Ns', 'System.Linq']);
  });

  it('omits a file whose imports all resolve', () => {
    const files = [indexed('main.cs', 'csharp', ['Shop']), indexed('user.cs', 'csharp', [], { provides: ['Shop'] })];
    expect([...unresolvedImports(files, adapters).keys()]).toEqual([]);
  });

  it('lists an import that is provided only by a file of another language', () => {
    const files = [
      indexed('main.cs', 'csharp', ['Shop.Models']),
      indexed('models.swift', 'swift', [], { provides: ['Shop.Models'] }),
    ];
    expect(unresolvedImports(files, adapters).get('main.cs')).toEqual(['Shop.Models']);
  });

  it('does not list an import provided by the importing file itself', () => {
    const files = [indexed('a.cs', 'csharp', ['Shop'], { provides: ['Shop'] })];
    expect(unresolvedImports(files, adapters).has('a.cs')).toBe(false);
  });

  it('lists every import of a file when no file provides anything', () => {
    const files = [indexed('main.cs', 'csharp', ['A', 'B']), indexed('plain.cs', 'csharp', [])];
    expect([...unresolvedImports(files, adapters).entries()]).toEqual([['main.cs', ['A', 'B']]]);
  });
});

describe('path-based adapters next to name-based ones', () => {
  const adapters = [byPath, byName('csharp')];

  it('still turn resolvable imports into edges and ignore the rest', () => {
    const files = [indexed('a.ts', 'typescript', ['b', 'missing']), indexed('b.ts', 'typescript', [])];
    expect(computeFileEdges(files, adapters)).toEqual([{ from: 'a.ts', to: 'b.ts', kind: 'import' }]);
  });

  it('still list the imports that resolve to no file', () => {
    const files = [indexed('a.ts', 'typescript', ['b', 'missing']), indexed('b.ts', 'typescript', [])];
    expect(unresolvedImports(files, adapters).get('a.ts')).toEqual(['missing']);
  });

  it('do not use the provides of a file to resolve an import', () => {
    const files = [
      indexed('a.ts', 'typescript', ['lib']),
      indexed('util.ts', 'typescript', [], { provides: ['lib'] }),
    ];
    expect(computeFileEdges(files, adapters)).toEqual([]);
    expect(unresolvedImports(files, adapters).get('a.ts')).toEqual(['lib']);
  });

  it('do not resolve an import to a provider in another language', () => {
    const files = [
      indexed('a.ts', 'typescript', ['Shop.Models']),
      indexed('models.cs', 'csharp', [], { provides: ['Shop.Models'] }),
    ];
    expect(computeFileEdges(files, adapters)).toEqual([]);
  });

  it('work in the same graph as name-based files', () => {
    const files = [
      indexed('a.ts', 'typescript', ['b']),
      indexed('b.ts', 'typescript', []),
      indexed('main.cs', 'csharp', ['Shop']),
      indexed('shop.cs', 'csharp', [], { provides: ['Shop'] }),
    ];
    expect(pairs(computeFileEdges(files, adapters))).toEqual(['a.ts -> b.ts', 'main.cs -> shop.cs']);
  });
});

describe('with the C# adapter', () => {
  let adapters: LanguageAdapter[];
  let csharp: LanguageAdapter;
  const cs = (path: string, source: string) => {
    const parsed = csharp.parse(path, source);
    return indexed(path, 'csharp', parsed.imports, { provides: parsed.provides, symbols: parsed.symbols });
  };
  const solution = () => [
    cs('App/Program.cs', 'using System;\nusing Shop.Models;\n\nclass Program { }'),
    cs('Models/User.cs', 'namespace Shop.Models;\n\npublic class User { }'),
    cs('Models/Order.cs', 'namespace Shop.Models\n{\n    public class Order { }\n}'),
    cs('Services/Billing.cs', 'namespace Shop.Services;\n\nclass Billing { }'),
    cs('Legacy/Util.cs', 'class Util { }'),
  ];

  beforeAll(async () => {
    const { createCSharpAdapter } = await import('../../src/lang/csharp');
    csharp = await createCSharpAdapter();
    adapters = [csharp];
  });

  it('links a using to every file that declares the namespace and to no other file', () => {
    expect(pairs(computeFileEdges(solution(), adapters))).toEqual([
      'App/Program.cs -> Models/Order.cs',
      'App/Program.cs -> Models/User.cs',
    ]);
  });

  it('leaves a framework using unresolved and lists nothing for the resolved one', () => {
    expect([...unresolvedImports(solution(), adapters).entries()]).toEqual([['App/Program.cs', ['System']]]);
  });

  it('links an alias of a type to the files of its namespace', () => {
    const files = [...solution(), cs('Web/Api.cs', 'using Dto = Shop.Models.User;\nclass Api { }')];
    expect(pairs(computeFileEdges(files, adapters)).filter((p) => p.startsWith('Web/'))).toEqual([
      'Web/Api.cs -> Models/Order.cs',
      'Web/Api.cs -> Models/User.cs',
    ]);
  });
});
