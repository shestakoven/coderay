import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { MapSnapshot, McpEntry, Policy } from '@ide/protocol';
import type { AgentSession, SessionGate } from '../agent/agent-session';
import { systemPrompt } from '../agent/system-prompt';
import { requireSecret } from '../server/agent-http';
import { removeGateFiles, writeGateFiles } from '../hook/gate-files';
import { projectDir, runDir } from '../home';
import { idecoreRoute } from '../idecore/mcp-server';
import type { SearchOutcome } from '../map/map-service';
import { reviewPlan } from '../plans/freeze';
import type { ComponentRef } from '../plans/plan-input';
import { PlanService } from '../plans/plan-service';
import type { HttpRoute } from '../server/server';
import type { Store } from '../store/store';
import { aliveRoute, Canary } from './canary';
import { HookGate } from './hook-gate';
import type { Hold } from './hold';
import { eventRoute } from './event-route';
import { hookRoute } from './hook-route';

export const IDECORE_TIMEOUT_MS = 3_600_000;

export interface GateRuntimeOptions {
  root: string;
  home: string;
  store: Store;
  policy: () => Policy;
  components: () => ComponentRef[];
  map?: () => MapSnapshot | null;
  search?: (query: string, limit: number) => Promise<SearchOutcome>;
  port: () => number;
  secret?: string;
  userHome?: string;
  tempRoots?: string[];
  holdMs?: number;
  hold?: Hold;
  planDeadlineMs?: number;
  hookDeadlineMs?: number;
}

export interface GateRuntime {
  plans: PlanService;
  gate: HookGate;
  canary: Canary;
  routes: HttpRoute[];
  mcpEntry(): McpEntry;
  sessionGate: SessionGate;
  attach(session: AgentSession): void;
  close(): Promise<void>;
}

export function createGateRuntime(options: GateRuntimeOptions): GateRuntime {
  const secret = options.secret ?? randomBytes(24).toString('base64url');
  requireSecret(secret);
  const canary = new Canary();
  let session: AgentSession | null = null;
  const sessionId = () => session?.sessionId() ?? null;
  const plans = new PlanService({
    root: options.root,
    store: options.store,
    sessionId,
    components: options.components,
    review: (steps) => reviewPlan(steps, {
      root: options.root, policy: options.policy(), components: options.components(), home: options.userHome, tempRoots: options.tempRoots,
    }),
    deadlineMs: options.planDeadlineMs,
  });
  const gate = new HookGate({
    root: options.root,
    store: options.store,
    sessionId,
    policy: options.policy,
    plans,
    components: options.components,
    context: (toolUseId) => session?.context(toolUseId) ?? { parentToolUseId: null, lastMessage: null },
    home: options.userHome,
    tempRoots: options.tempRoots,
    holdMs: options.holdMs,
    hold: options.hold,
  });
  const idecore = idecoreRoute({ secret, plans, map: options.map, search: options.search, setTitle: (title) => session?.setTitle(title) ?? false });
  const url = (path: string) => `http://127.0.0.1:${options.port()}${path}`;
  const base = (id: string) => `${basename(projectDir(options.home, options.root))}-${id}`;
  return {
    plans,
    gate,
    canary,
    routes: [
      idecore,
      hookRoute({ secret, gate, observe: (body) => session?.toolCalled(body), note: (body) => session?.callNote(body) ?? null }),
      aliveRoute({ secret, canary }),
      eventRoute({ secret, handle: (sessionId, event, signal) => session?.hookEvent(sessionId, event, signal) ?? null }),
    ],
    mcpEntry: () => ({ type: 'http', url: url('/mcp'), headers: { Authorization: `Bearer ${secret}` }, timeout: IDECORE_TIMEOUT_MS }),
    sessionGate: {
      write: (id, events) => ({
        settingsPath: writeGateFiles(runDir(options.home), base(id), { url: url('/hook'), secret, sessionId: id, deadlineMs: options.hookDeadlineMs, events }).settingsPath,
      }),
      remove: (id) => removeGateFiles(runDir(options.home), base(id)),
      systemPrompt: () => systemPrompt(options.components(), options.map !== undefined, options.search !== undefined),
      canary,
    },
    attach(agent) {
      session = agent;
      gate.onDecision((record) => agent.recordDecision(record));
      agent.onUserMessage(() => plans.userMessage());
      // An ok result means the call ran without the hook's answer: a fail-open, which is not a denial.
      agent.onToolResult((info) => gate.dropForTool(info.toolUseId, { record: info.status !== 'ok' }));
      agent.onProcessExit(() => plans.withdrawPending("The agent's process ended while the plan waited for an answer."));
      agent.onProcessExit(() => gate.dropAll());
    },
    close: () => idecore.close(),
  };
}
