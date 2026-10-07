import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BGE_SMALL, defaultWorkerUrl, LocalEmbedModel, READY_TIMEOUT_MS } from '../../src/models/local-embed';
import type { EmbedStatus } from '../../src/models/types';
import { tempDir, waitFor, writeTree } from '../helpers';

const models: LocalEmbedModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
});

function start(fixture: string, cacheDir = tempDir('ide-models-'), closeWaitMs?: number): LocalEmbedModel {
  const model = new LocalEmbedModel({ cacheDir, workerUrl: new URL(`../fixtures/${fixture}.mjs`, import.meta.url), closeWaitMs });
  models.push(model);
  return model;
}

const rounded = (vectors: Float32Array[]) => vectors.map((vector) => Array.from(vector, (value) => Number(value.toFixed(3))));

describe('LocalEmbedModel', () => {
  it('announces the download and its size when the model is not cached', () => {
    expect(start('fake-embed-worker').status()).toEqual({ state: 'downloading', bytes: BGE_SMALL.downloadBytes });
  });

  it('starts in the loading state when the model is cached', async () => {
    const cacheDir = tempDir('ide-models-');
    await writeTree(cacheDir, { [`${BGE_SMALL.id}/${BGE_SMALL.weightsFile}`]: '' });
    expect(start('fake-embed-worker', cacheDir).status()).toEqual({ state: 'loading' });
  });

  it('returns one vector per text once the worker is ready', async () => {
    const model = start('fake-embed-worker');
    expect(rounded(await model.embed(['abc', 'abcdef']))).toEqual([
      [0.949, 0.316],
      [0.986, 0.164],
    ]);
  });

  it('tells listeners when the model becomes ready', async () => {
    const model = start('fake-embed-worker');
    const states: EmbedStatus['state'][] = [];
    model.onStatus((status) => states.push(status.state));
    await model.embed(['a']);
    expect(states).toEqual(['ready']);
  });

  it('becomes unavailable with the reason when the model cannot load', async () => {
    const model = start('failing-embed-worker');
    await expect(model.embed(['x'])).rejects.toThrow('network unavailable');
    expect(model.status()).toEqual({ state: 'unavailable', reason: 'network unavailable' });
  });

  it('rejects waiting and later requests when the worker dies', async () => {
    const model = start('fake-embed-worker');
    await expect(model.embed(['crash'])).rejects.toThrow('exited with code 3');
    await expect(model.embed(['abc'])).rejects.toThrow('exited with code 3');
  });

  it('rejects embed calls after it is closed', async () => {
    const model = start('fake-embed-worker');
    await model.embed(['a']);
    await model.close();
    await expect(model.embed(['abc'])).rejects.toThrow('embedding model closed');
  });

  it('rejects a pending embed when it is closed', async () => {
    const model = start('stalled-embed-worker', tempDir('ide-models-'), 50);
    await waitFor(() => model.status().state === 'ready', 'model ready');
    const pending = model.embed(['abc']);
    const rejection = expect(pending).rejects.toThrow('embedding model closed');
    await Promise.resolve(); // one microtask lets embed() post its request
    await model.close();
    await rejection;
  });

  it('keeps its status and stays quiet for listeners when it is closed', async () => {
    const model = start('fake-embed-worker');
    await model.embed(['a']);
    const states: EmbedStatus['state'][] = [];
    model.onStatus((status) => states.push(status.state));
    await model.close();
    expect([model.status().state, states]).toEqual(['ready', []]);
  });

  it('gives up when the model is not ready within ten minutes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const model = start('silent-embed-worker');
      vi.advanceTimersByTime(READY_TIMEOUT_MS);
      expect(model.status()).toEqual({ state: 'unavailable', reason: 'timed out loading the embedding model' });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('close', () => {
    const markers = (cacheDir: string, prefix: string) => readdirSync(cacheDir).filter((name) => name.startsWith(prefix));

    async function runningBatch(delayMs: number, closeWaitMs: number) {
      const cacheDir = tempDir('ide-models-');
      const model = start('slow-embed-worker', cacheDir, closeWaitMs);
      await waitFor(() => model.status().state === 'ready', 'model ready');
      model.embed([String(delayMs)]).catch(() => undefined);
      await waitFor(() => markers(cacheDir, 'started-').length > 0, 'batch started in the worker');
      return { model, cacheDir };
    }

    it('lets a batch the worker is running finish before terminating it', async () => {
      const { model, cacheDir } = await runningBatch(300, 5000);
      await model.close();
      expect(markers(cacheDir, 'finished-')).toHaveLength(1);
    });

    it('terminates the worker once closeWaitMs has passed with a batch still running', async () => {
      const { model, cacheDir } = await runningBatch(600, 150);
      await model.close();
      // A worker left running would finish its batch well within this pause.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(markers(cacheDir, 'finished-')).toEqual([]);
    });

    it('waits no longer than closeWaitMs for a running batch', async () => {
      const { model, cacheDir } = await runningBatch(10_000, 200);
      await model.close();
      expect(markers(cacheDir, 'finished-')).toEqual([]);
    });

    it('closes without waiting when no batch is running', async () => {
      const model = start('slow-embed-worker', tempDir('ide-models-'), 600_000);
      await waitFor(() => model.status().state === 'ready', 'model ready');
      await model.close();
      expect(model.status().state).toBe('ready');
    });
  });
});

describe('defaultWorkerUrl', () => {
  it('is the TypeScript worker beside a source module and the JavaScript worker beside a bundled one', () => {
    expect(defaultWorkerUrl('file:///repo/packages/core/src/models/local-embed.ts').href).toBe('file:///repo/packages/core/src/models/embed-worker.ts');
    expect(defaultWorkerUrl('file:///Applications/IDE.app/Resources/core/main.mjs').href).toBe('file:///Applications/IDE.app/Resources/core/embed-worker.mjs');
  });
});
