import { afterEach, describe, expect, it, vi } from 'vitest';
import { BGE_SMALL, LocalEmbedModel, READY_TIMEOUT_MS } from '../../src/models/local-embed';
import type { EmbedStatus } from '../../src/models/types';
import { tempDir, writeTree } from '../helpers';

const models: LocalEmbedModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
});

function start(fixture: string, cacheDir = tempDir('ide-models-')): LocalEmbedModel {
  const model = new LocalEmbedModel({ cacheDir, workerUrl: new URL(`../fixtures/${fixture}.mjs`, import.meta.url) });
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
});
