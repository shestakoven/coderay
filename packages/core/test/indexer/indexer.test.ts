import { writeFileSync } from 'node:fs';
import { chmod, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Indexer, MAX_FILE_BYTES, type IndexerOptions } from '../../src/indexer/indexer';
import { createPythonAdapter } from '../../src/lang/python';
import { createTypeScriptAdapter } from '../../src/lang/typescript';
import type { LanguageAdapter } from '../../src/lang/types';
import { fixture, tempDir, waitFor, writeTree } from '../helpers';

const SOURCE = { 'src/a.ts': 'export const a = 1;' };

let adapters: LanguageAdapter[];
let indexer: Indexer | undefined;

beforeAll(async () => {
  adapters = [await createTypeScriptAdapter(fixture('ts-paths')), await createPythonAdapter()];
});

afterEach(async () => {
  await indexer?.stop();
  indexer = undefined;
});

async function startIndexer(files: Record<string, string>, options: Partial<IndexerOptions> = {}) {
  const root = tempDir('ide-indexer-');
  await writeTree(root, files);
  return startIndexerAt(root, adapters, options);
}

async function startIndexerAt(
  root: string,
  withAdapters: LanguageAdapter[] = adapters,
  options: Partial<IndexerOptions> = {},
) {
  indexer = new Indexer({ root, adapters: withAdapters, debounceMs: 150, ...options });
  const batches: string[][] = [];
  indexer.onChange((paths) => batches.push(paths));
  await indexer.start();
  const paths = () => indexer!.files().map((f) => f.path).sort();
  return { root, indexer, batches, paths };
}

async function awaitLiveWatcher({ root, batches }: { root: string; batches: string[][] }, dir: string): Promise<void> {
  const probe = dir ? `${dir}/live-probe.ts` : 'live-probe.ts';
  // macOS arms FSEvents after chokidar's 'ready', so one write can be lost; identical rewrites are reported once.
  const touch = () => writeFileSync(join(root, probe), '');
  touch();
  const toucher = setInterval(touch, 250);
  try {
    await waitFor(() => batches.flat().includes(probe), `${probe} reported`, 3000);
  } finally {
    clearInterval(toucher);
  }
  batches.length = 0;
}

