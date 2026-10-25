import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseModelId } from '@ide/protocol';
import { hideSecrets } from '../agent/codex/secrets';
import type { CatalogModel } from '../agent/engines/opencode';
import type { OpencodeClient } from '../agent/opencode/api';
import { opencodeEnv, type OpencodeCommand } from '../agent/opencode/command';
import { backgroundConfig, BUILT_IN_TOOLS, DENY_ALL, denyAllProblem, selfCheck, TOOL_IDS_TIMEOUT_MS, toolOutputGlob } from '../agent/opencode/config';
import { retryBusy, shellWrapper, startServer, type OpencodeServer } from '../agent/opencode/server';
import { isRecord } from '../json';
import { structuredOutput } from './structured-output';
import type { GenerateOptions, StructuredModel, StructuredRequest } from './types';

export const JSON_SYSTEM_PROMPT = 'You answer with exactly one JSON document that fits the JSON Schema given in the message, and nothing else: no prose, no code fence. You have no tools; do not try to run commands or read files.';
const RETRY_NOTE = 'Your previous answer was not valid JSON for the schema. Answer again with one JSON document only.';
const CHEAP = /mini|flash|lite|haiku|free/i;
const CLEANUP_MS = 2_000;
const cancelled = (): Error => new Error('cancelled');

/** The prompt's tool switches: every tool of 1.19 and every tool of the user's MCP servers off, so the model is offered none (spike Q4). */
export const noTools = (userServers: readonly string[]): Record<string, false> =>
  Object.fromEntries([...BUILT_IN_TOOLS, ...userServers.map((name) => `${name}_*`)].map((tool) => [tool, false]));

export interface OpencodePick { providerID: string; modelID: string; value: string }

/** The cheapest model, an unknown price after every known one; among equals an opencode model, then a cheap-sounding one, then the catalog's order. */
export function pickOpencodeModel(catalog: CatalogModel[]): OpencodePick | null {
  const id = (model: CatalogModel): string => parseModelId(model.value)?.model ?? '';
  const rank = (model: CatalogModel): number[] => [model.cost ?? Number.POSITIVE_INFINITY, id(model).startsWith('opencode/') ? 0 : 1, CHEAP.test(id(model)) ? 0 : 1];
  const compare = (a: number[], b: number[]): number => {
    const at = a.findIndex((value, index) => value !== b[index]);
    return at === -1 ? 0 : a[at]! - b[at]!;
  };
  // The sort is stable, so equals keep the catalog's order.
  const best = [...catalog].sort((a, b) => compare(rank(a), rank(b)))[0];
  if (best === undefined) return null;
  const slash = id(best).indexOf('/');
  return slash > 0 ? { providerID: id(best).slice(0, slash), modelID: id(best).slice(slash + 1), value: best.value } : null;
}

export interface OpencodeModelOptions { command: () => OpencodeCommand; model: { providerID: string; modelID: string }; userServers: string[]; runDir: string; timeoutMs?: number }

/**
 * A structured answer from its own `opencode serve`: deny-all rules on every agent, the user's MCP servers off by name, no tool offered,
 * the schema in the prompt; the session is deleted and the server stopped whatever happens.
 */
export class OpencodeModel implements StructuredModel {
  constructor(private readonly options: OpencodeModelOptions) {}

