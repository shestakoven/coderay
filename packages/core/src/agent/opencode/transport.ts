import { parseModelId } from '@ide/protocol';
import { isRecord } from '../../json';
import type { ProcessExit } from '../claude-process';
import { hideSecrets } from '../codex/secrets';
import { catalogModels, type CatalogModel } from '../engines/opencode';
import type { StreamEvent } from '../stream';
import type { AgentTransport, ControlResponse, OpencodeLaunch, TransportSink, UserMessage } from '../transport';
import { ApiError, type OpencodeClient, type SseEvent } from './api';
import { opencodeEnv } from './command';
import { checkedSubagents, inlineConfig, ruleset, selfCheck, toolOutputGlob } from './config';
import { OpencodeEvents } from './events';
import type { OpencodeMcp } from './mcp';
import { askCalls, judgeAsk, readAsk, type Ask, type Reply } from './permissions';
import { retryBusy, startServer, type OpencodeServer } from './server';

const INTERRUPTED: StreamEvent = { type: 'result', subtype: 'error_during_execution', origin: null };
const FAILED: StreamEvent = { type: 'result', subtype: 'failed', origin: null };
// Stop ends a turn that never says it ended after this long.
const INTERRUPT_SETTLE_MS = 5_000;
// An event stream that ends while its server lives is opened again this many times, this far apart.
const REOPENS = 3;
const REOPEN_MS = 1_000;
// How far up a session's parents CodeRay looks for the chat's own.
const MAX_DEPTH = 8;
// How long a bash ask waits for its call's input, and how often it looks.
const INPUT_WAIT_MS = 2_000;
const INPUT_POLL_MS = 20;
const SKILL = /^\/(\S+)(?:\s+([\s\S]*))?$/;
const MODEL_NOT_FOUND = /^Model not found: ([^/\s]+)\//;
const BEARER = /^Bearer\s+(\S+)$/i;
// Every prompt runs this agent; the self-check reads its rules.
const AGENT = 'build';

interface Pending { message: UserMessage; stop: number }
interface Question { question: string; header?: unknown; options?: unknown; multiple?: unknown }

export function startOpencodeTransport(launch: OpencodeLaunch, sink: TransportSink): AgentTransport {
  return new OpencodeTransport(launch, sink);
}

const isQuestion = (value: unknown): value is Question => isRecord(value) && typeof value.question === 'string';

// The bearer tokens of CodeRay's own servers: the model's shell can read them from the server's environment (`ps -E`).
function bearers(mcp: OpencodeMcp): string[] {
  return Object.values(mcp.config).flatMap((entry) => {
    const headers = isRecord(entry) && isRecord(entry.headers) ? Object.values(entry.headers) : [];
    return headers.flatMap((value) => {
      const token = typeof value === 'string' ? BEARER.exec(value)?.[1] : undefined;
      return token === undefined ? [] : [token];
    });
  });
}

function modelRef(model: string | null): { model?: { providerID: string; modelID: string } } {
  const slash = model?.indexOf('/') ?? -1;
  return model !== null && slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {};
}

function commandNames(answer: unknown): string[] {
  const names = Array.isArray(answer) ? answer.flatMap((command) => (isRecord(command) && typeof command.name === 'string' ? [command.name] : [])) : [];
  return [...new Set(names)];
}

