import { isRecord } from '../json';
import { BodyError, isAgentRequest, readJsonBody, requireSecret } from '../server/agent-http';
import type { HttpRoute } from '../server/server';

const MAX_EVENT_BODY_BYTES = 64 * 1024 * 1024;

// The answer is written to claude's hook output as is: a note for the agent, or a request to go on.
export type EventAnswer = object | null;

export function eventRoute(options: { secret: string; handle: (sessionId: string, event: unknown) => EventAnswer }): HttpRoute {
  requireSecret(options.secret);
  return {
    path: '/hook/event',
    handle(req, res) {
      void (async () => {
        if (req.method !== 'POST' || !isAgentRequest(req, options.secret)) {
          res.writeHead(401).end();
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, MAX_EVENT_BODY_BYTES);
        } catch (error) {
          res.writeHead(error instanceof BodyError ? error.status : 400).end();
          return;
        }
        if (!isRecord(body) || typeof body.sessionId !== 'string') {
          res.writeHead(400).end();
          return;
        }
        let answer: EventAnswer = null;
        try {
          answer = options.handle(body.sessionId, body.event);
        } catch (error) {
          console.error('agent: could not handle a hook event', error);
        }
        if (answer === null) res.writeHead(204).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      })();
    },
  };
}
