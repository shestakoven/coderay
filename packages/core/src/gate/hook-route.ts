import { BodyError, isAgentRequest, readJsonBody, requireSecret } from '../server/agent-http';
import type { HttpRoute } from '../server/server';
import type { HookAnswer, HookGate } from './hook-gate';

const MAX_HOOK_BODY_BYTES = 64 * 1024 * 1024;
const GATE_FAILED: HookAnswer = { permissionDecision: 'deny', permissionDecisionReason: 'IDE: the gate failed, so the call is blocked.' };

export function hookRoute(options: { secret: string; gate: HookGate; observe?: (body: unknown) => void }): HttpRoute {
  requireSecret(options.secret);
  return {
    path: '/hook',
    handle(req, res) {
      void (async () => {
        if (req.method !== 'POST' || !isAgentRequest(req, options.secret)) {
          res.writeHead(401).end();
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, MAX_HOOK_BODY_BYTES);
        } catch (error) {
          res.writeHead(error instanceof BodyError ? error.status : 400).end();
          return;
        }
        try {
          options.observe?.(body);
        } catch (error) {
          console.error('gate: could not report a tool call', error);
        }
        const connection = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) connection.abort();
        });
        const answer = await options.gate.evaluate(body, connection.signal).catch((error: unknown) => {
          console.error('gate: could not evaluate a hook call', error);
          return GATE_FAILED;
        });
        if (answer === null || res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      })();
    },
  };
}
