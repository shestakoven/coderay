import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NO_PERMISSIONS } from '../agent/codex/approvals';
import { handshake, startAppServer, type AppServer } from '../agent/codex/app-server';
import type { CodexCommand } from '../agent/codex/command';
import type { ConfigReadResponse, JsonValue, Model, ThreadStartResponse, Turn, TurnStartResponse } from '../agent/codex/protocol';
import type { IncomingRequest } from '../agent/codex/rpc';
import { hideSecrets } from '../agent/codex/secrets';
import { threadConfig } from '../agent/codex/transport';
import { isRecord } from '../json';
import { structuredOutput } from './structured-output';
import type { GenerateOptions, StructuredModel, StructuredRequest } from './types';

export const CODEX_FAST_PATTERN = /mini|nano/i;
/**
 * The thread keys codex-cli 0.160 takes to switch off what a JSON answer never needs (docs/spike/2026-10-19-background-ai-verified.md, Q2):
 * the shell, web search, local image reads and goals; and the login-shell snapshot, which runs the user's dotfiles and writes into the Codex home.
 */
export const BACKGROUND_TOOLS_OFF: Record<string, JsonValue> = {
  'features.shell_tool': false, web_search: 'disabled', 'features.view_image': false, 'features.goals': false, 'features.shell_snapshot': false,
};
export const BACKGROUND_INSTRUCTIONS = 'Answer with one JSON document only. Do not run commands, read files, search the web or call tools: everything you need is in the message.';
/** The item types a plain answer emits (spike Q2); any other one is a tool starting. */
const ANSWER_ITEMS: ReadonlySet<string> = new Set(['agentMessage', 'reasoning', 'userMessage']);
// codex 0.160 lists max and ultra above xhigh; a name not here ranks last.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const THREAD_POLICY = { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' } as const;
const TURN_POLICY = { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', approvalsReviewer: 'user' } as const;
const NOT_HANDLED = -32601;
const INTERRUPT_MS = 2_000;
const cancelled = (): Error => new Error('cancelled');

export interface CodexBackgroundModel { id: string; effort: string | null }

export function pickCodexModel(models: Model[], wanted: string | null): CodexBackgroundModel | null {
  const visible = models.filter((model) => !model.hidden);
  const model = wanted !== null
    ? visible.find((candidate) => candidate.id === wanted)
    : visible.find((candidate) => CODEX_FAST_PATTERN.test(candidate.id)) ?? visible.find((candidate) => candidate.isDefault) ?? visible[0];
  if (!model) return null;
  const rank = (effort: string): number => (EFFORT_ORDER.includes(effort) ? EFFORT_ORDER.indexOf(effort) : EFFORT_ORDER.length);
  const effort = model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    .reduce<string | null>((lowest, candidate) => (lowest === null || rank(candidate) < rank(lowest) ? candidate : lowest), null);
  return { id: model.id, effort };
}

/** Why the echo of a background thread is not read-only, offline and never asking; null when it is. */
export function backgroundPolicyProblem(echo: unknown): string | null {
  if (!isRecord(echo) || !isRecord(echo.thread) || typeof echo.thread.id !== 'string') return 'codex opened no thread it could name';
  const sandbox = isRecord(echo.sandbox) ? echo.sandbox : {};
  const offline = sandbox.networkAccess === undefined || sandbox.networkAccess === false;
  if (sandbox.type === 'readOnly' && offline && echo.approvalPolicy === 'never') return null;
  return `codex reported sandbox ${String(sandbox.type)}${offline ? '' : ' with network access'} and approvals ${JSON.stringify(echo.approvalPolicy)}, not read-only and never asking, so the background call was not run`;
}

/** A background turn grants nothing: every approval, permission or elicitation request is declined. */
function decline(server: AppServer, { id, method }: IncomingRequest): void {
  if (method === 'item/permissions/requestApproval') server.rpc.reply(id, NO_PERMISSIONS);
  else if (method.endsWith('/requestApproval')) server.rpc.reply(id, { decision: 'decline' });
  else if (method === 'mcpServer/elicitation/request') server.rpc.reply(id, { action: 'decline', content: null, _meta: null });
  else server.rpc.fail(id, NOT_HANDLED, `A background call does not handle ${method}.`);
}

export interface CodexModelOptions { command: () => CodexCommand; model: string; effort: string | null; runDir: string; timeoutMs?: number }

export class CodexModel implements StructuredModel {
  constructor(private readonly options: CodexModelOptions) {}

  async generate(request: StructuredRequest, { signal }: GenerateOptions = {}): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    await mkdir(this.options.runDir, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(this.options.runDir, `model-${process.pid}-`));
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let reported: string | null = null;
    const answers: { text: string; final: boolean }[] = [];
    // One reason ends the call early (a tool or an MCP server started, the timeout, an abort); the first one wins.
    let stopped: Error | null = null;
    let fail: (reason: Error) => void = () => undefined;
    // Rejected at most once, its rejection handled here: an app-server stopping can never leave an unhandled rejection.
    const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
    failed.catch(() => undefined);
    let settle: (turn: Turn) => void = () => undefined;
    const ended = new Promise<Turn>((resolve) => { settle = resolve; });
    const server = startAppServer(this.options.command(), {
      cwd, pidDir: this.options.runDir,
      onRequest: (message) => decline(server, message),
      onNotification: ({ method, params }) => {
        if (!isRecord(params)) return;
        if (method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') turnId = params.turn.id;
        if (method === 'item/started' && isRecord(params.item) && !ANSWER_ITEMS.has(String(params.item.type))) {
          stopWith(new Error(`codex tried to run a tool in a background call (${String(params.item.type)})`));
        }
        // Every server the configuration defines is switched off: one that starts anyway is not CodeRay's to trust.
        if (method === 'mcpServer/startupStatus/updated') stopWith(new Error(`codex started an MCP server in a background call (${String(params.name)})`));
        if (method === 'item/completed' && isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          answers.push({ text: params.item.text, final: params.item.phase === 'final_answer' });
        }
        if (method === 'error' && isRecord(params.error) && typeof params.error.message === 'string' && params.willRetry !== true) reported = params.error.message;
        if (method === 'turn/completed' && isRecord(params.turn)) settle(params.turn as unknown as Turn);
      },
    });
    const interrupt = async (): Promise<void> => {
      if (threadId === null || turnId === null) return;
      const capped = new Promise((resolve) => setTimeout(resolve, INTERRUPT_MS).unref());
      await Promise.race([server.rpc.request('turn/interrupt', { threadId, turnId }), capped]).catch(() => undefined);
    };
    function stopWith(reason: Error): void {
      if (stopped !== null) return;
      stopped = reason;
      void interrupt().finally(() => fail(reason));
    }
    void server.exited.then(() => fail(new Error('codex app-server stopped before it answered')));
    const timer = setTimeout(() => stopWith(new Error(`codex did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
    const onAbort = (): void => stopWith(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort while the directory was made fired no listener yet.
    if (signal?.aborted) onAbort();
    const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed]);
    try {
      await within(handshake(server.rpc));
      const effective = await within(server.rpc.request<ConfigReadResponse>('config/read', { cwd, includeLayers: false }));
      const config = threadConfig(isRecord(effective) && isRecord(effective.config) ? effective.config : {}, { servers: new Set(), config: BACKGROUND_TOOLS_OFF });
      if (typeof config === 'string') throw new Error(config);
      const thread = await within(server.rpc.request<ThreadStartResponse>('thread/start', {
        cwd, model: this.options.model, ephemeral: true, developerInstructions: BACKGROUND_INSTRUCTIONS, config, ...THREAD_POLICY,
      }));
      const problem = backgroundPolicyProblem(thread);
      if (problem !== null) throw new Error(problem);
      threadId = thread.thread.id;
      const started = await within(server.rpc.request<TurnStartResponse>('turn/start', {
        threadId, model: this.options.model, ...(this.options.effort === null ? {} : { effort: this.options.effort }),
        outputSchema: request.schema, ...TURN_POLICY,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
      }));
      // turn/start's answer names the turn when its turn/started has not come yet, so a stop can interrupt it.
      if (turnId === null && isRecord(started) && isRecord(started.turn) && typeof started.turn.id === 'string') turnId = started.turn.id;
      const turn = await within(ended);
      if (stopped !== null) throw stopped;
      if (turn.status !== 'completed') throw new Error(`codex turn ${turn.status}: ${turn.error?.message ?? reported ?? 'no reason given'}`);
      const answer = answers.find((candidate) => candidate.final) ?? answers.at(-1);
      if (answer === undefined) throw new Error('codex ended the turn without a message');
      return structuredOutput(answer.text, request.schema);
    } catch (caught) {
      if (signal?.aborted) throw cancelled();
      const reason = stopped ?? caught;
      throw reason instanceof Error ? new Error(hideSecrets(reason.message)) : reason;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await server.kill();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