class OpencodeTransport implements AgentTransport {
  readonly exited: Promise<ProcessExit>;
  private readonly launch: OpencodeLaunch;
  private readonly sink: TransportSink;
  private readonly events: OpencodeEvents;
  private readonly toolOutput: string;
  // The sessions whose asks are the chat's: the one CodeRay opened or resumed, and its subagents'.
  private readonly ownSessions = new Set<string>();
  // Root sessions that showed while CodeRay was creating its own: judged once it knows its id.
  private unclaimed: string[] = [];
  private creating = 0;
  // Asks being judged, by id; every ask seen, and those CodeRay answered (the tripwire tells them from anyone else's).
  private readonly asks = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly questions = new Map<string, Question[]>();
  // Never shown: each server's password and the bearer tokens of CodeRay's servers.
  private readonly secrets: string[];
  private readonly streams = new AbortController();
  private readonly skillsReady: Promise<string[]>;
  private settleSkills!: (skills: string[]) => void;
  private finish!: (exit: ProcessExit) => void;
  private settleTurn: () => void = () => {};
  private server!: OpencodeServer;
  private client: OpencodeClient | null = null;
  private version: string | null = null;
  private catalog: CatalogModel[] = [];
  private subagents: string[] = [];
  private skillList: string[] = [];
  private model: string | null;
  private sessionId: string | null = null;
  private opening: Promise<string> | null = null;
  // Messages for the server once it passed its checks.
  private queue: Pending[] = [];
  private chain: Promise<void> = Promise.resolve();
  private ready = false;
  private refused = false;
  private stopping = false;
  private ended = false;
  private turnOpen = false;
  private interrupting = false;
  private interruptTimer: NodeJS.Timeout | undefined;
  // Every Stop counts: a message sent before it never starts a turn after it.
  private stops = 0;
  // Starts that found the database busy with another server of the same home.
  private busyStarts = 0;

  constructor(launch: OpencodeLaunch, sink: TransportSink) {
    this.launch = launch;
    this.sink = sink;
    this.events = new OpencodeEvents(launch.servers);
    // The server's own data home: 1.19 allows its tool-output directory there.
    this.toolOutput = toolOutputGlob(opencodeEnv(launch.opencode));
    this.secrets = bearers(launch.mcp);
    this.model = launch.model;
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.skillsReady = new Promise((resolve) => {
      this.settleSkills = resolve;
    });
    this.start(launch.userServers);
  }

  get pid(): number | undefined {
    return this.server.pid;
  }

  send(message: UserMessage): void {
    const pending = { message, stop: this.stops };
    if (this.ready) this.enqueue(pending);
    else this.queue.push(pending);
  }

  interrupt(): void {
    if (this.interrupting || this.stopping || this.refused || this.ended) return;
    this.stops += 1;
    // No turn open: a message on its way never starts one, and the Stop ends here.
    if (!this.turnOpen) return this.emit([INTERRUPTED]);
    this.interrupting = true;
    this.events.interrupted();
    // 1.19's abort leaves a held ask pending (Q12-abort-leaves): CodeRay rejects it, and the gate's prompt goes.
    this.rejectOpen();
    void this.client?.post(`/session/${this.sessionId}/abort`).catch((error: Error) => console.warn(`opencode: could not stop the turn: ${error.message}`));
    this.interruptTimer = setTimeout(() => {
      if (this.interrupting) this.settleStop();
    }, INTERRUPT_SETTLE_MS);
  }

  stopTask(): void {}

  respond(response: ControlResponse): void {
    const questions = this.questions.get(response.request_id);
    const client = this.client;
    if (questions === undefined || client === null) return;
    this.questions.delete(response.request_id);
    const id = response.request_id;
    const answers = response.subtype === 'success' && response.response.behavior === 'allow' ? response.response.updatedInput.answers : null;
    // Q5-reject: a declined question ends the tool, and the turn with it.
    const answered = isRecord(answers)
      ? client.post(`/question/${id}/reply`, { answers: questions.map((question) => (typeof answers[question.question] === 'string' ? [answers[question.question]] : [])) })
      : client.post(`/question/${id}/reject`);
    answered.catch((error: Error) => console.warn(`opencode: could not answer the question ${id}: ${error.message}`));
  }

  setModel(model: string | null): Promise<void> {
    this.model = model;
    this.events.setModel(model, this.contextOf(model));
    return Promise.resolve();
  }

  skills(): Promise<string[]> {
    return this.skillsReady;
  }

  kill(): Promise<ProcessExit> {
    this.stopping = true;
    this.release();
    void this.server.kill();
    return this.exited;
  }