  async generate(request: StructuredRequest, { signal }: GenerateOptions = {}): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    const { command: commandOf, model, userServers, runDir } = this.options;
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(runDir, `model-${process.pid}-`));
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    const command = commandOf();
    const shell = shellWrapper(runDir);
    const configContent = backgroundConfig(shell, userServers, `${model.providerID}/${model.modelID}`);
    const passwords: string[] = [];
    const hide = (text: string): string => hideSecrets(passwords.reduce((shown, password) => shown.replaceAll(password, '…'), text));
    // One reason ends the call early (the timeout, an abort, a retry past the deadline); the first one wins.
    let fail: (reason: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
    failed.catch(() => undefined);
    const timer = setTimeout(() => fail(new Error(`opencode did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
    const onAbort = (): void => fail(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort while the directory was made fired no listener yet.
    if (signal?.aborted) onAbort();
    const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed]);
    const watching = new AbortController();
    let server: OpencodeServer | null = null;
    let client: OpencodeClient | null = null;
    let sessionId: string | null = null;
    try {
      // The chat's server, the probe's and other projects' cores share one database: a busy start is tried again.
      for (let attempt = 0; client === null; attempt += 1) {
        server = startServer(command, { cwd, configContent, pidDir: runDir });
        passwords.push(server.password);
        try {
          ({ client } = await within(server.ready));
        } catch (error) {
          await server.kill();
          server = null;
          if (!(await retryBusy(error, attempt))) throw error;
        }
      }
      const [agents, config, toolIds] = await within(Promise.all([client.get('/agent'), client.get('/config'), client.get('/experimental/tool/ids', TOOL_IDS_TIMEOUT_MS)]));
      const toolOutput = toolOutputGlob(opencodeEnv(command));
      const problem = selfCheck({ agents, config, toolIds }, { mcp: {}, toolOutput, shell }) ?? denyAllProblem(agents, toolOutput);
      if (problem !== null) throw new Error(typeof problem === 'string' ? problem : `opencode's agent ${problem.agent} would ${problem.action} ${problem.permission} ${problem.pattern}`);
      sessionId = (await within(client.post<{ id: string }>('/session', { permission: DENY_ALL }))).id;
      await within(watchRetries(client, deadline, fail, watching.signal));
      const text = await within(this.ask(client, sessionId, `${request.prompt}\n\nJSON Schema of the answer:\n${JSON.stringify(request.schema)}`));
      try {
        return structuredOutput(text, request.schema);
      } catch {
        return structuredOutput(await within(this.ask(client, sessionId, RETRY_NOTE)), request.schema);
      }
    } catch (error) {
      if (client !== null && sessionId !== null) await client.post(`/session/${sessionId}/abort`, undefined, CLEANUP_MS).catch(() => undefined);
      if (signal?.aborted) throw cancelled();
      throw error instanceof Error ? new Error(hide(error.message)) : error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      watching.abort();
      if (client !== null && sessionId !== null) await client.del(`/session/${sessionId}`, CLEANUP_MS).catch(() => undefined);
      await server?.kill();
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** One turn on `/message`, which answers when the turn ends (spike Q3): its text, or opencode's reason when the turn failed. */
  private async ask(client: OpencodeClient, session: string, text: string): Promise<string> {
    const answer = await client.post<unknown>(`/session/${session}/message`, {
      agent: 'build', model: this.options.model, tools: noTools(this.options.userServers), system: JSON_SYSTEM_PROMPT, parts: [{ type: 'text', text }],
    }, 0);
    const info = isRecord(answer) && isRecord(answer.info) ? answer.info : {};
    if (isRecord(info.error)) {
      const reason = isRecord(info.error.data) && typeof info.error.data.message === 'string' ? info.error.data.message : String(info.error.name);
      throw new Error(`opencode's model failed: ${reason}`);
    }
    const parts = isRecord(answer) && Array.isArray(answer.parts) ? answer.parts : [];
    return parts.filter((part): part is { type: 'text'; text: string } => isRecord(part) && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  }
}

/**
 * Follows the server's events until `signal` aborts; resolves once the stream is open. A retry opencode would make only after the deadline
 * fails the call at once: a free model over its daily limit waits until 00:00 UTC (spike Q3). The server is this call's alone.
 */
function watchRetries(client: OpencodeClient, deadline: number, fail: (reason: Error) => void, signal: AbortSignal): Promise<void> {
  return new Promise((opened, broken) => {
    client.events(({ type, properties }) => {
      opened();
      const { status } = properties;
      // Only a retry carries `next`.
      if (type === 'session.status' && isRecord(status) && typeof status.next === 'number' && status.next > deadline) {
        fail(new Error(`opencode's model is not available until ${new Date(status.next).toISOString()}: ${String(status.message ?? 'no reason given')}`));
      }
    }, signal).then(() => opened(), broken);
  });
}
