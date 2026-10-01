import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MapSnapshot } from '@ide/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { idecoreRoute } from '../src/idecore/mcp-server';
import type { SearchOutcome } from '../src/map/map-service';
import type { PlanService } from '../src/plans/plan-service';
import { startServer } from '../src/server/server';

const SECRET = 'agent-secret';

const file = (path: string, componentId: string, exported: string[], internal: string[] = []) => ({
  path, lang: 'ts', componentId, manualAssignment: false, parseError: false,
  symbols: [...exported.map((name) => ({ name, exported: true })), ...internal.map((name) => ({ name, exported: false }))],
});
const snapshot = {
  version: 1,
  projectName: 'p',
  components: [],
  files: [
    file('a.ts', 'app', ['run'], ['secretHelper']),
    file('b.ts', 'lib', ['s1', 's2', 's3', 's4', 's5', 's6', 's7']),
  ],
  fileEdges: [],
} as unknown as MapSnapshot;

type SearchFn = (query: string, limit: number) => Promise<SearchOutcome>;
const found = (hits: { path: string; similarity: number }[], indexed = 2, total = 2): SearchOutcome => ({ ok: true, hits, indexed, total });

async function connect(search?: SearchFn): Promise<Client> {
  const route = idecoreRoute({ secret: SECRET, plans: {} as PlanService, map: () => snapshot, search });
  const server = await startServer({ port: 0, token: 'ui-token', snapshot: () => null, routes: [route] });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
  }));
  onTestFinished(async () => {
    await client.close();
    await route.close();
    await server.close();
  });
  return client;
}

const text = (result: unknown) => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('');
const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'search_code', arguments: args });

describe('idecore search_code tool', () => {
  it('is absent when no search is given', async () => {
    const names = (await (await connect()).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('search_code');
  });

  it('is listed when a search is given', async () => {
    const names = (await (await connect(async () => found([]))).listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('search_code');
  });

  it('returns hits in the order given with path and component', async () => {
    const client = await connect(async () => found([{ path: 'b.ts', similarity: 0.9 }, { path: 'a.ts', similarity: 0.5 }]));
    const hits = JSON.parse(text(await call(client, { query: 'x' })));
    expect(hits.map((hit: { path: string; componentId: string }) => [hit.path, hit.componentId])).toEqual([['b.ts', 'lib'], ['a.ts', 'app']]);
  });

  it('rounds similarity to two decimals', async () => {
    const client = await connect(async () => found([{ path: 'a.ts', similarity: 0.87654 }, { path: 'b.ts', similarity: 0.5 }]));
    const hits = JSON.parse(text(await call(client, { query: 'x' })));
    expect(hits.map((hit: { similarity: number }) => hit.similarity)).toEqual([0.88, 0.5]);
  });

  it('lists exported symbols only', async () => {
    const client = await connect(async () => found([{ path: 'a.ts', similarity: 0.5 }]));
    const [hit] = JSON.parse(text(await call(client, { query: 'x' })));
    expect(hit.symbols).toEqual(['run']);
  });

  it('lists at most five symbols', async () => {
    const client = await connect(async () => found([{ path: 'b.ts', similarity: 0.5 }]));
    const [hit] = JSON.parse(text(await call(client, { query: 'x' })));
    expect(hit.symbols).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('gives a null component and no symbols for a path missing from the map', async () => {
    const client = await connect(async () => found([{ path: 'gone.ts', similarity: 0.5 }]));
    const [hit] = JSON.parse(text(await call(client, { query: 'x' })));
    expect([hit.componentId, hit.symbols]).toEqual([null, []]);
  });

  it('asks for 10 results when no limit is given', async () => {
    const limits: number[] = [];
    const client = await connect(async (_query, limit) => { limits.push(limit); return found([]); });
    await call(client, { query: 'x' });
    expect(limits).toEqual([10]);
  });

  it('passes the query and the given limit to the search', async () => {
    const calls: [string, number][] = [];
    const client = await connect(async (query, limit) => { calls.push([query, limit]); return found([]); });
    await call(client, { query: 'where is auth', limit: 3 });
    expect(calls).toEqual([['where is auth', 3]]);
  });

  it('accepts a limit of 30', async () => {
    const limits: number[] = [];
    const client = await connect(async (_query, limit) => { limits.push(limit); return found([]); });
    const outcome = await call(client, { query: 'x', limit: 30 });
    expect([outcome.isError, limits]).toEqual([undefined, [30]]);
  });

  it('rejects a limit of 31 without searching', async () => {
    const limits: number[] = [];
    const client = await connect(async (_query, limit) => { limits.push(limit); return found([]); });
    const outcome = await call(client, { query: 'x', limit: 31 }).catch(() => ({ isError: true }));
    expect([outcome.isError, limits]).toEqual([true, []]);
  });

  it('rejects a limit of 0 without searching', async () => {
    const limits: number[] = [];
    const client = await connect(async (_query, limit) => { limits.push(limit); return found([]); });
    const outcome = await call(client, { query: 'x', limit: 0 }).catch(() => ({ isError: true }));
    expect([outcome.isError, limits]).toEqual([true, []]);
  });

  it('returns a bare list when the index is complete', async () => {
    const client = await connect(async () => found([{ path: 'a.ts', similarity: 0.5 }], 2, 2));
    expect(Array.isArray(JSON.parse(text(await call(client, { query: 'x' }))))).toBe(true);
  });

  it('adds an index incomplete note with the counts when files are not indexed yet', async () => {
    const client = await connect(async () => found([{ path: 'a.ts', similarity: 0.5 }], 1, 2));
    const body = JSON.parse(text(await call(client, { query: 'x' })));
    expect([body.note, body.results.map((hit: { path: string }) => hit.path)]).toEqual(['index incomplete: 1/2', ['a.ts']]);
  });

  it('reports a search failure as an error with its message', async () => {
    const client = await connect(async () => ({ ok: false, error: 'The embedding model is unavailable: no model' }));
    const outcome = await call(client, { query: 'x' });
    expect([outcome.isError, text(outcome)]).toEqual([true, 'The embedding model is unavailable: no model']);
  });
});
