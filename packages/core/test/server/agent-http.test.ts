import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { aliveRoute, Canary } from '../../src/gate/canary';
import { createGateRuntime } from '../../src/gate/runtime';
import type { HookGate } from '../../src/gate/hook-gate';
import { hookRoute } from '../../src/gate/hook-route';
import { idecoreRoute } from '../../src/idecore/mcp-server';
import { isAgentRequest } from '../../src/server/agent-http';
import type { PlanService } from '../../src/plans/plan-service';

const request = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;

describe('isAgentRequest', () => {
  it('accepts the bearer secret and nothing else', () => {
    expect([isAgentRequest(request('Bearer s3cret'), 's3cret'), isAgentRequest(request('Bearer other!'), 's3cret'), isAgentRequest(request(), 's3cret')])
      .toEqual([true, false, false]);
  });

  it('refuses every request when the secret is empty', () => {
    expect(isAgentRequest(request(), '')).toBe(false);
    expect(isAgentRequest(request('Bearer '), '')).toBe(false);
  });
});

describe('an empty agent secret', () => {
  it('cannot build a route or a gate runtime', () => {
    const message = 'the agent secret must not be empty';
    expect(() => hookRoute({ secret: '', gate: {} as HookGate })).toThrow(message);
    expect(() => idecoreRoute({ secret: '', plans: {} as PlanService })).toThrow(message);
    expect(() => aliveRoute({ secret: '', canary: new Canary() })).toThrow(message);
    expect(() => createGateRuntime({ secret: '' } as Parameters<typeof createGateRuntime>[0])).toThrow(message);
  });
});
