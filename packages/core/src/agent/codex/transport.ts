import { isRecord } from '../../json';
import type { ProcessExit } from '../claude-process';
import type { StreamEvent } from '../stream';
import { isOlderVersion, MIN_CODEX_VERSION } from '../tools';
import type { AgentTransport, CodexLaunch, GateCall, TransportSink, UserMessage } from '../transport';
import { handshake, startAppServer, type AppServer } from './app-server';
import { approvalReply, commandCall, elicitationCall, elicitationReply, fileChangeCalls, judge, NO_PERMISSIONS } from './approvals';
import { CodexEvents } from './events';
import type {
  ApprovalResponse, CommandExecutionRequestApprovalParams, ConfigReadResponse, ElicitationResponse, FileChangeRequestApprovalParams, GetAccountResponse,
  JsonValue, McpServerElicitationRequestParams, RequestId, SkillMetadata, SkillsListResponse, ThreadStartResponse, TurnStartResponse, UserInput,
} from './protocol';
import { RpcError, type Incoming, type IncomingRequest } from './rpc';

// Sent on every thread/start, thread/resume and turn/start: a resume or a turn without them keeps or changes the policy of before.
const THREAD_POLICY = { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
const TURN_POLICY = { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
// Whatever the launch says: the user's apps and plugins bring servers and tools CodeRay does not own.
const FEATURES_OFF = { 'features.apps': false, 'features.plugins': false } as const;
// The variables that carry CodeRay's MCP secrets in the app-server's environment, kept out of the model's shell commands.
const SECRET_VARIABLES = 'CODERAY_*';
// A server name a dotted config key can switch off.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
// Stop ends a turn that never says it ended after this long.
const INTERRUPT_SETTLE_MS = 5_000;
const NOT_HANDLED = -32601;
const SKILL = /^\/(\S+)(?:\s+([\s\S]*))?$/;
// Codex's userAgent: "<client>/<version> (…)".
const VERSION = /\/(\d+\.\d+\.\d+)/;
// What 0.160.0 answers a resume of a thread it keeps no record of: one that never ran a turn, or one the user deleted.
const NO_ROLLOUT = /^no rollout found for thread id /;
const INTERRUPTED: StreamEvent = { type: 'result', subtype: 'error_during_execution', origin: null };

type Reply = (verdict: 'accept' | 'decline') => ApprovalResponse | ElicitationResponse;
// The requests the gate answers, each with its whitelisted reply.
const GATED = new Map<string, Reply>([
  ['item/fileChange/requestApproval', approvalReply],
  ['item/commandExecution/requestApproval', approvalReply],
  ['mcpServer/elicitation/request', elicitationReply],
]);

export function startCodexTransport(launch: CodexLaunch, sink: TransportSink): AgentTransport {
  return new CodexTransport(launch, sink);
}

/** Why the echo of thread/start or thread/resume is not the policy CodeRay asked for; null when it is. */
function policyProblem(answer: ThreadStartResponse): string | null {
  if (!isRecord(answer) || !isRecord(answer.thread) || typeof answer.thread.id !== 'string') return 'Codex opened no thread it could name, so the chat was not started.';
  const echoed: Record<string, unknown> = isRecord(answer.sandbox) ? answer.sandbox : {};
  const sandbox = echoed.type;
  // Every recorded 0.160.0 echo says networkAccess false; one that leaves it out says nothing more.
  const network = echoed.networkAccess;
  const offline = network === undefined || network === false;
  // A sub-agent only when the user asks for one: the mode every recorded 0.160.0 echo reports.
  const agents = answer.multiAgentMode ?? 'explicitRequestOnly';
  if (sandbox === 'readOnly' && offline && answer.approvalPolicy === 'on-request' && answer.approvalsReviewer === 'user' && agents === 'explicitRequestOnly') return null;
  return `Codex reported sandbox ${String(sandbox)}${offline ? '' : ` with network access ${JSON.stringify(network)}`}, approvals ${JSON.stringify(answer.approvalPolicy)} by ${String(answer.approvalsReviewer)} and sub-agents ${JSON.stringify(agents)}, not read-only with every write sent to CodeRay, so the chat was not started.`;
}

interface Pending { message: UserMessage; stop: number }

class CodexTransport implements AgentTransport {
  readonly exited: Promise<ProcessExit>;
  private readonly launch: CodexLaunch;
  private readonly sink: TransportSink;
  private readonly events = new CodexEvents();
  private readonly ours: Set<string>;
  private readonly requests = new Map<RequestId, AbortController>();
  private readonly skillsReady: Promise<SkillMetadata[]>;
  // A turn/start answer read after its turn's end must not make that turn current again.
  private readonly endedTurns = new Set<string>();
  private settleSkills!: (skills: SkillMetadata[]) => void;
  private finish!: (exit: ProcessExit) => void;
  private server!: AppServer;
  private threadId: string | null;
  private threadParams: { cwd: string; developerInstructions: string; config: Record<string, JsonValue> } | null = null;
  private opening: Promise<boolean> | null = null;
  private turnId: string | null = null;
  private model: string | null;
  private skillList: SkillMetadata[] = [];
  // Messages for the next app-server that passes its checks.
  private queue: Pending[] = [];
  private chain: Promise<void> = Promise.resolve();
  // The app-server passed its checks and is not being replaced: messages go to it.
  private ready = false;
  private refused = false;
  private stopping = false;
  private ended = false;
  private interrupting = false;
  private interruptTimer: NodeJS.Timeout | undefined;
  private restarting: Promise<ProcessExit> | null = null;
  // Every Stop counts: a message sent before it never starts a turn after it.
  private stops = 0;
  private starting = false;
  private stopRequested = false;

  constructor(launch: CodexLaunch, sink: TransportSink) {
    this.launch = launch;
    this.sink = sink;
    this.ours = new Set(launch.servers);
    this.threadId = launch.resume ? launch.engineSessionId : null;
    this.model = launch.model;
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.skillsReady = new Promise((resolve) => {
      this.settleSkills = resolve;
    });
    this.start();
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
    if (this.interrupting || this.stopping || this.refused) return;
    this.stops += 1;
    // Codex has not named the turn yet: one being started is stopped as soon as it has an id; with none in flight the turn ends here.
    if (this.turnId !== null) this.stopTurn(this.turnId);
    else if (this.starting) this.deferStop();
    else this.emit([INTERRUPTED]);
  }

  stopTask(): void {}

  respond(): void {}

  setModel(model: string | null): Promise<void> {
    this.model = model;
    this.events.setModel(model);
    return Promise.resolve();
  }

  async skills(): Promise<string[]> {
    return (await this.skillsReady).map((skill) => skill.name);
  }

  kill(): Promise<ProcessExit> {
    this.stopping = true;
    this.ready = false;
    this.queue = [];
    clearTimeout(this.interruptTimer);
    this.abortRequests();
    if (this.restarting === null) void this.server.kill();
    return this.exited;
  }

  private start(): void {
    const server = startAppServer(this.launch.codex, {
      cwd: this.launch.cwd, env: this.launch.env, pidDir: this.launch.pidDir, killGraceMs: this.launch.killGraceMs,
      onNotification: (message) => this.notification(server, message),
      onRequest: (message) => void this.request(server, message),
    });
    this.server = server;
    this.opening = null;
    this.endedTurns.clear();
    void server.exited.then((exit) => {
      // A restart after Stop replaces the app-server on purpose; any other exit ends the chat's agent.
      if (this.server === server && this.restarting === null) this.end(exit);
    });
    void this.boot(server);
  }

  // Messages and answers go only to the app-server the chat runs on now, never to one Stop or a refusal is replacing.
  private current(server: AppServer): boolean {
    return this.server === server && this.restarting === null && !this.stopping && !this.ended && !this.refused;
  }

  private async boot(server: AppServer): Promise<void> {
    try {
      const hello = await handshake(server.rpc);
      const version = VERSION.exec(hello.userAgent)?.[1];
      if (!this.current(server)) return;
      if (version === undefined) return this.refuse(`CodeRay cannot read Codex version in ${JSON.stringify(hello.userAgent)}, so it cannot tell it is ${MIN_CODEX_VERSION} or newer: update Codex to run it in CodeRay.`);
      if (isOlderVersion(version, MIN_CODEX_VERSION)) return this.refuse(`codex ${version} is older than ${MIN_CODEX_VERSION}, the version CodeRay was verified with: update Codex to run it in CodeRay.`);
      void this.loadSkills(server);
      const account = await server.rpc.request<GetAccountResponse>('account/read', { refreshToken: false });
      if (!this.current(server)) return;
      if (!isRecord(account) || !isRecord(account.account)) return this.refuse(this.launch.signedOutHint);
      const answer = await server.rpc.request<ConfigReadResponse>('config/read', { cwd: this.launch.cwd, includeLayers: false });
      if (!this.current(server)) return;
      const config = this.threadConfig(isRecord(answer) && isRecord(answer.config) ? answer.config : {});
      if (typeof config === 'string') return this.refuse(config);
      this.threadParams = { cwd: this.launch.cwd, developerInstructions: this.launch.developerInstructions, config };
      this.ready = true;
      for (const pending of this.queue.splice(0)) this.enqueue(pending);
    } catch (error) {
      if (this.current(server)) this.refuse(`Codex did not start: ${(error as Error).message}`);
    }
  }

  /**
   * The thread config: the launch's, every server the user's and the project's Codex configuration define switched off by name
   * (only those: a name nobody defines stops the app-server), and CodeRay's secrets added to the user's own shell exclusions.
   * A string says why the chat cannot run.
   */
  private threadConfig(effective: Record<string, JsonValue>): Record<string, JsonValue> | string {
    const servers = isRecord(effective.mcp_servers) ? Object.keys(effective.mcp_servers) : [];
    const clash = servers.find((name) => this.ours.has(name));
    if (clash !== undefined) return `Your Codex configuration defines an MCP server named "${clash}", as CodeRay does: rename yours to run Codex in CodeRay.`;
    const odd = servers.find((name) => !SERVER_NAME.test(name));
    if (odd !== undefined) return `Your Codex configuration defines an MCP server named ${JSON.stringify(odd)}, which CodeRay cannot switch off: rename yours to run Codex in CodeRay.`;
    const policy = isRecord(effective.shell_environment_policy) ? effective.shell_environment_policy : {};
    const excluded = Array.isArray(policy.exclude) ? policy.exclude.filter((pattern): pattern is string => typeof pattern === 'string') : [];
    return {
      ...this.launch.config,
      ...FEATURES_OFF,
      ...Object.fromEntries(servers.map((name) => [`mcp_servers.${name}.enabled`, false])),
      'shell_environment_policy.exclude': [...new Set([...excluded, SECRET_VARIABLES])],
    };
  }

  private async loadSkills(server: AppServer): Promise<void> {
    try {
      const answer = await server.rpc.request<SkillsListResponse>('skills/list', { cwds: [this.launch.cwd] });
      this.skillList = answer.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
    } catch (error) {
      if (this.current(server)) console.error('codex: could not list the skills', error);
    }
    this.events.setSkills(this.skillList.map((skill) => skill.name));
    this.settleSkills(this.skillList);
  }

  // The thread opens with the first message of each app-server: a chat opened and never used leaves no thread in the user's Codex history.
  private openThread(): Promise<boolean> {
    const server = this.server;
    this.opening ??= this.open(server).catch((error: unknown) => {
      if (this.server === server) this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async open(server: AppServer): Promise<boolean> {
    const params = { ...this.threadParams, ...(this.model === null ? {} : { model: this.model }), ...THREAD_POLICY };
    const answer = this.threadId === null ? await server.rpc.request<ThreadStartResponse>('thread/start', params) : await this.resume(server, params);
    if (!this.current(server)) return false;
    const wrong = policyProblem(answer);
    if (wrong !== null) {
      this.refuse(wrong);
      return false;
    }
    this.threadId = answer.thread.id;
    this.events.thread(answer.thread.id, this.model ?? answer.model, answer.thread.cliVersion);
    return true;
  }

  private async resume(server: AppServer, params: object): Promise<ThreadStartResponse> {
    try {
      // A resume answers with the thread's whole history unless told not to; the chat has it already.
      return await server.rpc.request<ThreadStartResponse>('thread/resume', { ...params, threadId: this.threadId, excludeTurns: true });
    } catch (error) {
      if (!(error instanceof RpcError) || !NO_ROLLOUT.test(error.message) || !this.current(server)) throw error;
      this.emit([{ type: 'notice', text: `Codex has no record of this chat's thread ${this.threadId}, so the chat goes on in a new thread, without what was said before.` }]);
      return server.rpc.request<ThreadStartResponse>('thread/start', params);
    }
  }

  private notification(server: AppServer, { method, params }: Incoming): void {
    if (!this.current(server)) return;
    if (method === 'mcpServer/startupStatus/updated' && isRecord(params) && typeof params.name === 'string' && !this.ours.has(params.name)) {
      this.refuse(`An MCP server CodeRay did not configure started in this chat (${params.name}), so the chat was stopped.`);
      return;
    }
    if (method === 'serverRequest/resolved' && isRecord(params) && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
      this.requests.get(params.requestId)?.abort();
    }
    // A sub-agent's turns run on the same app-server: only the chat's own thread starts and ends its turns.
    const turn = isRecord(params) && params.threadId === this.threadId && isRecord(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : null;
    if (method === 'turn/started' && turn !== null) this.turnId = turn;
    this.emit(this.events.handle(method, params));
    if (method === 'turn/completed' && turn !== null) this.turnEnded(turn);
    else if (method === 'turn/started' && turn !== null) this.stopIfRequested();
  }

  // A thread or turn codex is still starting is stopped once it has an id, or with its app-server when codex keeps it waiting.
  private deferStop(): void {
    this.stopRequested = true;
    clearTimeout(this.interruptTimer);
    const server = this.server;
    this.interruptTimer = setTimeout(() => {
      if (!this.stopRequested || this.server !== server) return;
      this.stopRequested = false;
      this.emit([INTERRUPTED]);
      void this.restart();
    }, INTERRUPT_SETTLE_MS);
  }

  private stopTurn(turnId: string): void {
    this.interrupting = true;
    // Stop replaces this app-server: a message sent meanwhile waits for the next one.
    this.ready = false;
    // A held approval stays unanswered: nothing the gate says after Stop reaches codex.
    this.abortRequests();
    clearTimeout(this.interruptTimer);
    const server = this.server;
    void server.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {});
    this.interruptTimer = setTimeout(() => {
      if (!this.interrupting || this.server !== server) return;
      this.emit(this.events.handle('turn/completed', { threadId: this.threadId, turn: { id: turnId, status: 'interrupted', error: null } }));
      this.turnEnded(turnId);
    }, INTERRUPT_SETTLE_MS);
  }

  private stopIfRequested(): void {
    if (!this.stopRequested || this.turnId === null) return;
    this.settleDeferredStop();
    this.stopTurn(this.turnId);
  }

  private settleDeferredStop(): void {
    this.stopRequested = false;
    clearTimeout(this.interruptTimer);
  }

  private turnEnded(turnId: string): void {
    this.endedTurns.add(turnId);
    this.turnId = null;
    clearTimeout(this.interruptTimer);
    this.abortRequests();
    if (!this.interrupting) return;
    this.interrupting = false;
    void this.restart();
  }

  // Stop: shell commands an interrupted turn started live until the app-server gets SIGTERM; the next message resumes the thread in a new one.
  private async restart(): Promise<void> {
    if (this.stopping || this.refused || this.restarting !== null) return;
    this.ready = false;
    this.restarting = this.server.kill();
    const exit = await this.restarting;
    this.restarting = null;
    if (this.stopping) this.end(exit);
    else this.start();
  }

  private end(exit: ProcessExit): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    clearTimeout(this.interruptTimer);
    this.abortRequests();
    this.settleSkills([]);
    this.finish(exit);
  }

  // One message at a time: a second waits until codex has answered the first's turn/start, so it steers that turn.
  private enqueue(pending: Pending): void {
    this.chain = this.chain.then(() => this.turn(pending)).catch((error: unknown) => console.error('codex: could not send a message', error));
  }

  private async turn(pending: Pending): Promise<void> {
    if (this.refused || this.stopping || this.ended || pending.stop !== this.stops) return;
    if (!this.ready) {
      this.queue.push(pending);
      return;
    }
    const server = this.server;
    let started: string | null;
    this.starting = true;
    try {
      started = await this.deliver(server, pending);
    } catch (error) {
      if (this.stopRequested) this.settleDeferredStop();
      if (this.current(server)) this.emit([{ type: 'notice', text: `Codex did not take the message: ${(error as Error).message}` }, { type: 'result', subtype: 'failed', origin: null }]);
      return;
    } finally {
      this.starting = false;
    }
    // A Stop that came while the message was on its way gets its result: the turn it started is stopped, or the message ends here.
    const requested = this.stopRequested;
    if (requested) this.settleDeferredStop();
    if (!requested || !this.current(server)) return;
    if (this.turnId !== null) this.stopTurn(this.turnId);
    else if (started === null || !this.endedTurns.has(started)) this.emit([INTERRUPTED]);
  }

  // Starts a turn with the message, or steers the turn running; the id of the turn it started, if it started one.
  private async deliver(server: AppServer, { message, stop }: Pending): Promise<string | null> {
    if (!(await this.openThread())) return null;
    // A /name of the project is a skill only once the list is known.
    await this.skillsReady;
    if (this.stopRequested || stop !== this.stops || !this.current(server)) return null;
    const input = this.inputOf(message);
    if (this.turnId !== null) {
      // A steer can lose the race with the turn's end; the message then starts the next turn.
      const steered = await server.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input }).then(() => true, () => false);
      if (steered || this.stopRequested || stop !== this.stops || !this.current(server)) return null;
    }
    const answer = await server.rpc.request<TurnStartResponse>('turn/start', {
      threadId: this.threadId, input, ...TURN_POLICY,
      ...(this.model === null ? {} : { model: this.model }), ...(this.launch.effort === null ? {} : { effort: this.launch.effort }),
    });
    const id = isRecord(answer) && isRecord(answer.turn) && typeof answer.turn.id === 'string' ? answer.turn.id : null;
    if (id !== null && this.turnId === null && !this.endedTurns.has(id) && this.current(server)) this.turnId = id;
    return id;
  }

  private async request(server: AppServer, { id, method, params }: IncomingRequest): Promise<void> {
    if (method === 'item/permissions/requestApproval') {
      console.warn('codex: granted no extra permissions; the chat stays read-only');
      server.rpc.reply(id, NO_PERMISSIONS);
      return;
    }
    const reply = GATED.get(method);
    if (reply === undefined) {
      console.warn(`codex: refused the app-server's ${method} request`);
      server.rpc.fail(id, NOT_HANDLED, `CodeRay does not handle ${method}.`);
      return;
    }
    // Stop under way, a refusal or an app-server being replaced: codex ends the request with its turn, and the user is not asked.
    if (!this.answerable(server)) return;
    const controller = new AbortController();
    this.requests.set(id, controller);
    const decide = this.launch.decide;
    let denied = false;
    try {
      const calls = this.gateCalls(method, params);
      const verdict = await judge(calls, decide && (async (call, signal) => {
        const answer = await decide(call, signal);
        if (answer !== null && answer.permissionDecision !== 'allow') denied = true;
        return answer;
      }), controller.signal);
      if (verdict === null || controller.signal.aborted || !this.answerable(server)) return;
      // Only the gate's own no makes a declined MCP call read as refused; no gate or a failure is not the user's answer.
      if (verdict === 'decline' && denied && method === 'mcpServer/elicitation/request' && calls[0]) this.events.reject(calls[0].tool_use_id);
      server.rpc.reply(id, reply(verdict));
    } catch (error) {
      console.error(`codex: could not judge a ${method} request; declined it`, error);
      if (!controller.signal.aborted && this.answerable(server)) server.rpc.reply(id, reply('decline'));
    } finally {
      if (this.requests.get(id) === controller) this.requests.delete(id);
    }
  }

  private answerable(server: AppServer): boolean {
    return this.current(server) && !this.interrupting;
  }

  // The calls a gated request asks about; none (so a decline) when it cannot be read.
  private gateCalls(method: string, params: unknown): GateCall[] {
    if (!isRecord(params)) {
      console.warn(`codex: declined a ${method} request CodeRay cannot read`);
      return [];
    }
    const cwd = this.launch.cwd;
    if (method === 'item/fileChange/requestApproval') {
      const request = params as unknown as FileChangeRequestApprovalParams;
      // The item's latest list of changes (CodexEvents applies item/fileChange/patchUpdated).
      const calls = fileChangeCalls(request, typeof request.itemId === 'string' ? this.events.item(request.itemId) : undefined, cwd);
      if (calls.length === 0 && (request.grantRoot === null || request.grantRoot === undefined)) console.warn('codex: declined a patch whose changes CodeRay cannot read');
      return calls;
    }
    if (method === 'item/commandExecution/requestApproval') {
      const request = params as unknown as CommandExecutionRequestApprovalParams;
      const call = commandCall(request, cwd);
      // A command in a shell the gate cannot read is named by commandCall itself.
      if (call === null && (request.kind !== 'command' || typeof request.command !== 'string' || request.command === '')) {
        console.warn(`codex: declined a ${String(request.kind)} approval that names no command for the gate`);
      }
      return call ? [call] : [];
    }
    const call = elicitationCall(params as unknown as McpServerElicitationRequestParams, this.events.mcpCalls(), cwd);
    if (call === null) console.warn(`codex: declined an elicitation of ${String(params.serverName)} that names no open tool call`);
    return call ? [call] : [];
  }

  private abortRequests(): void {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
  }

  // Fail closed: a refused chat runs nothing more on its app-server, a server CodeRay did not configure least of all.
  private refuse(reason: string): void {
    if (this.refused || this.stopping || this.ended) return;
    this.refused = true;
    this.ready = false;
    this.queue = [];
    this.stopRequested = false;
    clearTimeout(this.interruptTimer);
    this.abortRequests();
    this.settleSkills([]);
    this.emit([{ type: 'refused', reason }]);
    if (this.restarting === null) void this.server.kill();
  }

  private emit(events: StreamEvent[]): void {
    for (const event of events) this.sink.event(event);
  }

  private inputOf(message: UserMessage): UserInput[] {
    const content = message.message.content;
    if (typeof content === 'string') return this.textInput(content);
    return content.flatMap((block) => (block.type === 'image' ? [this.imageInput(block.source.media_type, block.source.data)] : this.textInput(block.text)));
  }

  private imageInput(mediaType: string, data: string): UserInput {
    return { type: 'image', url: `data:${mediaType};base64,${data}` };
  }

  // "/name rest" names a skill of the project: Codex takes it as a skill item, followed by the rest.
  private textInput(text: string): UserInput[] {
    const match = SKILL.exec(text.trim());
    const skill = match ? this.skillList.find((candidate) => candidate.name === match[1]) : undefined;
    const rest = match?.[2]?.trim() ?? '';
    if (!skill) return [{ type: 'text', text, text_elements: [] }];
    return [{ type: 'skill', name: skill.name, path: skill.path }, ...(rest === '' ? [] : [{ type: 'text' as const, text: rest, text_elements: [] as [] }])];
  }
}
