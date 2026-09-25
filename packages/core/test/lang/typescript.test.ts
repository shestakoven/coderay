import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import type { LanguageAdapter } from '../../src/lang/types';
import { fixture, tempDir, writeTree } from '../helpers';

let adapter: LanguageAdapter;
const existing = (...paths: string[]) => (path: string) => paths.includes(path);

beforeAll(async () => {
  adapter = await createTypeScriptAdapter(fixture('ts-paths'));
});

describe('TypeScript adapter', () => {
  it('handles TypeScript and JavaScript sources only', () => {
    const sources = ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.ts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'];
    expect(sources.filter((p) => !adapter.handles(p))).toEqual([]);
    expect(['a.py', 'a.json', 'a.css', 'README.md'].filter((p) => adapter.handles(p))).toEqual([]);
  });

  it('extracts static, type-only, re-export, require and dynamic import specifiers once each', () => {
    const { imports } = adapter.parse('src/main.ts', [
      "import { a } from './a';",
      "import type { T } from './types';",
      "export * from './re';",
      "const b = require('./b');",
      "const c = await import('./c');",
      "import { again } from './a';",
    ].join('\n'));
    expect(imports).toEqual(['./a', './types', './re', './b', './c']);
  });

  it('lists top-level declarations with kind, line range and export flag', () => {
    const { symbols } = adapter.parse('src/x.ts', [
      'export function run() {}',
      'export class Server {}',
      'export interface Config {}',
      'export type Id = string;',
      'export enum Mode { A }',
      'export const PORT = 1, HOST = 2;',
      'function helper() {',
      '  return 1;',
      '}',
    ].join('\n'));
    expect(symbols).toEqual([
      { name: 'run', kind: 'function', startLine: 1, endLine: 1, exported: true },
      { name: 'Server', kind: 'class', startLine: 2, endLine: 2, exported: true },
      { name: 'Config', kind: 'interface', startLine: 3, endLine: 3, exported: true },
      { name: 'Id', kind: 'type', startLine: 4, endLine: 4, exported: true },
      { name: 'Mode', kind: 'enum', startLine: 5, endLine: 5, exported: true },
      { name: 'PORT', kind: 'variable', startLine: 6, endLine: 6, exported: true },
      { name: 'HOST', kind: 'variable', startLine: 6, endLine: 6, exported: true },
      { name: 'helper', kind: 'function', startLine: 7, endLine: 9, exported: false },
    ]);
  });

  it('parses JSX in .tsx files without syntax errors', () => {
    const parsed = adapter.parse('src/App.tsx', 'export const App = () => <div className="x">hi</div>;');
    expect(parsed.parseError).toBe(false);
    expect(parsed.symbols.map((s) => s.name)).toEqual(['App']);
  });

  it('parses JSX in .js files without syntax errors', () => {
    expect(adapter.parse('src/App.js', 'export const App = () => <div/>;').parseError).toBe(false);
  });

  it('flags syntax errors instead of throwing', () => {
    expect(adapter.parse('src/bad.ts', 'export function (').parseError).toBe(true);
  });

  it('resolves relative imports through extensions, index files and .js-to-.ts mapping', () => {
    const exists = existing('src/a.ts', 'src/b/index.tsx', 'src/c.ts', 'src/d.d.ts');
    expect(adapter.resolve('src/main.ts', './a', exists)).toBe('src/a.ts');
    expect(adapter.resolve('src/main.ts', './b', exists)).toBe('src/b/index.tsx');
    expect(adapter.resolve('src/main.ts', './c.js', exists)).toBe('src/c.ts');
    expect(adapter.resolve('src/main.ts', './d', exists)).toBe('src/d.d.ts');
  });

  it('resolves tsconfig path aliases', () => {
    expect(adapter.resolve('src/main.ts', '@/config', existing('src/config/index.ts'))).toBe('src/config/index.ts');
  });

  it('leaves package and out-of-project imports unresolved', () => {
    expect(adapter.resolve('src/main.ts', 'express', existing('express.ts'))).toBeNull();
    expect(adapter.resolve('src/main.ts', '../../outside', existing('../outside.ts'))).toBeNull();
  });

  it('ignores a tsconfig whose extends cannot be resolved and still resolves relative imports', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = tempDir('ide-tsconfig-');
      await writeTree(root, { 'tsconfig.json': JSON.stringify({ extends: './missing.json' }) });

      const withBrokenConfig = await createTypeScriptAdapter(root);

      expect(withBrokenConfig.resolve('src/main.ts', './a', existing('src/a.ts'))).toBe('src/a.ts');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('typescript: ignoring tsconfig paths:'));
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves aliases from the nearest tsconfig.json and the configs it references', async () => {
    const root = tempDir('ide-tsconfig-');
    await writeTree(root, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#root/*': ['shared/*'] } } }),
      'frontend/tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'frontend/tsconfig.app.json': '{\n  // comments are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }\n}\n',
      'admin/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['lib/*'] } } }),
    });

    const packages = await createTypeScriptAdapter(root);

    expect(packages.resolve('frontend/src/pages/home.tsx', '@/components/button', existing('frontend/src/components/button.tsx'))).toBe(
      'frontend/src/components/button.tsx',
    );
    expect(packages.resolve('admin/lib/app.ts', '@/util', existing('admin/lib/util.ts'))).toBe('admin/lib/util.ts');
    expect(packages.resolve('shared/a.ts', '#root/b', existing('shared/b.ts'))).toBe('shared/b.ts');
    expect(packages.resolve('frontend/src/a.ts', '#root/b', existing('shared/b.ts'))).toBeNull();
  });

  it('ignores a tsconfig.json above the project root', async () => {
    const parent = tempDir('ide-tsconfig-parent-');
    await writeTree(parent, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['project/src/*'] } } }),
      'project/src/x.ts': 'export const x = 1;',
    });

    const inner = await createTypeScriptAdapter(join(parent, 'project'));

    expect(inner.resolve('src/main.ts', '@/x', existing('src/x.ts'))).toBeNull();
  });

  it('skips a referenced tsconfig that cannot be read, warns once, and keeps the other configs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = tempDir('ide-tsconfig-');
      await writeTree(root, {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './missing' }, { path: './tsconfig.app.json' }] }),
        'tsconfig.app.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      });

      const withMissing = await createTypeScriptAdapter(root);

      expect(withMissing.resolve('src/main.ts', '@/a', existing('src/a.ts'))).toBe('src/a.ts');
      expect(withMissing.resolve('src/deep/main.ts', '@/a', existing('src/a.ts'))).toBe('src/a.ts');
      const warnings = warn.mock.calls.filter(([message]) => String(message).startsWith('typescript: ignoring tsconfig paths:'));
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