  private start(userServers: string[] | null): void {
    // Q11-quiet: the user's servers are read from a server without CodeRay's, since 1.19 merges a user's server into CodeRay's of the same name.
    const mcp = userServers === null ? { config: {}, names: [] } : this.launch.mcp;
    const server = startServer(this.launch.opencode, {
      cwd: this.launch.cwd, pidDir: this.launch.pidDir, killGraceMs: this.launch.killGraceMs, listenTimeoutMs: this.launch.listenTimeoutMs,
      configContent: inlineConfig(mcp, userServers ?? [], this.launch.shell),
    });
    this.server = server;
    this.secrets.push(server.password);
    const booting = this.boot(server, userServers);
    void server.exited.then(async (exit) => {
      // A server that failed to start is the boot's to report; one CodeRay replaced ends nothing.
      await booting;
      if (this.server !== server) return;
      if (exit.error !== null) this.refuse(`opencode did not start: ${exit.error}`);
      this.end(exit);
    });
  }

  // Messages and answers go only to the server the chat runs on now.
  private current(server: OpencodeServer): boolean {
    return this.server === server && !this.stopping && !this.ended && !this.refused;
  }

  private async boot(server: OpencodeServer, userServers: string[] | null): Promise<void> {
    try {
      const { client, version } = await server.ready;
      if (!this.current(server)) return;
      const config = userServers === null ? await client.get('/config') : null;
      const names = userServers ?? (isRecord(config) && isRecord(config.mcp) ? Object.keys(config.mcp) : []);
      if (!this.current(server)) return;
      const clash = names.find((name) => this.launch.servers.includes(name));
      if (clash !== undefined) return this.refuse(`Your opencode configuration defines an MCP server named "${clash}", as CodeRay does: rename yours to run opencode in CodeRay.`);
      if (userServers === null) {
        // This server never served a prompt; the chat runs on one with CodeRay's servers and the user's switched off by name.
        await server.kill();
        if (!this.stopping && !this.refused) this.start(names);
        return;
      }
      const problem = await this.check(client);
      if (!this.current(server)) return;
      if (problem !== null) return this.refuse(problem);
      const catalog = catalogModels(await client.get('/config/providers'));
      const commands = await client.get('/command');
      if (!this.current(server)) return;
      this.client = client;
      this.version = version;
      this.catalog = catalog;
      this.skillList = commandNames(commands);
      this.events.setSkills(this.skillList);
      this.settleSkills(this.skillList);
      await this.listen(server, client);
      if (!this.current(server)) return;
      this.ready = true;
      for (const pending of this.queue.splice(0)) this.enqueue(pending);
    } catch (error) {
      if (!this.current(server)) return;
      if (await retryBusy(error, this.busyStarts)) {
        this.busyStarts += 1;
        if (this.current(server)) this.start(userServers);
        return;
      }
      this.refuse(`opencode did not start: ${(error as Error).message}`);
    }
  }

  /** Why the server would let a write through, share the chat or hand the model its secrets, as the chat's refusal; null when it would not. */
  private async check(client: OpencodeClient): Promise<string | null> {
    const agents = await client.get('/agent');
    const config = await client.get('/config');
    const toolIds = await client.get('/experimental/tool/ids');
    this.subagents = checkedSubagents(agents, this.toolOutput);
    const problem = selfCheck({ agents, config, toolIds }, { mcp: this.launch.mcp.config, toolOutput: this.toolOutput, shell: this.launch.shell });
    if (problem === null) return null;
    if (typeof problem === 'string') return `${problem}, so the chat was not started.`;
    const tool = problem.permission === '*' ? 'any tool' : problem.permission;
    return `opencode agent ${problem.agent} would run ${tool} without asking (its rule for ${problem.permission} on ${problem.pattern} is ${problem.action}), so the chat was not started.`;
  }

  /** Follows the server's events; resolves once the stream is open. A stream that ends is opened again, and asks asked meanwhile are judged. */
  private listen(server: OpencodeServer, client: OpencodeClient): Promise<void> {
    return new Promise((opened) => {
      void (async () => {
        for (let reopened = 0; ; reopened += 1) {
          let first = true;
          const stream = client.events((event) => {
            if (first) {
              opened();
              // Only once the stream is open again: an ask sent between an earlier read and the stream's opening would be seen nowhere.
              if (reopened > 0) void this.missedAsks(server, client);
            }
            first = false;
            this.onEvent(server, client, event);
          }, this.streams.signal);
          await stream.catch((error: Error) => console.warn(`opencode: its event stream failed: ${error.message}`));
          opened();
          if (!this.current(server)) return;
          if (reopened === REOPENS) {
            console.error('opencode: its event stream closed and did not open again');
            void server.kill();
            return this.end({ code: null, signal: null, error: 'opencode closed its event stream', stderr: '' });
          }
          await new Promise((resolve) => setTimeout(resolve, REOPEN_MS));
          if (!this.current(server)) return;
        }
      })();
    });
  }

