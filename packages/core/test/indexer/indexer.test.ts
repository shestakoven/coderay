import { writeFileSync } from 'node:fs';
import { chmod, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
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
  return startIndexerAt(root);
}

async function startIndexerAt(root: string, withAdapters: LanguageAdapter[] = adapters) {
  indexer = new Indexer({ root, adapters: withAdapters, debounceMs: 150 });
  const batches: string[][] = [];
  indexer.onChange((paths) => batches.push(paths));
  await indexer.start();
  const paths = () => indexer!.files().map((f) => f.path).sort();
  return { root, indexer, batches, paths };
}

async function awaitLiveWatcher({ root, batches }: { root: string; batches: string[][] }, dir: string): Promise<void> {
  const probe = dir ? `${dir}/live-probe.ts` : 'live-probe.ts';
  await writeFile(join(root, probe), '');
  await waitFor(() => batches.flat().includes(probe));
  batches.length = 0;
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
    const context = await startIndexer({ 'src/a.ts': 'export const a = 1;' });
    const { root, batches, paths } = context;
    await awaitLiveWatcher(context, 'src');
    const burst = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`src/generated/f${i}.ts`, `export const f${i} = ${i};`]),
    );

    await writeTree(root, burst);

    await waitFor(() => paths().length === 52);
    await waitFor(() => new Set(batches.flat()).size === 50);
    expect(batches.length).toBeLessThanOrEqual(5);
  });

  it('keeps indexing and notifying after a change listener throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { root, indexer, batches } = await startIndexer({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 1;',
      });
      let calls = 0;
      indexer.onChange(() => {
        calls += 1;
        if (calls === 1) throw new Error('listener boom');
      });

      await writeFile(join(root, 'src/a.ts'), "import { c } from './c';");
      await waitFor(() => batches.flat().includes('src/a.ts'));

      await writeFile(join(root, 'src/b.ts'), "import { d } from './d';");
      await waitFor(() => batches.flat().includes('src/b.ts'));
      expect(indexer.files().find((f) => f.path === 'src/b.ts')?.imports).toEqual(['./d']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('never indexes files behind a directory symlink created after start', async () => {
    const outside = tempDir('ide-outside-');
    await writeTree(outside, { 'secret.ts': 'export const s = 1;' });
    const context = await startIndexer({ 'src/a.ts': 'export const a = 1;' });
    await awaitLiveWatcher(context, '');

    await symlink(outside, join(context.root, 'linked'));
    await writeFile(join(context.root, 'after.ts'), '');

    await waitFor(() => context.batches.flat().includes('after.ts'));
    expect(context.paths()).toEqual(['after.ts', 'live-probe.ts', 'src/a.ts']);
  });

  it('picks up an edit made to an already scanned file while the initial scan runs', async () => {
    const root = tempDir('ide-indexer-');
    await writeTree(root, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};`])));
    const typescript = adapters[0]!;
    let editedPath: string | undefined;
    const editingFirstScannedFile: LanguageAdapter = {
      ...typescript,
      parse(path, source) {
        if (!editedPath) {
          editedPath = path;
          writeFileSync(join(root, path), "import { c } from './c';");
        }
        return typescript.parse(path, source);
      },
    };

    const { indexer } = await startIndexerAt(root, [editingFirstScannedFile]);

    await waitFor(() => indexer.files().find((f) => f.path === editedPath)?.imports.includes('./c'));
  });

  it('reports an edit within the maximum wait while another source file is rewritten continuously', async () => {
    const { root, batches } = await startIndexer({ 'src/a.ts': 'export const a = 1;', 'src/hot.ts': 'export const n = 0;' });
    let n = 0;
    const writer = setInterval(() => writeFileSync(join(root, 'src/hot.ts'), `export const n = ${++n};`), 50);
    try {
      await writeFile(join(root, 'src/a.ts'), 'export const a = 2;');

      await waitFor(() => batches.flat().includes('src/a.ts'), 1500);
    } finally {
      clearInterval(writer);
    }
  });

  it('keeps only paths that exist with their exact name on disk after a case-only rename', async () => {
    const context = await startIndexer({ 'src/Foo.ts': 'export const foo = 1;' });
    await awaitLiveWatcher(context, 'src');

    await rename(join(context.root, 'src/Foo.ts'), join(context.root, 'src/foo.ts'));

    await waitFor(() => ['src/Foo.ts', 'src/foo.ts'].every((p) => context.batches.flat().includes(p)));
    for (const path of context.paths()) {
      expect(await readdir(join(context.root, dirname(path)))).toContain(basename(path));
    }
  });

  it('keeps indexing when a directory is unreadable', async () => {
    const root = tempDir('ide-indexer-');
    await writeTree(root, { 'src/a.ts': 'export const a = 1;', 'locked/b.ts': 'export const b = 1;' });
    await chmod(join(root, 'locked'), 0o000);
    onTestFinished(() => chmod(join(root, 'locked'), 0o755));

    const { batches, paths } = await startIndexerAt(root);
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;');

    await waitFor(() => batches.flat().includes('src/a.ts'));
    expect(paths()).toEqual(['src/a.ts']);
  });
});
