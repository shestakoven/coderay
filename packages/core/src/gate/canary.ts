import { BodyError, isAgentRequest, readJsonBody, requireSecret } from '../server/agent-http';
import type { HttpRoute } from '../server/server';

export const CANARY_MS = 20_000;
const MAX_ALIVE_BODY_BYTES = 4096;

export class Canary {
  private readonly seen = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  expect(sessionId: string): void {
    this.seen.delete(sessionId);
  }

  ping(sessionId: string): void {
    this.seen.add(sessionId);
    for (const wake of this.waiters.get(sessionId) ?? []) wake();
  }

  wait(sessionId: string, ms: number): Promise<boolean> {
    if (this.seen.has(sessionId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiting = this.waiters.get(sessionId) ?? new Set<() => void>();
      this.waiters.set(sessionId, waiting);
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        waiting.delete(wake);
        resolve(ok);
      };
      const wake = (): void => done(true);
      const timer = setTimeout(() => done(false), ms);
      waiting.add(wake);
    });
  }
}

export function aliveRoute(options: { secret: string; canary: Canary }): HttpRoute {
  requireSecret(options.secret);
  return {
    path: '/hook/alive',
    handle(req, res) {
      void (async () => {
        if (req.method !== 'POST' || !isAgentRequest(req, options.secret)) {
          res.writeHead(401).end();
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, MAX_ALIVE_BODY_BYTES);
        } catch (error) {
          res.writeHead(error instanceof BodyError ? error.status : 400).end();
          return;
        }
        const sessionId = (body as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof sessionId !== 'string') {
          res.writeHead(400).end();
          return;
        }
        options.canary.ping(sessionId);
        res.writeHead(204).end();
      })();
    },
  };
}