  private async missedAsks(server: OpencodeServer, client: OpencodeClient): Promise<void> {
    try {
      const pending = await client.get('/permission');
      if (!this.current(server) || !Array.isArray(pending)) return;
      for (const ask of pending) if (isRecord(ask) && !this.seen.has(String(ask.id))) this.asked(server, client, ask);
    } catch (error) {
      console.warn(`opencode: could not list the asks: ${(error as Error).message}`);
    }
  }

  private onEvent(server: OpencodeServer, client: OpencodeClient, { type, properties }: SseEvent): void {
    if (!this.current(server)) return;
    if (type === 'session.created') return this.created(properties);
    if (type === 'permission.asked') return this.asked(server, client, properties);
    if (type === 'permission.replied') return this.replied(properties);
    if (type === 'question.asked') return void this.questioned(server, client, properties);
    const provider = type === 'session.error' && properties.sessionID === this.sessionId ? this.unconnected(properties.error) : null;
    if (provider !== null) return this.refuse(this.launch.providerHint(provider));
    // Between turns opencode only says what a stopped turn left behind: a second idle, a stopped tool's end.
    if (this.turnOpen) this.dispatch(this.events.handle({ type, properties }));
  }

  // 1.19 says "Model not found: <provider>/<model>. Did you mean: …" both for a provider it has not connected and for a model its provider lacks.
  private unconnected(error: unknown): string | null {
    const message = isRecord(error) && isRecord(error.data) && typeof error.data.message === 'string' ? error.data.message : '';
    const provider = MODEL_NOT_FOUND.exec(message)?.[1];
    if (provider === undefined) return null;
    return this.catalog.some((model) => parseModelId(model.value)?.model.startsWith(`${provider}/`)) ? null : provider;
  }

  // Tripwire: a root session CodeRay did not open means someone else uses this server's password.
  private created(properties: Record<string, unknown>): void {
    const info = isRecord(properties.info) ? properties.info : {};
    if (typeof info.id !== 'string') return;
    // 1.19's root session has no parentID at all.
    if (info.parentID == null) {
      if (!this.ownSessions.has(info.id)) {
        this.unclaimed.push(info.id);
        this.claimRoots();
      }
      return;
    }
    if (typeof info.parentID === 'string' && this.ownSessions.has(info.parentID)) this.own(info.id, info.parentID);
  }

  private claimRoots(): void {
    if (this.creating > 0) return;
    const foreign = this.unclaimed.find((id) => !this.ownSessions.has(id));
    this.unclaimed = [];
    if (foreign !== undefined) this.refuse(`Something created a session on this chat's opencode server besides CodeRay (${foreign}), so the chat was stopped.`);
  }

  private own(sessionID: string, parentID: string): void {
    this.ownSessions.add(sessionID);
    this.events.adopt(sessionID, parentID);
  }

  private asked(server: OpencodeServer, client: OpencodeClient, properties: unknown): void {
    const ask = readAsk(properties);
    if (ask === null) {
      const id = isRecord(properties) && typeof properties.id === 'string' ? properties.id : null;
      console.warn(`opencode: rejected an ask CodeRay cannot read (${String(id)})`);
      if (id !== null && !this.seen.has(id)) {
        this.seen.add(id);
        this.answer(client, id, { reply: 'reject' });
      }
      return;
    }
    if (this.seen.has(ask.id)) return;
    this.seen.add(ask.id);
    const controller = new AbortController();
    this.asks.set(ask.id, controller);
    void this.judge(server, client, ask, controller).finally(() => {
      if (this.asks.get(ask.id) === controller) this.asks.delete(ask.id);
    });
  }

