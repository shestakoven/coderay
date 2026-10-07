import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { HookAnswer, HookGate } from '../../src/gate/hook-gate';
import { hookRoute } from '../../src/gate/hook-route';
import { startServer } from '../../src/server/server';

const DENY: HookAnswer = { permissionDecision: 'deny', permissionDecisionReason: 'CodeRay: no' };

async function served(observe?: (body: unknown) => void) {
  const order: string[] = [];
  const gate = {
    evaluate: async () => {
      order.push('gate');
      return DENY;
    },
  } as unknown as HookGate;
  const route = hookRoute({
    secret: 's3cret',
    gate,
    ...(observe ? { observe: (body: unknown) => {
      order.push('observer');
      observe(body);
    } } : {}),
  });
  const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [route] });
  onTestFinished(() => server.close());
  const post = (body: object, authorization = 'Bearer s3cret') =>
    fetch(`http://127.0.0.1:${server.port}/hook`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { order, post };
}

const CALL = { hook_event_name: 'PreToolUse', session_id: 'claude-1', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 'toolu_1' };

describe('hookRoute reporting a call to the session', () => {
  it('hands the call to the observer before the gate judges it', async () => {
    const seen: unknown[] = [];
    const { order, post } = await served((body) => seen.push(body));
    await post(CALL);
    expect([seen, order]).toEqual([[CALL], ['observer', 'gate']]);
  });

  it('still answers with the decision of the gate when the observer fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const { order, post } = await served(() => {
      throw new Error('boom');
    });
    const res = await post(CALL);
    expect([res.status, await res.json(), order, errors.mock.calls.length]).toEqual([200, DENY, ['observer', 'gate'], 1]);
  });

  it('works without an observer', async () => {
    const { post } = await served();
    const res = await post(CALL);
    expect([res.status, await res.json()]).toEqual([200, DENY]);
  });

  it('reports nothing of a call that carries no secret', async () => {
    const seen: unknown[] = [];
    const { order, post } = await served((body) => seen.push(body));
    expect([(await post(CALL, 'Bearer nope')).status, seen, order]).toEqual([401, [], []]);
  });
});
