import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isJSONRPCNotification, isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { type IdecoreRouteOptions, idecoreRoute, KEEP_ALIVE_MS } from '../../src/idecore/mcp-server';
import { reviewPlan } from '../../src/plans/freeze';
import type { ComponentRef } from '../../src/plans/plan-input';
import { PlanService } from '../../src/plans/plan-service';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer } from '../../src/server/server';
import { openStore } from '../../src/store/store';
import { sessionRecord, tempDir, waitFor, writeTree } from '../helpers';

const SECRET = 'agent-secret';
const components: ComponentRef[] = [{ id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] }];
const small = { goal: 'Fix app', steps: [{ key: 'edit', title: 'Edit', rationale: 'bug', targets: [{ path: 'src/app.ts', op: 'modify' }] }] };
const flow = {
  nodes: [{ id: 'app', title: 'App', sub: 'Module', kind: 'module', state: 'modify', steps: ['edit'], files: [{ op: '~', path: 'src/app.ts', note: 'fix' }] }],
  edges: [],
};
const big = { goal: 'Rework app', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ componentId: 'app', op: 'modify' }] }] };

async function setup(overrides: Partial<IdecoreRouteOptions> = {}) {
  const root = tempDir('ide-idecore-');
  await writeTree(root, { 'src/app.ts': '', 'src/other.ts': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const store = openStore(tempDir('ide-store-'));
  store.saveSession(sessionRecord('s1', root));
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy: DEFAULT_POLICY, components, tempRoots: [] }),
  });
  const route = idecoreRoute({ secret: SECRET, plans, ...overrides });
  const server = await startServer({ port: 0, token: 'ui-token', snapshot: () => null, routes: [route] });
  onTestFinished(async () => {
    await route.close();
    await server.close();
    store.close();
  });
  return { plans, port: server.port, route };
}

async function connect(port: number, secret = SECRET, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  }));
  onTestFinished(() => client.close());
  return client;
}

/** A client that records the messages it sends and every message it receives, notifications included. */
async function tap(port: number, path: string) {
  const client = await connect(port, SECRET, path);
  const transport = client.transport!;
  const sent: JSONRPCMessage[] = [];
  const heard: JSONRPCMessage[] = [];
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    heard.push(message);
    receive?.(message, extra);
  };
  return { client, sent, heard };
}

const text = (result: unknown) => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('');

function rawPost(port: number, headers: Record<string, string>, body: string | Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('idecore', () => {
  it('offers propose_plan and step', async () => {
    const client = await connect((await setup()).port);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['propose_plan', 'step']);
  });

  it('answers approved at once for a small plan', async () => {
    const client = await connect((await setup()).port);
    const result = await client.callTool({ name: 'propose_plan', arguments: small });
    expect([result.isError ?? false, JSON.parse(text(result))]).toEqual([false, { status: 'approved' }]);
  });

  it('accepts a flow with the plan and keeps it on the approved plan', async () => {
    const { plans, port } = await setup();
    const client = await connect(port);
    const result = await client.callTool({ name: 'propose_plan', arguments: { ...small, flow } });
    expect([result.isError ?? false, JSON.parse(text(result)), plans.plans().at(-1)?.flow]).toEqual([false, { status: 'approved' }, flow]);
  });

  it('returns a flow naming a step the plan does not have as a tool error and stores no plan', async () => {
    const { plans, port } = await setup();
    const client = await connect(port);
    const result = await client.callTool({ name: 'propose_plan', arguments: { ...small, flow: { ...flow, nodes: [{ ...flow.nodes[0]!, steps: ['nope'] }] } } });
    expect([result.isError, text(result)]).toEqual([true, expect.stringMatching(/^CodeRay: /)]);
    for (const mention of ['nope', 'edit']) expect(text(result)).toContain(mention);
    expect(plans.plans()).toEqual([]);
  });

  it('holds a bigger plan until the user approves it', async () => {
    const { plans, port } = await setup();
    const client = await connect(port);
    const call = client.callTool({ name: 'propose_plan', arguments: big });
    const plan = await waitFor(() => plans.plans().find((candidate) => candidate.status === 'proposed'), 'plan proposed');
    plans.answer(plan.id, plan.version, { kind: 'approve' });
    expect(JSON.parse(text(await call))).toEqual({ status: 'approved' });
  });

  it('returns a validation error as a tool error the agent can read', async () => {
    const client = await connect((await setup()).port);
    const result = await client.callTool({ name: 'propose_plan', arguments: { goal: 'g', steps: [{ key: 'k', title: 't', rationale: '', targets: [{ componentId: 'nope', op: 'modify' }] }] } });
    expect([result.isError, text(result)]).toEqual([true, 'CodeRay: step "k" names an unknown component "nope". Valid component ids: app (App).']);
  });

  it('returns input that does not fit the schema as a tool error', async () => {
    const client = await connect((await setup()).port);
    const result = await client.callTool({ name: 'propose_plan', arguments: { goal: 'g', steps: [{ key: 'k', title: 't', rationale: '', targets: [{ path: 'src/app.ts' }] }] } });
    expect(result.isError).toBe(true);
  });

  it('withdraws the waiting plan when the agent cancels the call', async () => {
    const { plans, port } = await setup();
    const client = await connect(port);
    const abort = new AbortController();
    const call = client.callTool({ name: 'propose_plan', arguments: big }, undefined, { signal: abort.signal }).catch(() => null);
    await waitFor(() => plans.plans().some((plan) => plan.status === 'proposed'), 'plan proposed');
    abort.abort();
    await call;
    await waitFor(() => plans.plans().at(-1)?.status === 'withdrawn', 'plan withdrawn');
    expect(plans.plans().at(-1)?.status).toBe('withdrawn');
  });

  it('starts and finishes steps through the step tool', async () => {
    const client = await connect((await setup()).port);
    await client.callTool({ name: 'propose_plan', arguments: small });
    const started = await client.callTool({ name: 'step', arguments: { key: 'edit', phase: 'start' } });
    const unknown = await client.callTool({ name: 'step', arguments: { key: 'nope', phase: 'start' } });
    const finished = await client.callTool({ name: 'step', arguments: { key: 'edit', phase: 'done' } });
    expect([JSON.parse(text(started)), unknown.isError, text(unknown), JSON.parse(text(finished))])
      .toEqual([{ ok: true }, true, expect.stringContaining('has no step "nope"'), { ok: true }]);
  });

  it('refuses a client without the agent secret', async () => {
    await expect(connect((await setup()).port, 'wrong')).rejects.toMatchObject({ code: 401 });
  });

  it('refuses a raw request with no Authorization header', async () => {
    const { port } = await setup();
    const result = await rawPost(port, {}, '{}');
    expect(result.status).toBe(401);
  });

  it('refuses a raw request whose secret is a prefix of the real one', async () => {
    const { port } = await setup();
    const result = await rawPost(port, { authorization: `Bearer ${SECRET.slice(0, -1)}` }, '{}');
    expect(result.status).toBe(401);
  });

  it('answers 413 for a request body over the 4 MiB limit', async () => {
    const { port } = await setup();
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 'x');
    const result = await rawPost(port, { authorization: `Bearer ${SECRET}` }, big);
    expect(result.status).toBe(413);
  });

  it('answers 400 for a request body that is not JSON', async () => {
    const { port } = await setup();
    const result = await rawPost(port, { authorization: `Bearer ${SECRET}` }, 'not json');
    expect(result.status).toBe(400);
  });

  it('answers 404 for an unknown mcp-session-id, so the client initializes again', async () => {
    const { port } = await setup();
    const result = await rawPost(port, { authorization: `Bearer ${SECRET}`, 'mcp-session-id': 'nope' }, '{}');
    expect(result.status).toBe(404);
  });
});

