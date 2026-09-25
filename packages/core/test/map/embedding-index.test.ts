import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingIndex, embeddingText } from '../../src/map/embedding-index';
import { indexed, tempDir, waitFor, writeTree } from '../helpers';
import { FakeEmbedModel } from '../models/fake-models';

async function project(tree: Record<string, string>) {
  const root = tempDir('ide-embed-');
  await writeTree(root, tree);
  return { root, cacheFile: join(tempDir('ide-state-'), 'embeddings.json') };
}

const filesOf = (tree: Record<string, string>) =>
  Object.entries(tree).map(([path, content]) => indexed(path, 'typescript', [], { contentHash: content }));

const symbol = (name: string, exported: boolean) => ({ name, kind: 'function' as const, startLine: 1, endLine: 1, exported });

describe('embeddingText', () => {
  it('combines the path, the exported symbol names and the start of the source', () => {
    const file = indexed('src/a.ts', 'typescript', [], { symbols: [symbol('run', true), symbol('helper', false), symbol('PORT', true)] });
    expect(embeddingText(file, 'x'.repeat(2500))).toBe(`src/a.ts\nrun PORT\n${'x'.repeat(2000)}`);
  });
});

describe('EmbeddingIndex', () => {
  it('embeds each file once and reuses the vector while the file is unchanged', async () => {
    const tree = { 'src/a.ts': 'a', 'src/b.ts': 'b' };
    const { root, cacheFile } = await project(tree);
    const model = new FakeEmbedModel();
    const index = new EmbeddingIndex({ root, cacheFile, model });

    await index.update(filesOf(tree));
    await index.update(filesOf(tree));

    expect(model.calls.flat()).toHaveLength(2);
    expect(index.vector('src/a.ts')).toEqual(model.vectorFor('src/a.ts'));
  });

  it('embeds new files in batches of at most 16', async () => {
    const tree = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/f${i}.ts`, `f${i}`]));
    const { root, cacheFile } = await project(tree);
    const model = new FakeEmbedModel();

    await new EmbeddingIndex({ root, cacheFile, model }).update(filesOf(tree));

    expect(model.calls.map((batch) => batch.length)).toEqual([16, 4]);
  });

  it('re-embeds a file whose content changed', async () => {
    const { root, cacheFile } = await project({ 'src/a.ts': 'first' });
    const model = new FakeEmbedModel();
    const index = new EmbeddingIndex({ root, cacheFile, model });

    await index.update(filesOf({ 'src/a.ts': 'first' }));
    await writeTree(root, { 'src/a.ts': 'second' });
    await index.update(filesOf({ 'src/a.ts': 'second' }));

    expect(model.calls.map((batch) => batch.length)).toEqual([1, 1]);
    expect(model.calls[1]?.[0]).toContain('second');
  });

  it('restores flushed vectors from its cache file without calling the model again', async () => {
    const tree = { 'src/a.ts': 'a' };
    const { root, cacheFile } = await project(tree);
    const first = new FakeEmbedModel();
    const writer = new EmbeddingIndex({ root, cacheFile, model: first });
    await writer.update(filesOf(tree));
    await writer.flush();

    const second = new FakeEmbedModel();
    const restored = new EmbeddingIndex({ root, cacheFile, model: second });
    await restored.load();
    await restored.update(filesOf(tree));

    expect(second.calls).toEqual([]);
    expect(restored.vector('src/a.ts')).toEqual(first.vectorFor('src/a.ts'));
  });

  it('writes its cache file only after the save delay', async () => {
    const tree = { 'src/a.ts': 'a' };
    const { root, cacheFile } = await project(tree);
    const index = new EmbeddingIndex({ root, cacheFile, model: new FakeEmbedModel(), saveDelayMs: 50 });

    await index.update(filesOf(tree));
    expect(existsSync(cacheFile)).toBe(false);
    await waitFor(() => existsSync(cacheFile), 'cache saved after the delay');
  });

  it('waits for a save that is already running when it is flushed again', async () => {
    const tree = { 'src/a.ts': 'a' };
    const { root, cacheFile } = await project(tree);
    const index = new EmbeddingIndex({ root, cacheFile, model: new FakeEmbedModel() });
    await index.update(filesOf(tree));

    void index.flush();
    await index.flush();

    expect(existsSync(cacheFile)).toBe(true);
  });

  it('ignores a cache written for another embedding model', async () => {
    const tree = { 'src/a.ts': 'a' };
    const { root, cacheFile } = await project(tree);
    const writer = new EmbeddingIndex({ root, cacheFile, model: new FakeEmbedModel() });
    await writer.update(filesOf(tree));
    await writer.flush();

    const other = new FakeEmbedModel({ id: 'other-model' });
    const index = new EmbeddingIndex({ root, cacheFile, model: other });
    await index.load();
    await index.update(filesOf(tree));

    expect(other.calls.flat()).toHaveLength(1);
  });

  it('starts empty instead of failing when a cached vector is truncated', async () => {
    const { root, cacheFile } = await project({ 'src/a.ts': 'a' });
    await writeFile(cacheFile, JSON.stringify({ model: 'fake-embed', entries: { key: 'AAAAAAA=' } }));
    const model = new FakeEmbedModel();
    const index = new EmbeddingIndex({ root, cacheFile, model });

    await index.load();
    await index.update(filesOf({ 'src/a.ts': 'a' }));

    expect(index.vector('src/a.ts')).toEqual(model.vectorFor('src/a.ts'));
  });

  it('keeps its vectors when the cache file cannot be written', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const tree = { 'src/a.ts': 'a' };
      const { root } = await project(tree);
      const blocker = join(tempDir('ide-state-'), 'not-a-directory');
      await writeFile(blocker, '');
      const model = new FakeEmbedModel();
      const index = new EmbeddingIndex({ root, cacheFile: join(blocker, 'embeddings.json'), model });

      await index.update(filesOf(tree));
      await index.flush();

      expect(index.vector('src/a.ts')).toEqual(model.vectorFor('src/a.ts'));
      expect(consoleError).toHaveBeenCalledWith('map: cannot save the embedding cache', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('stops waiting for the model when the update is cancelled', async () => {
    const tree = { 'src/a.ts': 'a' };
    const { root, cacheFile } = await project(tree);
    const model = new FakeEmbedModel();
    model.hold();
    const controller = new AbortController();

    const update = new EmbeddingIndex({ root, cacheFile, model }).update(filesOf(tree), controller.signal);
    await waitFor(() => model.calls.length === 1, 'the model was asked');
    controller.abort();

    await expect(update).rejects.toThrow('embedding cancelled');
  });

  it('forgets the vector of a deleted file', async () => {
    const { root, cacheFile } = await project({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    const index = new EmbeddingIndex({ root, cacheFile, model: new FakeEmbedModel() });

    await index.update(filesOf({ 'src/a.ts': 'a', 'src/b.ts': 'b' }));
    await index.update(filesOf({ 'src/a.ts': 'a' }));

    expect(index.vector('src/b.ts')).toBeUndefined();
  });
});
