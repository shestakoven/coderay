import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { McpEntry, Policy } from '@ide/protocol';
import type { AgentSession, SessionGate } from '../agent/agent-session';
import { systemPrompt } from '../agent/system-prompt';
import { requireSecret } from '../server/agent-http';
import { removeGateFiles, writeGateFiles } from '../hook/gate-files';
import { projectDir, runDir } from '../home';
import { idecoreRoute } from '../idecore/mcp-server';
import { reviewPlan } from '../plans/freeze';
import type { ComponentRef } from '../plans/plan-input';
import { PlanService } from '../plans/plan-service';
import type { HttpRoute } from '../server/server';
import type { Store } from '../store/store';
import { aliveRoute, Canary } from './canary';
import { HookGate } from './hook-gate';
import { hookRoute } from './hook-route';

export const IDECORE_TIMEOUT_MS = 3_600_000;

export interface GateRuntimeOptions {
  root: string;
  home: string;
  store: Store;
  policy: () => Policy;
  components: () => ComponentRef[];
  port: () => number;
  secret?: string;
  userHome?: string;
  tempRoots?: string[];
  holdMs?: number;
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
  });
  const idecore = idecoreRoute({ secret, plans });
  const url = (path: string) => `http://127.0.0.1:${options.port()}${path}`;
  const base = (id: string) => `${basename(projectDir(options.home, options.root))}-${id}`;
  return {
    plans,
    gate,
    canary,
    routes: [idecore, hookRoute({ secret, gate }), aliveRoute({ secret, canary })],
    mcpEntry: () => ({ type: 'http', url: url('/mcp'), headers: { Authorization: `Bearer ${secret}` }, timeout: IDECORE_TIMEOUT_MS }),
    sessionGate: {
      write: (id) => ({ settingsPath: writeGateFiles(runDir(options.home), base(id), { url: url('/hook'), secret, sessionId: id, deadlineMs: options.hookDeadlineMs }).settingsPath }),
      remove: (id) => removeGateFiles(runDir(options.home), base(id)),
      systemPrompt: () => systemPrompt(options.components()),
      canary,
    },
    attach(agent) {
      session = agent;
      gate.onDecision((record) => agent.recordDecision(record));
      agent.onToolEnd((toolUseId) => gate.dropForTool(toolUseId));
      agent.onProcessExit(() => plans.withdrawPending("The agent's process ended while the plan waited for an answer."));
      agent.onProcessExit(() => gate.dropAll());
    },
    close: () => idecore.close(),
  };
}
