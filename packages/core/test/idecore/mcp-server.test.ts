import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, onTestFinished } from 'vitest';
import { idecoreRoute } from '../../src/idecore/mcp-server';
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
const big = { goal: 'Rework app', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ componentId: 'app', op: 'modify' }] }] };

async function setup() {
  const root = tempDir('ide-idecore-');
  await writeTree(root, { 'src/app.ts': '', 'src/other.ts': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const store = openStore(tempDir('ide-store-'));
  store.saveSession(sessionRecord('s1', root));
  const plans = new PlanService({
    root, store, sessionId: () => 's1', components: () => components,
    review: (steps) => reviewPlan(steps, { root, policy: DEFAULT_POLICY, components, tempRoots: [] }),
  });
  const route = idecoreRoute({ secret: SECRET, plans });
  const server = await startServer({ port: 0, token: 'ui-token', snapshot: () => null, routes: [route] });
  onTestFinished(async () => {
    await route.close();
    await server.close();
    store.close();
  });
  return { plans, port: server.port };
}

async function connect(port: number, secret = SECRET): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  }));
  onTestFinished(() => client.close());
  return client;
}

const text = (result: unknown) => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('');

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
    expect([result.isError, text(result)]).toEqual([true, 'IDE: step "k" names an unknown component "nope". Valid component ids: app (App).']);
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
    expect([JSON.parse(text(started)), unknown.isError, text(unknown)]).toEqual([{ ok: true }, true, expect.stringContaining('has no step "nope"')]);
  });

  it('refuses a client without the agent secret', async () => {
    await expect(connect((await setup()).port, 'wrong')).rejects.toThrow();
  });
});
