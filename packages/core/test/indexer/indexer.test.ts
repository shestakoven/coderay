import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Indexer, MAX_FILE_BYTES } from '../../src/indexer/indexer';
import { createPythonAdapter } from '../../src/lang/python';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import type { LanguageAdapter } from '../../src/lang/types';
import { fixture, tempDir, waitFor, writeTree } from '../helpers';

let adapters: LanguageAdapter[];
let indexer: Indexer | undefined;

beforeAll(async () => {
  adapters = [await createTypeScriptAdapter(fixture('ts-paths')), await createPythonAdapter()];
});

afterEach(async () => {
  await indexer?.stop();
  indexer = undefined;
});

async function startIndexer(files: Record<string, string>) {
  const root = tempDir('ide-indexer-');
  await writeTree(root, files);
  indexer = new Indexer({ root, adapters, debounceMs: 150 });
  const batches: string[][] = [];
  indexer.onChange((paths) => batches.push(paths));
  await indexer.start();
  const paths = () => indexer!.files().map((f) => f.path).sort();
  return { root, indexer, batches, paths };
}

describe('Indexer', () => {
  it('indexes supported sources and skips ignored, unsupported and oversized files', async () => {
    const { indexer, paths } = await startIndexer({
      'src/a.ts': "import { b } from './b';",
      'src/b.ts': 'export const b = 1;',
      'app/main.py': 'import os',
      'src/broken.ts': 'export function (',
      'README.md': '# readme',
      'node_modules/lib/index.js': 'module.exports = 1;',
      'generated/out.ts': 'export const x = 1;',
      '.gitignore': 'generated/\n',
      'dist-bundle.js': `const big = "${'x'.repeat(MAX_FILE_BYTES)}";`,
    });

    expect(paths()).toEqual(['app/main.py', 'src/a.ts', 'src/b.ts', 'src/broken.ts']);
    const byPath = new Map(indexer.files().map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')).toMatchObject({ lang: 'typescript', imports: ['./b'], parseError: false });
    expect(byPath.get('app/main.py')).toMatchObject({ lang: 'python', imports: ['os'] });
    expect(byPath.get('src/broken.ts')?.parseError).toBe(true);
  });

  it('re-indexes a changed file and reports it', async () => {
    const { root, indexer, batches } = await startIndexer({ 'src/a.ts': 'export const a = 1;' });

    await writeFile(join(root, 'src/a.ts'), "import { c } from './c';");

    await waitFor(() => batches.flat().includes('src/a.ts'));
    expect(indexer.files().find((f) => f.path === 'src/a.ts')?.imports).toEqual(['./c']);
  });

  it('does not report a save that leaves the content unchanged', async () => {
    const { root, batches } = await startIndexer({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' });

    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;');

    await waitFor(() => batches.flat().includes('src/b.ts'));
    expect(batches.flat()).not.toContain('src/a.ts');
  });

  it('removes deleted files and every file under a deleted directory', async () => {
    const { root, batches, paths } = await startIndexer({
      'src/keep.ts': 'export const k = 1;',
      'src/gone.ts': 'export const g = 1;',
      'src/feature/x.ts': 'export const x = 1;',
      'src/feature/deep/y.ts': 'export const y = 1;',
    });

    await rm(join(root, 'src/gone.ts'));
    await rm(join(root, 'src/feature'), { recursive: true });

    await waitFor(() => paths().length === 1);
    expect(paths()).toEqual(['src/keep.ts']);
    expect(batches.flat().sort()).toEqual(['src/feature/deep/y.ts', 'src/feature/x.ts', 'src/gone.ts']);
  });

  it('drops a file from the index when it grows beyond the size limit', async () => {
    const { root, paths } = await startIndexer({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' });

    await writeFile(join(root, 'src/a.ts'), `export const a = "${'x'.repeat(MAX_FILE_BYTES)}";`);

    await waitFor(() => !paths().includes('src/a.ts'));
    expect(paths()).toEqual(['src/b.ts']);
  });

  it('batches a burst of new files into a few change reports', async () => {
    const { root, batches, paths } = await startIndexer({ 'src/a.ts': 'export const a = 1;' });
    const burst = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`src/generated/f${i}.ts`, `export const f${i} = ${i};`]),
    );

    await writeTree(root, burst);

    await waitFor(() => paths().length === 51);
    await waitFor(() => new Set(batches.flat()).size === 50);
    expect(batches.length).toBeLessThanOrEqual(5);
  });
});
