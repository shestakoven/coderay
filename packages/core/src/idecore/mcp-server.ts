import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { PlanService } from '../plans/plan-service';
import { BodyError, isAgentRequest, readJsonBody } from '../server/agent-http';
import type { HttpRoute } from '../server/server';

export interface IdecoreRoute extends HttpRoute {
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const PROPOSE_DESCRIPTION = [
  'Show your plan to the user on the IDE map before you change project files, and wait for the answer.',
  'Each step has a key, a title, a rationale and targets. A target is {"componentId": "<id from the system prompt>"} or {"path": "<project path>"}, with "op": "modify", "create" or "delete".',
  'Returns {"status": "approved" | "changes_requested" | "rejected", "feedback"?: "..."}.',
  'To change an approved plan, call it again with the whole plan and keep the active and done steps.',
].join(' ');

const STEP_DESCRIPTION = 'Mark a step of the approved plan as started (phase "start") before you work on it, and as finished (phase "done") after it. One step is active at a time.';

const target = z.object({ componentId: z.string().optional(), path: z.string().optional(), op: z.enum(['modify', 'create', 'delete']) });
const proposeInput = {
  goal: z.string(),
  steps: z.array(z.object({ key: z.string(), title: z.string(), rationale: z.string(), targets: z.array(target) })),
};
const stepInput = { key: z.string(), phase: z.enum(['start', 'done']) };

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export function idecoreRoute(options: { secret: string; plans: PlanService }): IdecoreRoute {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: 'idecore', version: '1.0.0' });
    server.registerTool('propose_plan', { description: PROPOSE_DESCRIPTION, inputSchema: proposeInput }, async (input, extra) => {
      const outcome = await options.plans.propose(input, extra.signal);
      return outcome.ok ? result(outcome.value) : failure(outcome.error);
    });
    server.registerTool('step', { description: STEP_DESCRIPTION, inputSchema: stepInput }, async (input) => {
      const outcome = options.plans.step(input);
      return outcome.ok ? result({ ok: true }) : failure(outcome.error);
    });
    return server;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAgentRequest(req, options.secret)) {
      res.writeHead(401).end();
      return;
    }
    let body: unknown;
    try {
      body = req.method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : undefined;
    } catch (error) {
      res.writeHead(error instanceof BodyError ? error.status : 400).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (typeof sessionId === 'string') {
        res.writeHead(404).end();
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await buildServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  };

  return {
    path: '/mcp',
    handle(req, res) {
      handle(req, res).catch((error: unknown) => {
        console.error('idecore: could not handle a request', error);
        if (!res.headersSent) res.writeHead(500).end();
      });
    },
    async close() {
      const open = [...transports.values()];
      transports.clear();
      await Promise.all(open.map((transport) => transport.close()));
    },
  };
}
