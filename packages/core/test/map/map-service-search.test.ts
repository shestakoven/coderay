import { afterEach, describe, expect, it } from 'vitest';
import type { EmbedModel, EmbedStatus } from '../../src/models/types';
import { MapService } from '../../src/map/map-service';
import { indexed, mapStatus, tempDir, writeTree } from '../helpers';
import { componentsPerDirectory, ScriptedModel } from '../models/fake-models';

const services: MapService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});

// Document text starts with the path; the query is the bare text.
class VectorEmbed implements EmbedModel {
  readonly id = 'vector-embed';
  constructor(private readonly byKey: Record<string, number[]>, private state: EmbedStatus = { state: 'ready' }) {}
  status(): EmbedStatus { return this.state; }
  onStatus(): () => void { return () => undefined; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    texts.forEach((text, i) => {
      const vector = this.byKey[text.split('\n')[0]!];
      if (vector) out[i] = new Float32Array(vector);
    });
    return out;
  }
}

async function start(vectors: Record<string, number[]>, state?: EmbedStatus) {
  const tree = { 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;', 'c.ts': 'export const c = 3;', 'd.ts': 'export const d = 4;' };
  const root = tempDir('ide-search-');
  await writeTree(root, tree);
  const service = new MapService({
    root, projectName: 'demo', stateDir: tempDir('ide-search-state-'),
    reasoning: new ScriptedModel(componentsPerDirectory), embed: new VectorEmbed(vectors, state),
    isAgentIdle: () => true, onChange: () => undefined, backgroundAi: () => mapStatus().backgroundAi, embeddingRule: null, mapPollMs: 20,
  });
  services.push(service);
  await service.start(Object.entries(tree).map(([path, content]) => indexed(path, 'typescript', [], { contentHash: content })), []);
  await service.idle();
  return service;
}

// Query (2,0). Raw dot order: a(20) > b(2) > c(0) > d(-2); cosine order: b > a > c > d.
const VECTORS = { query: [2, 0], 'a.ts': [10, 10], 'b.ts': [1, 0.1], 'c.ts': [0, 1], 'd.ts': [-1, 0] };

describe('MapService.search', () => {
  it('ranks files by cosine similarity, not by raw dot product', async () => {
    const outcome = await (await start(VECTORS)).search('query', 10);
    expect(outcome.ok && outcome.hits.map((hit) => hit.path)).toEqual(['b.ts', 'a.ts', 'c.ts', 'd.ts']);
  });

  it('reports cosine values as similarity', async () => {
    const outcome = await (await start(VECTORS)).search('query', 10);
    if (!outcome.ok) throw new Error('search failed');
    expect(outcome.hits.map((hit) => hit.similarity)).toEqual([
      expect.closeTo(0.995, 3), expect.closeTo(0.707, 3), expect.closeTo(0, 5), expect.closeTo(-1, 5),
    ]);
  });

  it('returns only the best files up to the limit', async () => {
    const outcome = await (await start(VECTORS)).search('query', 2);
    expect(outcome.ok && outcome.hits.map((hit) => hit.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('fails with the reason when the embedding model is unavailable', async () => {
    const outcome = await (await start(VECTORS, { state: 'unavailable', reason: 'no weights' })).search('query', 5);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('no weights') });
  });

  it('fails when the model returns no vector for the query', async () => {
    const outcome = await (await start(VECTORS)).search('unknown query', 5);
    expect(outcome.ok).toBe(false);
  });

  it('counts indexed files against all files and skips files without a vector', async () => {
    const outcome = await (await start({ query: [1, 0], 'a.ts': [1, 0], 'b.ts': [0, 1] })).search('query', 10);
    expect(outcome.ok && [outcome.indexed, outcome.total, outcome.hits.map((hit) => hit.path)]).toEqual([2, 4, ['a.ts', 'b.ts']]);
  });

  it('counts every file as indexed when all have vectors', async () => {
    const outcome = await (await start(VECTORS)).search('query', 1);
    expect(outcome.ok && [outcome.indexed, outcome.total]).toEqual([4, 4]);
  });
});