describe('idecore for Codex', () => {
  it('marks every tool read-only for a client that asks for the hints, and none for claude', async () => {
    const { port } = await setup();
    const annotated = async (path: string) => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } }));
      onTestFinished(() => client.close());
      return (await client.listTools()).tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint ?? null]);
    };
    expect([await annotated('/mcp?readOnlyHints=1'), await annotated('/mcp')]).toEqual([
      [['propose_plan', true], ['step', true]], [['propose_plan', null], ['step', null]],
    ]);
  });
});

describe('idecore for opencode', () => {
  it("sends progress every 20 s while propose_plan or search_code waits, under the call's token or else its request id, stops at the answer, and sends none without ?keepAlive=1", async () => {
    const holds: (() => void)[] = [];
    const held = <T>(value: T) => new Promise<T>((resolve) => holds.push(() => resolve(value)));
    const { port, route } = await setup({
      plans: { propose: () => held({ ok: true, value: { status: 'approved' } }) } as unknown as PlanService,
      search: () => held({ ok: true, hits: [], indexed: 0, total: 0 }),
    });
    const opencode = await tap(port, '/mcp?keepAlive=1');
    const claude = await tap(port, '/mcp');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => void vi.useRealTimers());
    const answers = Promise.all([
      opencode.client.callTool({ name: 'propose_plan', arguments: small, _meta: { progressToken: 'tok-1' } }),
      opencode.client.callTool({ name: 'search_code', arguments: { query: 'q' } }),
      claude.client.callTool({ name: 'propose_plan', arguments: small, _meta: { progressToken: 'tok-2' } }),
    ]);
    await waitFor(() => holds.length === 3, 'all three calls held');
    vi.advanceTimersByTime(3 * KEEP_ALIVE_MS);
    const tokens = (heard: JSONRPCMessage[]) => heard.filter(isJSONRPCNotification).filter((m) => m.method === 'notifications/progress').map((m) => m.params?.progressToken);
    await waitFor(() => tokens(opencode.heard).length >= 6, 'the frames of both opencode calls');
    for (const release of holds) release();
    const texts = (await answers).map(text);
    await route.close(); // clears the SDK's own SSE comment timers, so only a keep-alive left running is counted
    const searchId = opencode.sent.filter(isJSONRPCRequest).find((m) => m.params?.name === 'search_code')?.id;
    expect([tokens(opencode.heard).sort(), tokens(claude.heard), texts, vi.getTimerCount()]).toEqual([
      [searchId, searchId, searchId, 'tok-1', 'tok-1', 'tok-1'], [], ['{"status":"approved"}', '[]', '{"status":"approved"}'], 0,
    ]);
  });
});