describe('Indexer', () => {
  it('indexes TypeScript and Python sources with their imports', async () => {
    const { indexer } = await startIndexer({ 'src/a.ts': "import { b } from './b';", 'app/main.py': 'import os' });

    const byPath = new Map(indexer.files().map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')).toMatchObject({ lang: 'typescript', imports: ['./b'], parseError: false });
    expect(byPath.get('app/main.py')).toMatchObject({ lang: 'python', imports: ['os'], parseError: false });
  });

  it('skips files matched by .gitignore', async () => {
    const { paths } = await startIndexer({ ...SOURCE, '.gitignore': 'generated/\n', 'generated/out.ts': 'export const x = 1;' });

    expect(paths()).toEqual(['src/a.ts']);
  });

  it('skips node_modules', async () => {
    const { paths } = await startIndexer({ ...SOURCE, 'node_modules/lib/index.js': 'module.exports = 1;' });

    expect(paths()).toEqual(['src/a.ts']);
  });

  it('skips files no adapter handles', async () => {
    const { paths } = await startIndexer({ ...SOURCE, 'README.md': '# readme' });

    expect(paths()).toEqual(['src/a.ts']);
  });

  it('skips a supported file larger than MAX_FILE_BYTES', async () => {
    const { paths } = await startIndexer({ ...SOURCE, 'dist-bundle.js': `const big = "${'x'.repeat(MAX_FILE_BYTES)}";` });

    expect(paths()).toEqual(['src/a.ts']);
  });

  it('keeps a file with syntax errors on the map with parseError', async () => {
    const { indexer } = await startIndexer({ 'src/broken.ts': 'export function (' });

    expect(indexer.files()).toMatchObject([{ path: 'src/broken.ts', parseError: true }]);
  });

  it('re-indexes a changed file and reports it', async () => {
    const { root, indexer, batches } = await startIndexer({ 'src/a.ts': 'export const a = 1;' });

    await writeFile(join(root, 'src/a.ts'), "import { c } from './c';");

    await waitFor(() => batches.flat().includes('src/a.ts'), 'src/a.ts reported');
    expect(indexer.files().find((f) => f.path === 'src/a.ts')?.imports).toEqual(['./c']);
  });

  it('does not report a save that leaves the content unchanged', async () => {
    const { root, batches } = await startIndexer({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' });

    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;');

    await waitFor(() => batches.flat().includes('src/b.ts'), 'src/b.ts reported');
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

    await waitFor(() => new Set(batches.flat()).size === 3, 'three deletions reported');
    expect(batches.flat().sort()).toEqual(['src/feature/deep/y.ts', 'src/feature/x.ts', 'src/gone.ts']);
    expect(paths()).toEqual(['src/keep.ts']);
  });

  it('drops a file from the index when it grows beyond the size limit', async () => {
    const { root, paths } = await startIndexer({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' });

    await writeFile(join(root, 'src/a.ts'), `export const a = "${'x'.repeat(MAX_FILE_BYTES)}";`);

    await waitFor(() => !paths().includes('src/a.ts'), 'oversized src/a.ts dropped');
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

    await waitFor(() => paths().length === 52, 'burst indexed');
    await waitFor(() => new Set(batches.flat()).size === 50, 'burst reported');
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
      await waitFor(() => batches.flat().includes('src/a.ts'), 'src/a.ts reported');

      await writeFile(join(root, 'src/b.ts'), "import { d } from './d';");
      await waitFor(() => batches.flat().includes('src/b.ts'), 'src/b.ts reported');
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

    await waitFor(() => context.batches.flat().includes('after.ts'), 'after.ts reported');
    expect(context.paths()).toEqual(['after.ts', 'live-probe.ts', 'src/a.ts']);
  });

  it('reports files created immediately after start', async () => {
    const { root, batches, paths } = await startIndexer(SOURCE);
    const created = Array.from({ length: 20 }, (_, i) => `src/new${i}.ts`);

    for (const path of created) writeFileSync(join(root, path), 'export const n = 1;');

    await waitFor(() => created.every((p) => batches.flat().includes(p)), 'created files reported', 3000);
    expect(paths()).toEqual(['src/a.ts', ...created].sort());
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

    const editedImports = () => indexer.files().find((f) => f.path === editedPath)?.imports;
    await waitFor(() => editedImports()?.includes('./c'), 'edit during scan indexed');
  });

  it('reports an edit within the maximum wait while another source file is rewritten continuously', async () => {
    const { root, batches } = await startIndexer(
      { 'src/a.ts': 'export const a = 1;', 'src/hot.ts': 'export const n = 0;' },
      { reconcileDelayMs: 60_000 },
    );
    let n = 0;
    const writer = setInterval(() => writeFileSync(join(root, 'src/hot.ts'), `export const n = ${++n};`), 50);
    try {
      await writeFile(join(root, 'src/a.ts'), 'export const a = 2;');

      await waitFor(() => batches.flat().includes('src/a.ts'), 'src/a.ts reported during writes', 1500);
    } finally {
      clearInterval(writer);
    }
  });

  it('keeps only paths that exist with their exact name on disk after a case-only rename', async () => {
    const context = await startIndexer({ 'src/Foo.ts': 'export const foo = 1;' });
    await awaitLiveWatcher(context, 'src');

    await rename(join(context.root, 'src/Foo.ts'), join(context.root, 'src/foo.ts'));

    await waitFor(() => ['src/Foo.ts', 'src/foo.ts'].every((p) => context.batches.flat().includes(p)), 'both names reported');
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

    await waitFor(() => batches.flat().includes('src/a.ts'), 'src/a.ts reported');
    expect(paths()).toEqual(['src/a.ts']);
  });
});
