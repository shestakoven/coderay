import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MapSnapshot } from '@ide/protocol';
import { PLAN_FLOW_EDGE_STATES, PLAN_FLOW_FILE_OPS, PLAN_FLOW_NODE_KINDS, PLAN_FLOW_NODE_STATES } from '@ide/protocol';
import { z } from 'zod';
import type { SearchOutcome } from '../map/map-service';
import type { PlanService } from '../plans/plan-service';
import { BodyError, isAgentRequest, readJsonBody, requireSecret } from '../server/agent-http';
import type { HttpRoute } from '../server/server';

export interface IdecoreRoute extends HttpRoute {
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const PROPOSE_DESCRIPTION = [
  'Show your plan to the user on the IDE map before you change project files, and wait for the answer.',
  'Each step has a key, a title, a rationale and targets. A target is {"componentId": "<id from the system prompt>"} or {"path": "<project path>"}, with "op": "modify", "create" or "delete".',
  'Also send "flow" when the change adds or rewires parts: nodes {id, title, sub, kind, state, steps, files} and edges {from, to, label, state, step} that draw what the plan builds, like client → POST /users → UserService → User → users table.',
  'A node is "existing", "modify", "create" or "delete"; an edge is "existing", "new" or "removed"; "steps" and "step" are step keys. Use 5 to 12 nodes, one per responsibility, and label every new edge with what travels along it.',
  'Returns {"status": "approved" | "changes_requested" | "rejected", "feedback"?: "..."}.',
  'To change an approved plan, call it again with the whole plan and keep the active and done steps.',
].join(' ');

const STEP_DESCRIPTION = 'Mark a step of the approved plan as started (phase "start") before you work on it, and as finished (phase "done") after it. One step is active at a time.';

const target = z.object({ componentId: z.string().optional(), path: z.string().optional(), op: z.enum(['modify', 'create', 'delete']) });
const flowNode = z.object({
  id: z.string(),
  title: z.string(),
  sub: z.string().optional(),
  kind: z.enum(PLAN_FLOW_NODE_KINDS),
  state: z.enum(PLAN_FLOW_NODE_STATES),
  steps: z.array(z.string()).optional(),
  files: z.array(z.object({ op: z.enum(PLAN_FLOW_FILE_OPS), path: z.string(), note: z.string().optional() })).optional(),
});
const flowEdge = z.object({ from: z.string(), to: z.string(), label: z.string().optional(), state: z.enum(PLAN_FLOW_EDGE_STATES), step: z.string().optional() });
const proposeInput = {
  goal: z.string(),
  steps: z.array(z.object({ key: z.string(), title: z.string(), rationale: z.string(), targets: z.array(target) })),
  flow: z.object({ nodes: z.array(flowNode), edges: z.array(flowEdge).optional() }).optional(),
};
const stepInput = { key: z.string(), phase: z.enum(['start', 'done']) };

const TITLE_DESCRIPTION = 'Name this chat once, right after your first reply: 2 to 6 words describing the task, in the language the user writes in, no quotes. Returns {"ok": false} when the chat already has a name; that is fine, do not retry.';
const titleInput = { title: z.string().max(200) };

const MAP_OVERVIEW_DESCRIPTION = 'Read-only: the IDE project map. Returns every component with id, name, summary, file count and the components it depends on.';
const MAP_COMPONENT_DESCRIPTION = 'Read-only: one component of the IDE project map by id: description, key files, all files with their exported symbols.';

const SEARCH_DESCRIPTION = [
  'Semantic search over project files by meaning, for questions like "where is X handled" or "which file does Y" when you are getting to know the project.',
  'Do not use it for exact names, strings or error messages: the vectors do not find them, use grep for those.',
  'Returns files ranked by similarity with path, componentId, similarity and up to 5 exported symbol names; it does not return file contents.',
  'The ranking is heuristic: confirm by reading the file.',
].join(' ');
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 30;
const MAX_SEARCH_SYMBOLS = 5;
const searchInput = { query: z.string(), limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional() };

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export interface IdecoreRouteOptions {
  secret: string;
  plans: PlanService;
  map?: () => MapSnapshot | null;
  search?: (query: string, limit: number) => Promise<SearchOutcome>;
  setTitle?: (title: string) => boolean;
}

export function idecoreRoute(options: IdecoreRouteOptions): IdecoreRoute {
  requireSecret(options.secret);
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
    const { setTitle } = options;
    if (setTitle) {
      server.registerTool('set_chat_title', { description: TITLE_DESCRIPTION, inputSchema: titleInput }, ({ title }) => result({ ok: setTitle(title) }));
    }
    const { map } = options;
    if (map) {
      server.registerTool('map_overview', { description: MAP_OVERVIEW_DESCRIPTION }, () => {
        const snapshot = map();
        if (!snapshot) return failure('The project map is not ready yet.');
        const owner = new Map(snapshot.files.map((file) => [file.path, file.componentId]));
        const links = new Map<string, Set<string>>();
        for (const edge of snapshot.fileEdges) {
          const from = owner.get(edge.from);
          const to = owner.get(edge.to);
          if (from && to && from !== to) links.set(from, (links.get(from) ?? new Set()).add(to));
        }
        return result(snapshot.components.map(({ id, name, summary, files, stale }) => ({
          id, name, summary, files: files.length, stale, dependsOn: [...(links.get(id) ?? [])],
        })));
      });
      server.registerTool('map_component', { description: MAP_COMPONENT_DESCRIPTION, inputSchema: { id: z.string() } }, ({ id }) => {
        const snapshot = map();
        const component = snapshot?.components.find((item) => item.id === id);
        if (!snapshot || !component) return failure(`There is no component "${id}" on the map.`);
        const symbols = new Map(snapshot.files.map((file) => [file.path, file.symbols.filter((s) => s.exported).map((s) => s.name)]));
        const { name, summary, description, keyFiles, files } = component;
        return result({ id, name, summary, description, keyFiles, files: files.map((path) => ({ path, symbols: symbols.get(path) ?? [] })) });
      });
    }
    const { search } = options;
    if (search) {
      server.registerTool('search_code', { description: SEARCH_DESCRIPTION, inputSchema: searchInput }, async ({ query, limit }) => {
        const outcome = await search(query, limit ?? DEFAULT_SEARCH_LIMIT);
        if (!outcome.ok) return failure(outcome.error);
        const files = new Map(options.map?.()?.files.map((file) => [file.path, file]));
        const results = outcome.hits.map(({ path, similarity }) => ({
          path,
          componentId: files.get(path)?.componentId ?? null,
          similarity: Math.round(similarity * 100) / 100,
          symbols: (files.get(path)?.symbols ?? []).filter((s) => s.exported).slice(0, MAX_SEARCH_SYMBOLS).map((s) => s.name),
        }));
        return result(outcome.indexed < outcome.total ? { note: `index incomplete: ${outcome.indexed}/${outcome.total}`, results } : results);
      });
    }
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
