import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MapSnapshot } from '@ide/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { systemPrompt } from '../src/agent/system-prompt';
import { idecoreRoute } from '../src/idecore/mcp-server';
import type { PlanService } from '../src/plans/plan-service';
import { startServer } from '../src/server/server';

const SECRET = 'agent-secret';

const component = (id: string, files: string[]) => ({
  id, name: id.toUpperCase(), summary: `${id} summary`, description: `${id} description`, files, keyFiles: files.slice(0, 1), globs: [], source: 'ai', stale: false,
});
const file = (path: string, componentId: string, names: string[]) => ({
  path, lang: 'ts', componentId, manualAssignment: false, parseError: false,
  symbols: [...names.map((name) => ({ name, exported: true })), { name: 'hidden', exported: false }],
});
const snapshot = {
  version: 1,
  projectName: 'p',
  components: [component('app', ['a.ts']), component('lib', ['b.ts'])],
  files: [file('a.ts', 'app', ['run']), file('b.ts', 'lib', ['help'])],
  fileEdges: [{ from: 'a.ts', to: 'b.ts' }],
} as unknown as MapSnapshot;

async function connect(map?: () => MapSnapshot | null): Promise<Client> {
  const route = idecoreRoute({ secret: SECRET, plans: {} as PlanService, map });
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

describe('idecore map tools', () => {
  it('are absent when no map is given', async () => {
    const names = (await (await connect()).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('map_overview');
    expect(names).not.toContain('map_component');
  });

  it('lists components with their dependencies', async () => {
    const client = await connect(() => snapshot);
    const overview = JSON.parse(text(await client.callTool({ name: 'map_overview', arguments: {} })));
    expect(overview).toEqual([
      { id: 'app', name: 'APP', summary: 'app summary', files: 1, stale: false, dependsOn: ['lib'] },
      { id: 'lib', name: 'LIB', summary: 'lib summary', files: 1, stale: false, dependsOn: [] },
    ]);
  });

  it('returns one component with exported symbols only', async () => {
    const client = await connect(() => snapshot);
    const detail = JSON.parse(text(await client.callTool({ name: 'map_component', arguments: { id: 'lib' } })));
    expect(detail.files).toEqual([{ path: 'b.ts', symbols: ['help'] }]);
    expect(detail.description).toBe('lib description');
  });

  it('reports an unknown component and a map that is not ready', async () => {
    const unknown = await (await connect(() => snapshot)).callTool({ name: 'map_component', arguments: { id: 'nope' } });
    expect(unknown.isError).toBe(true);
    const notReady = await (await connect(() => null)).callTool({ name: 'map_overview', arguments: {} });
    expect(notReady.isError).toBe(true);
  });

  it('is announced in the system prompt only when enabled', () => {
    expect(systemPrompt([], true)).toContain('mcp__idecore__map_overview');
    expect(systemPrompt([])).not.toContain('map_overview');
  });
});
