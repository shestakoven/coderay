import { beforeAll, describe, expect, it } from 'vitest';
import { createPythonAdapter } from '../../src/lang/python';
import type { LanguageAdapter } from '../../src/lang/types';

let adapter: LanguageAdapter;
const existing = (...paths: string[]) => (path: string) => paths.includes(path);

beforeAll(async () => {
  adapter = await createPythonAdapter();
});

describe('Python adapter', () => {
  it('handles .py and .pyi files only', () => {
    expect(['a.py', 'a.pyi'].filter((p) => !adapter.handles(p))).toEqual([]);
    expect(['a.ts', 'a.pyc', 'a.txt'].filter((p) => adapter.handles(p))).toEqual([]);
  });

  it('extracts modules from import and from-import statements, with imported names as possible submodules', () => {
    const { imports } = adapter.parse('app/main.py', [
      'import os',
      'import a.b as c, d',
      'from . import x, y as z',
      'from ..pkg.mod import q',
      'from m import *',
    ].join('\n'));
    expect(imports).toEqual(['os', 'a.b', 'd', '.', '.x', '.y', '..pkg.mod', '..pkg.mod.q', 'm']);
  });

  it('lists top-level functions, classes, decorated definitions and assignments; underscore names are private', () => {
    const { symbols } = adapter.parse('app/models.py', [
      'import os',
      '',
      'def run():',
      '    pass',
      '',
      'class User:',
      '    pass',
      '',
      '@cache',
      'def cached():',
      '    pass',
      '',
      'async def go():',
      '    pass',
      '',
      '_private = 1',
      'LIMIT: int = 2',
    ].join('\n'));
    expect(symbols).toEqual([
      { name: 'run', kind: 'function', startLine: 3, endLine: 4, exported: true },
      { name: 'User', kind: 'class', startLine: 6, endLine: 7, exported: true },
      { name: 'cached', kind: 'function', startLine: 9, endLine: 11, exported: true },
      { name: 'go', kind: 'function', startLine: 13, endLine: 14, exported: true },
      { name: '_private', kind: 'variable', startLine: 16, endLine: 16, exported: false },
      { name: 'LIMIT', kind: 'variable', startLine: 17, endLine: 17, exported: true },
    ]);
  });

  it('flags syntax errors instead of throwing', () => {
    expect(adapter.parse('app/bad.py', 'def (').parseError).toBe(true);
  });

  it('resolves absolute imports from the project root and src/, and packages through __init__.py', () => {
    const exists = existing('app/db.py', 'app/models/__init__.py', 'src/lib/core.py');
    expect(adapter.resolve('x.py', 'app.db', exists)).toBe('app/db.py');
    expect(adapter.resolve('x.py', 'app.models', exists)).toBe('app/models/__init__.py');
    expect(adapter.resolve('x.py', 'lib.core', exists)).toBe('src/lib/core.py');
    expect(adapter.resolve('x.py', 'os', exists)).toBeNull();
  });

  it('resolves relative imports by package level', () => {
    const exists = existing('app/db.py', 'app/__init__.py', 'pkg/mod.py');
    expect(adapter.resolve('app/main.py', '.db', exists)).toBe('app/db.py');
    expect(adapter.resolve('app/main.py', '.', exists)).toBe('app/__init__.py');
    expect(adapter.resolve('app/main.py', '..pkg.mod', exists)).toBe('pkg/mod.py');
    expect(adapter.resolve('app/main.py', '.db.connect', exists)).toBeNull();
  });
});