  private async judge(server: OpencodeServer, client: OpencodeClient, ask: Ask, controller: AbortController): Promise<void> {
    let reply: Reply | null;
    try {
      // Only a turn CodeRay follows, of the chat's own sessions, asks the user.
      if (!this.turnOpen || !(this.ownSessions.has(ask.sessionID) || (await this.ownedParent(client, ask.sessionID)))) {
        console.warn(`opencode: rejected the ${ask.permission} ask ${ask.id} of a session or a turn this chat does not follow`);
        reply = { reply: 'reject' };
      } else {
        const input = await this.inputOf(ask, controller.signal);
        if (controller.signal.aborted) return;
        reply = await judgeAsk(askCalls(ask, input, this.launch.cwd, this.subagents, this.ownSessions, this.launch.servers), this.launch.decide, controller.signal);
      }
    } catch (error) {
      console.warn(`opencode: rejected the ask ${ask.id}: ${(error as Error).message}`);
      reply = { reply: 'reject' };
    }
    if (reply === null || controller.signal.aborted || !this.current(server)) return;
    this.answer(client, ask.id, reply);
  }

  // 1.19 may ask about a bash call a moment before it says the call runs, and only the running call names its workdir.
  private async inputOf(ask: Ask, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (ask.callID === null) return undefined;
    const end = Date.now() + INPUT_WAIT_MS;
    while (ask.permission === 'bash' && this.events.input(ask.callID) === undefined && Date.now() < end && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, INPUT_POLL_MS));
    }
    return this.events.input(ask.callID);
  }

  // A session CodeRay has not seen created (a subagent resumed by task_id) is the chat's when its parents lead to it.
  private async ownedParent(client: OpencodeClient, sessionID: string): Promise<boolean> {
    const chain = [sessionID];
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const info = await client.get(`/session/${encodeURIComponent(chain.at(-1)!)}`);
      const parent = isRecord(info) && typeof info.parentID === 'string' ? info.parentID : null;
      if (parent === null) return false;
      if (this.ownSessions.has(parent)) {
        chain.push(parent);
        for (let index = chain.length - 2; index >= 0; index -= 1) this.own(chain[index]!, chain[index + 1]!);
        return true;
      }
      chain.push(parent);
    }
    return false;
  }

  private answer(client: OpencodeClient, id: string, reply: Reply): void {
    this.answered.add(id);
    client.post(`/permission/${id}/reply`, reply).catch((error: Error) => console.warn(`opencode: could not answer the ask ${id}: ${error.message}`));
  }

  // Tripwire: opencode rejects a session's other asks along with one CodeRay rejected; any other answer is someone else's.
  private replied(properties: Record<string, unknown>): void {
    const id = properties.requestID;
    if (typeof id === 'string' && this.answered.has(id)) return;
    if (typeof id === 'string' && this.seen.has(id) && properties.reply === 'reject') {
      this.asks.get(id)?.abort();
      return;
    }
    this.refuse(`Something answered opencode's asks besides CodeRay (permission ${String(id)}), so the chat was stopped.`);
  }

  private async questioned(server: OpencodeServer, client: OpencodeClient, properties: Record<string, unknown>): Promise<void> {
    const { id, sessionID, questions } = properties;
    if (typeof id !== 'string') return;
    // A subagent resumed by task_id may ask before it asks for a tool: its parents say whether it is the chat's.
    const owned = typeof sessionID === 'string' && (this.ownSessions.has(sessionID) || (await this.ownedParent(client, sessionID).catch(() => false)));
    if (!this.current(server)) return;
    if (!this.turnOpen || !owned || !Array.isArray(questions) || !questions.every(isQuestion)) {
      console.warn(`opencode: declined the question ${id}, which is not the chat's or cannot be read`);
      client.post(`/question/${id}/reject`).catch((error: Error) => console.warn(`opencode: could not decline the question ${id}: ${error.message}`));
      return;
    }
    this.questions.set(id, questions);
    const input = { questions: questions.map((question) => ({ question: question.question, header: question.header, options: question.options, multiSelect: question.multiple === true })) };
    this.emit([{ type: 'control_request', requestId: id, subtype: 'can_use_tool', toolName: 'AskUserQuestion', input }]);
  }

  // The asks and questions still open: answered no, and the user is no longer asked.
  private rejectOpen(): void {
    const client = this.client;
    for (const [id, controller] of this.asks) {
      // An aborted one opencode already rejected along with another.
      if (controller.signal.aborted) continue;
      controller.abort();
      if (client !== null) this.answer(client, id, { reply: 'reject' });
    }
    this.asks.clear();
    for (const id of this.questions.keys()) {
      this.emit([{ type: 'control_cancel', requestId: id }]);
      client?.post(`/question/${id}/reject`).catch((error: Error) => console.warn(`opencode: could not decline the question ${id}: ${error.message}`));
    }
    this.questions.clear();
  }

  private dispatch(events: StreamEvent[]): void {
    this.emit(events);
    if (events.some((event) => event.type === 'result')) this.turnEnded();
  }

  private turnEnded(): void {
    this.turnOpen = false;
    this.interrupting = false;
    clearTimeout(this.interruptTimer);
    this.rejectOpen();
    this.settleTurn();
  }

  // Stop's fallback when no idle came: the turn ends as stopped, its open calls cut off (a busy status first, so a stray idle cannot swallow it).
  private settleStop(): void {
    const chat = { sessionID: this.sessionId };
    this.events.handle({ type: 'session.status', properties: { ...chat, status: { type: 'busy' } } });
    this.dispatch(this.events.handle({ type: 'session.idle', properties: chat }));
  }

  private enqueue(pending: Pending): void {
    this.chain = this.chain.then(() => this.turn(pending)).catch((error: unknown) => console.error('opencode: could not send a message', error));
  }

  // One message at a time (Q12b: 1.19 folds a prompt sent during a turn into it): the next goes after session.idle.
  private async turn(pending: Pending): Promise<void> {
    if (this.refused || this.stopping || this.ended || pending.stop !== this.stops) return;
    if (!this.ready) {
      this.queue.push(pending);
      return;
    }
    const server = this.server;
    const client = this.client!;
    const live = (): boolean => this.current(server) && pending.stop === this.stops;
    let session: string;
    try {
      // Before every prompt: a layer the server merged since the last one could let a write through.
      const problem = await this.check(client);
      if (!this.current(server)) return;
      if (problem !== null) return this.refuse(problem);
      if (!live()) return;
      session = await this.openSession(client);
      if (!live()) return;
    } catch (error) {
      if (live()) this.emit([{ type: 'notice', text: `opencode did not take the message: ${(error as Error).message}` }, FAILED]);
      return;
    }
    const done = new Promise<void>((resolve) => {
      this.settleTurn = resolve;
    });
    this.turnOpen = true;
    this.emit(this.events.turnStarted());
    try {
      await Promise.race([this.prompt(client, session, pending.message), done]);
      // A Stop that came while the prompt was on its way stops the turn it started.
      if (pending.stop !== this.stops && this.current(server)) client.post(`/session/${session}/abort`).catch(() => {});
    } catch (error) {
      if (this.current(server) && this.turnOpen) this.dispatch([{ type: 'notice', text: `opencode did not take the message: ${(error as Error).message}` }, FAILED]);
    }
    await done;
  }

  // The session opens with the first message: a chat opened and never used leaves none in the user's opencode.
  private openSession(client: OpencodeClient): Promise<string> {
    this.opening ??= this.open(client).catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async open(client: OpencodeClient): Promise<string> {
    const stored = this.launch.resume ? this.launch.engineSessionId : '';
    const id = stored !== '' && (await this.resumable(client, stored)) ? stored : await this.create(client);
    this.sessionId = id;
    this.events.session(id, this.model, this.version, this.contextOf(this.model));
    return id;
  }

  // Only a session of this directory under exactly CodeRay's rules goes on: any other would run calls those rules ask about.
  private async resumable(client: OpencodeClient, id: string): Promise<boolean> {
    let info: unknown = null;
    try {
      info = await client.get(`/session/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (isRecord(info) && info.directory === this.launch.cwd && JSON.stringify(info.permission) === JSON.stringify(ruleset())) {
      this.ownSessions.add(id);
      return true;
    }
    this.emit([{ type: 'notice', text: `opencode has no record of this chat's session ${id} with CodeRay's rules, so the chat goes on in a new session, without what was said before.` }]);
    return false;
  }

  private async create(client: OpencodeClient): Promise<string> {
    this.creating += 1;
    try {
      const info = await client.post('/session', { permission: ruleset() });
      if (!isRecord(info) || typeof info.id !== 'string') throw new Error('opencode opened no session it could name');
      this.ownSessions.add(info.id);
      return info.id;
    } finally {
      this.creating -= 1;
      this.claimRoots();
    }
  }

  // "/name rest" of a listed command runs it (Q10: its model one string, its answer at the turn's end, `system` dropped by 1.19); anything else is a prompt.
  private prompt(client: OpencodeClient, session: string, { message }: UserMessage): Promise<unknown> {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    const variant = this.variant();
    const only = blocks.length === 1 ? blocks[0] : undefined;
    const skill = only?.type === 'text' ? SKILL.exec(only.text.trim()) : null;
    if (skill !== null && this.skillList.includes(skill[1]!)) {
      const body = { command: skill[1], arguments: skill[2]?.trim() ?? '', agent: AGENT, ...(this.model === null ? {} : { model: this.model }), ...variant };
      return client.post(`/session/${session}/command`, body, 0);
    }
    const parts = blocks.map((block) => (block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'file', mime: block.source.media_type, url: `data:${block.source.media_type};base64,${block.source.data}`, filename: 'image' }));
    return client.post(`/session/${session}/prompt_async`, { agent: AGENT, parts, ...modelRef(this.model), ...variant, system: this.launch.system });
  }

  // Only an effort the model lists as a variant: 1.19 accepts any name and ignores one it does not know.
  private variant(): { variant?: string } {
    const effort = this.launch.effort;
    return effort !== null && this.entry(this.model)?.efforts.includes(effort) ? { variant: effort } : {};
  }

  private entry(model: string | null): CatalogModel | undefined {
    return model === null ? undefined : this.catalog.find((candidate) => parseModelId(candidate.value)?.model === model);
  }

  private contextOf(model: string | null): number | null {
    return this.entry(model)?.context ?? null;
  }

  private release(): void {
    this.ready = false;
    this.queue = [];
    this.turnOpen = false;
    clearTimeout(this.interruptTimer);
    for (const controller of this.asks.values()) controller.abort();
    this.asks.clear();
    this.questions.clear();
    this.streams.abort();
    this.settleSkills([]);
    this.settleTurn();
  }

  // Fail closed: a refused chat runs nothing more on its server.
  private refuse(reason: string): void {
    if (this.refused || this.stopping || this.ended) return;
    this.refused = true;
    this.release();
    this.emit([{ type: 'refused', reason }]);
    void this.server.kill();
  }

  private end(exit: ProcessExit): void {
    if (this.ended) return;
    this.ended = true;
    this.release();
    this.finish(exit);
  }

  private emit(events: StreamEvent[]): void {
    for (const event of events) this.sink.event(this.scrub(event));
  }

  private hide(text: string): string {
    return this.secrets.reduce((shown, secret) => shown.replaceAll(secret, '…'), text);
  }

  // A call's input as the row shows it: every string in it.
  private hideIn(value: unknown): unknown {
    if (typeof value === 'string') return this.hide(value);
    if (Array.isArray(value)) return value.map((item) => this.hideIn(item));
    return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.hideIn(item)])) : value;
  }

  private scrub(event: StreamEvent): StreamEvent {
    switch (event.type) {
      case 'notice':
        return { ...event, text: this.hide(hideSecrets(event.text)) };
      case 'refused':
        return { ...event, reason: this.hide(hideSecrets(event.reason)) };
      case 'text_delta':
        return { ...event, text: this.hide(event.text) };
      case 'assistant':
        return { ...event, blocks: event.blocks.map((block) => (block.kind === 'tool_use' ? { ...block, input: this.hideIn(block.input) } : { ...block, text: this.hide(block.text) })) };
      case 'user':
        return { ...event, toolResults: event.toolResults.map((result) => ({ ...result, text: this.hide(result.text) })) };
      default:
        return event;
    }
  }
}
