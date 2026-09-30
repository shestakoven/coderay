import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ChatItem, McpServerState, PromptAnswer, PromptBody, SessionPatch, SessionServerMessage, SessionState, SessionView, TaskView, TurnView,
} from '@ide/protocol';
import { CANARY_MS } from '../gate/canary';
import { projectDir, runDir } from '../home';
import { commandLine, forceKill, isAlive, signal } from '../os-process';
import type { MessageRecord, PromptRecord, SessionRecord, Store, ToolDecisionRecord, ToolEventRecord } from '../store/store';
import { KILL_GRACE_MS, startClaude, type ClaudeCommand, type ClaudeProcess, type ProcessExit } from './claude-process';
import { answerProblem, parsePromptBody, PROMPT_TOOLS, promptResponse } from './prompts';
import { parseStreamLine, type StreamEvent } from './stream';
import { DISALLOWED_TOOLS, isOlderVersion, MIN_CLAUDE_VERSION, summarizeToolInput } from './tools';
import { TurnTracker, type Change, type ToolEndInfo } from './tracker';

export type McpServers = Record<string, object>;

export interface SessionGate {
  write(sessionId: string): { settingsPath: string };
  remove(sessionId: string): void;
  systemPrompt(): string;
  canary?: { expect(sessionId: string): void; wait(sessionId: string, ms: number): Promise<boolean> };
}

export interface AgentSessionOptions {
  root: string;
  home: string;
  store: Store;
  claude: ClaudeCommand;
  mcpServers?: () => McpServers;
  killGraceMs?: number;
  gate?: SessionGate;
  canaryMs?: number;
}

const HOOK_OFF_NOTICE =
  "The IDE's hook did not start, so the agent was not started. Claude Code settings (a managed policy or disableAllHooks) may be switching hooks off.";

const SESSION_ERRORS = {
  'turn-open': 'The agent is busy. Wait for the turn to end, press Stop to end it, or Restart to also end background tasks.',
  empty: 'Type a message first.',
  restarting: 'The session is restarting. Try again in a moment.',
  'prompt-gone': 'That question is no longer waiting for an answer.',
  'bad-answer': 'That answer does not fit the question.',
  'no-gate': 'The IDE could not prepare the hook settings for claude, so the agent was not started.',
  'hook-off': HOOK_OFF_NOTICE,
};

export type SessionErrorCode = keyof typeof SESSION_ERRORS;

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string = SESSION_ERRORS[code]) {
    super(message);
    this.code = code;
  }
}

type ExitReason = 'restart' | 'new' | 'close';
type SessionUpdate = Partial<Pick<SessionRecord, 'status' | 'pid' | 'launchId'>>;

interface PendingPrompt {
  input: unknown;
  body: PromptBody;
}

const RUN_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STALE_POLL_MS = 50;

export class AgentSession {
  private readonly options: AgentSessionOptions;
  private readonly listeners = new Set<(message: SessionServerMessage) => void>();
  private readonly reportedUnknown = new Set<string>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly decisions = new Map<string, ToolDecisionRecord>();
  private readonly idleListeners = new Set<() => void>();
  private readonly exitListeners = new Set<() => void>();
  private readonly toolEndListeners = new Set<(toolUseId: string) => void>();
  private readonly userMessageListeners = new Set<() => void>();
  private readonly toolResultListeners = new Set<(info: ToolEndInfo) => void>();
  private readonly taskEndListeners = new Set<(toolUseId: string) => void>();
  private session: SessionRecord | null = null;
  private tracker = new TurnTracker();
  private turns = new Map<string, TurnView>();
  private items = new Map<string, ChatItem>();
  private tasks = new Map<string, TaskView>();
  private mcpServers: McpServerState[] = [];
  private permissionMode: string | null = null;
  private process: ClaudeProcess | null = null;
  private exitReason: ExitReason | null = null;
  private terminating = false;
  private versionChecked = false;
  private idle = true;
  private hookReady = true;
  private refused = false;
  private pendingSends: string[] = [];

  constructor(options: AgentSessionOptions) {
    this.options = options;
  }

  onMessage(listener: (message: SessionServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    const latest = this.options.store.latestSession();
    if (!latest || latest.status === 'ended') return;
    if (latest.status === 'running') {
      await stopStale(latest, this.options.killGraceMs ?? KILL_GRACE_MS);
      rmSync(this.configPath(latest.id), { force: true });
      this.options.gate?.remove(latest.id);
    }
    this.load(latest);
    this.apply(this.tracker.processExited());
    if (latest.status === 'running') this.update({ status: 'crashed', pid: null, launchId: null });
  }

  state(): SessionState {
    return {
      session: this.session ? sessionView(this.session, this.permissionMode) : null,
      turns: [...this.turns.values()],
      items: [...this.items.values()].sort((a, b) => a.seq - b.seq),
      tasks: [...this.tasks.values()],
      mcpServers: this.mcpServers,
    };
  }

  sessionId(): string | null {
    return this.session?.id ?? null;
  }

  isIdle(): boolean {
    return !this.tracker.hasOpenTurn() && ![...this.tasks.values()].some((task) => task.endedAt === null);
  }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }

  onProcessExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onToolEnd(listener: (toolUseId: string) => void): () => void {
    this.toolEndListeners.add(listener);
    return () => this.toolEndListeners.delete(listener);
  }

  onToolResult(listener: (info: ToolEndInfo) => void): () => void {
    this.toolResultListeners.add(listener);
    return () => this.toolResultListeners.delete(listener);
  }

  onTaskEnd(listener: (toolUseId: string) => void): () => void {
    this.taskEndListeners.add(listener);
    return () => this.taskEndListeners.delete(listener);
  }

  runningSubagents(): number {
    return this.openTasks('subagent');
  }

  runningShell(): boolean {
    return this.openTasks('shell') + this.openTasks('monitor') > 0;
  }

  onUserMessage(listener: () => void): () => void {
    this.userMessageListeners.add(listener);
    return () => this.userMessageListeners.delete(listener);
  }

  recordDecision(record: ToolDecisionRecord): void {
    const session = this.session;
    if (!session) return;
    this.persist(() => this.options.store.saveToolDecision(session.id, record));
    this.decisions.set(record.toolUseId, record);
    const item = this.items.get(record.toolUseId);
    if (item?.kind !== 'tool') return;
    const updated: ChatItem = { ...item, decision: record.decision, targets: record.targets };
    this.items.set(updated.id, updated);
    this.emit({ type: 'session.patch', patch: { items: [updated] } });
  }

  lastMessage(): string | null {
    const open = new Set([...this.turns.values()].filter((turn) => turn.closedAt === null).map((turn) => turn.id));
    return this.assistantText([...this.items.values()].filter((item) => item.turnId !== null && open.has(item.turnId)));
  }

  context(toolUseId: string): { parentToolUseId: string | null; lastMessage: string | null } {
    const tool = this.items.get(toolUseId);
    if (tool?.kind !== 'tool') return { parentToolUseId: null, lastMessage: this.lastMessage() };
    const before = [...this.items.values()].filter((item) => item.seq < tool.seq && item.turnId === tool.turnId && item.parentToolUseId === tool.parentToolUseId);
    return { parentToolUseId: tool.parentToolUseId, lastMessage: this.assistantText(before) };
  }

  private assistantText(items: ChatItem[]): string | null {
    const message = items.sort((a, b) => a.seq - b.seq).findLast((item) => item.kind === 'message' && item.role === 'assistant');
    return message?.kind === 'message' ? message.text : null;
  }

  send(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    if (this.terminating) throw new SessionError('restarting');
    if (this.refused) throw new SessionError('hook-off');
    if (this.tracker.hasOpenTurn()) throw new SessionError('turn-open');
    if (!this.session || this.session.status === 'ended') this.begin();
    if (!this.process) this.spawn();
    if (!this.process) throw new SessionError('no-gate');
    notify(this.userMessageListeners);
    if (this.hookReady) this.process.write(userMessage(text));
    else this.pendingSends.push(text);
    this.apply(this.tracker.userMessage(text));
  }

  stop(): boolean {
    if (!this.process || !this.tracker.canInterrupt()) return false;
    this.process.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
    return true;
  }

  answerPrompt(requestId: string, answer: PromptAnswer): void {
    const pending = this.pendingPrompts.get(requestId);
    if (!pending || !this.process) throw new SessionError('prompt-gone');
    const problem = answerProblem(pending.body, answer);
    if (problem) throw new SessionError('bad-answer', problem);
    this.pendingPrompts.delete(requestId);
    this.process.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: promptResponse(pending.input, answer) },
    });
    this.apply(this.tracker.promptAnswered(requestId, answer));
  }

  async restart(): Promise<void> {
    await this.terminate('restart');
    this.clearRefusal();
  }

  async newSession(): Promise<void> {
    await this.terminate('new');
    this.clearRefusal();
    if (this.session && this.session.status !== 'ended') this.update({ status: 'ended' });
    this.reset(null);
  }

  async close(): Promise<void> {
    await this.terminate('close');
  }

  private clearRefusal(): void {
    if (!this.refused) return;
    this.refused = false;
    if (this.session?.status === 'refused') this.update({ status: 'stopped' });
  }

  private async awaitCanary(child: ClaudeProcess, sessionId: string, canary: NonNullable<SessionGate['canary']>): Promise<void> {
    const reported = await canary.wait(sessionId, this.options.canaryMs ?? CANARY_MS);
    if (this.process !== child) return;
    if (reported) {
      this.hookReady = true;
      for (const text of this.pendingSends.splice(0)) child.write(userMessage(text));
      return;
    }
    this.pendingSends = [];
    this.refused = true;
    this.apply(this.tracker.notice(HOOK_OFF_NOTICE));
    await this.terminate('close');
  }

  private begin(): void {
    const session: SessionRecord = {
      id: randomUUID(), claudeSessionId: randomUUID(), cwd: this.options.root, status: 'stopped', model: null, cliVersion: null,
      pid: null, launchId: null, conversationStarted: false, startedAt: Date.now(),
    };
    this.persist(() => this.options.store.saveSession(session));
    this.reset(session);
  }

  private reset(session: SessionRecord | null): void {
    this.session = session;
    this.tracker = new TurnTracker();
    this.turns = new Map();
    this.items = new Map();
    this.tasks = new Map();
    this.mcpServers = [];
    this.permissionMode = null;
    this.pendingPrompts.clear();
    this.decisions.clear();
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  private load(session: SessionRecord): void {
    const history = this.options.store.history(session.id);
    const lastSeq = [...history.messages, ...history.toolEvents, ...history.prompts].reduce((max, record) => Math.max(max, record.seq), 0);
    this.session = session;
    this.turns = new Map(history.turns.map((turn) => [turn.id, turn]));
    this.decisions.clear();
    for (const decision of history.decisions) this.decisions.set(decision.toolUseId, decision);
    this.items = new Map([
      ...history.messages.map(messageItem),
      ...history.toolEvents.map((event) => toolItem(event, this.options.root, this.decisions.get(event.toolUseId))),
      ...history.prompts.map(promptItem),
    ].map((item) => [item.id, item]));
    this.tasks = new Map(history.tasks.map((task) => [task.id, task]));
    this.tracker = new TurnTracker({
      nextSeq: lastSeq + 1,
      open: {
        turns: history.turns.filter((turn) => turn.closedAt === null),
        tools: history.toolEvents.filter((event) => event.endedAt === null),
        tasks: history.tasks.filter((task) => task.endedAt === null),
        prompts: history.prompts.filter((prompt) => prompt.status === 'pending'),
      },
    });
  }

  private spawn(): void {
    const session = this.session;
    if (!session) return;
    let gateArgs: string[] = [];
    if (this.options.gate) {
      try {
        const { settingsPath } = this.options.gate.write(session.id);
        gateArgs = ['--settings', settingsPath, '--append-system-prompt', this.options.gate.systemPrompt(), '--system-prompt-snapshot', 'off'];
      } catch (error) {
        console.error('agent: could not write the hook settings', error);
        this.apply(this.tracker.notice(`The IDE could not write the hook settings for claude (${(error as Error).message}), so the agent was not started.`));
        return;
      }
    }
    const dir = runDir(this.options.home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, RUN_DIR_MODE);
    const configPath = this.configPath(session.id);
    rmSync(configPath, { force: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: this.options.mcpServers?.() ?? {} }), { mode: PRIVATE_FILE_MODE });
    const child = startClaude(this.options.claude, claudeArgs(session, configPath, gateArgs), session.cwd, (line) => this.onLine(line), {
      killGraceMs: this.options.killGraceMs,
    });
    this.process = child;
    this.exitReason = null;
    this.versionChecked = false;
    this.update({ status: 'running', pid: child.pid ?? null, launchId: session.claudeSessionId });
    const canary = this.options.gate?.canary;
    this.hookReady = canary === undefined;
    this.pendingSends = [];
    if (canary) {
      canary.expect(session.id);
      void this.awaitCanary(child, session.id, canary).catch((error: unknown) => console.error('agent: could not check the hook canary', error));
    }
    void child.exited.then((exit) => this.onExit(child, exit)).catch((error: unknown) => console.error('agent: could not process claude exit', error));
  }

  private onLine(line: string): void {
    try {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.type === 'unknown') {
        if (!this.reportedUnknown.has(event.label)) console.warn(`agent: ignoring unknown stream event "${event.label}"`);
        this.reportedUnknown.add(event.label);
        return;
      }
      this.apply(this.handle(event));
    } catch (error) {
      console.error('agent: could not handle a stream event', error);
    }
  }

  private handle(event: StreamEvent): Change[] {
    if (event.type === 'control_request') return this.controlRequest(event);
    const changes = this.tracker.event(event);
    if (event.type === 'init' && !this.versionChecked) {
      this.versionChecked = true;
      if (event.cliVersion !== null && isOlderVersion(event.cliVersion, MIN_CLAUDE_VERSION)) {
        changes.push(...this.tracker.notice(
          `claude ${event.cliVersion} is older than ${MIN_CLAUDE_VERSION}, the version the IDE was verified with; tool names and stream events may differ.`,
        ));
      }
    }
    return changes;
  }

  private controlRequest(event: Extract<StreamEvent, { type: 'control_request' }>): Change[] {
    const asksUser = event.subtype === 'can_use_tool' && event.toolName !== null && PROMPT_TOOLS.includes(event.toolName);
    const body = asksUser ? parsePromptBody(event.toolName, event.input) : null;
    if (body) {
      this.pendingPrompts.set(event.requestId, { input: event.input, body });
      return this.tracker.prompt(event.requestId, body);
    }
    const reason = event.subtype === 'can_use_tool'
      ? `The IDE does not answer permission prompts for ${event.toolName ?? 'this tool'}.`
      : `The IDE does not handle "${event.subtype}" requests.`;
    console.warn(`agent: refused a ${event.subtype} request from claude: ${reason}`);
    const response = event.subtype === 'can_use_tool'
      ? { subtype: 'success', request_id: event.requestId, response: { behavior: 'deny', message: reason } }
      : { subtype: 'error', request_id: event.requestId, error: reason };
    this.process?.write({ type: 'control_response', response });
    return this.tracker.notice(`Refused a "${event.subtype}" request from claude: ${reason}`);
  }

  private onExit(child: ClaudeProcess, exit: ProcessExit): void {
    if (this.process !== child || !this.session) return;
    this.process = null;
    this.terminating = false;
    rmSync(this.configPath(this.session.id), { force: true });
    this.options.gate?.remove(this.session.id);
    const reason = this.exitReason;
    this.apply(this.tracker.processExited());
    if (reason === null) this.apply(this.tracker.notice(crashNotice(exit)));
    const status = reason === null ? 'crashed' : reason === 'new' ? 'ended' : this.refused ? 'refused' : 'stopped';
    this.update({ status, pid: null, launchId: null });
    notify(this.exitListeners);
  }

  private async terminate(reason: ExitReason): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.terminating = true;
    this.exitReason = reason;
    await child.kill();
  }

  private update(changes: SessionUpdate): void {
    if (!this.session) return;
    const session = { ...this.session, ...changes };
    this.session = session;
    this.persist(() => this.options.store.saveSession(session));
    this.emit({ type: 'session.patch', patch: { session: sessionView(session, this.permissionMode) } });
  }

  private apply(changes: Change[]): void {
    const session = this.session;
    if (!session || changes.length === 0) return;
    const store = this.options.store;
    const patch: SessionPatch = {};
    const ended: string[] = [];
    const endedTasks: string[] = [];
    for (const change of changes) {
      if (change.kind === 'turn') {
        this.persist(() => store.saveTurn(session.id, change.turn));
        this.turns.set(change.turn.id, change.turn);
        (patch.turns ??= []).push(change.turn);
      } else if (change.kind === 'message') {
        this.persist(() => store.saveMessage(session.id, change.message));
        const item = messageItem(change.message);
        this.items.set(item.id, item);
        (patch.items ??= []).push(item);
      } else if (change.kind === 'tool') {
        this.persist(() => store.saveToolEvent(session.id, change.tool));
        const item = toolItem(change.tool, this.options.root, this.decisions.get(change.tool.toolUseId));
        this.items.set(item.id, item);
        (patch.items ??= []).push(item);
        if (change.tool.endedAt !== null) ended.push(change.tool.toolUseId);
      } else if (change.kind === 'task') {
        this.persist(() => store.saveTask(session.id, change.task));
        if (change.task.endedAt !== null && change.task.toolUseId !== null && this.tasks.get(change.task.id)?.endedAt === null) endedTasks.push(change.task.toolUseId);
        this.tasks.set(change.task.id, change.task);
        (patch.tasks ??= []).push(change.task);
      } else if (change.kind === 'prompt') {
        this.persist(() => store.savePrompt(session.id, change.prompt));
        if (change.prompt.status !== 'pending') this.pendingPrompts.delete(change.prompt.requestId);
        const item = promptItem(change.prompt);
        this.items.set(item.id, item);
        (patch.items ??= []).push(item);
      } else if (change.kind === 'mode') {
        this.permissionMode = change.permissionMode;
        patch.session = sessionView(this.session ?? session, change.permissionMode);
      } else {
        const updated: SessionRecord = {
          ...(this.session ?? session),
          claudeSessionId: change.claudeSessionId || session.claudeSessionId,
          model: change.model,
          cliVersion: change.cliVersion,
          conversationStarted: true,
        };
        this.session = updated;
        this.persist(() => store.saveSession(updated));
        this.mcpServers = change.mcpServers;
        patch.session = sessionView(updated, this.permissionMode);
        patch.mcpServers = change.mcpServers;
      }
    }
    this.emit({ type: 'session.patch', patch });
    for (const toolUseId of ended) {
      notify(this.toolEndListeners, toolUseId);
      const info = this.tracker.endInfo(toolUseId);
      if (info) notify(this.toolResultListeners, info);
    }
    for (const toolUseId of endedTasks) notify(this.taskEndListeners, toolUseId);
    this.checkIdle();
  }

  private openTasks(kind: TaskView['kind']): number {
    return [...this.tasks.values()].filter((task) => task.kind === kind && task.endedAt === null).length;
  }

  private checkIdle(): void {
    const idle = this.isIdle();
    if (idle && !this.idle) notify(this.idleListeners);
    this.idle = idle;
  }

  private persist(write: () => void): void {
    try {
      write();
    } catch (error) {
      console.error('agent: could not save session history', error);
    }
  }

  private emit(message: SessionServerMessage): void {
    notify(this.listeners, message);
  }

  private configPath(sessionId: string): string {
    return join(runDir(this.options.home), `${basename(projectDir(this.options.home, this.options.root))}-${sessionId}.mcp.json`);
  }
}

function notify<Args extends unknown[]>(listeners: Set<(...args: Args) => void>, ...args: Args): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch (error) {
      console.error('agent: a session listener threw', error);
    }
  }
}

function userMessage(text: string): object {
  return { type: 'user', message: { role: 'user', content: text } };
}

function claudeArgs(session: SessionRecord, mcpConfigPath: string, gateArgs: string[]): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    session.conversationStarted ? '--resume' : '--session-id', session.claudeSessionId,
    '--mcp-config', mcpConfigPath, '--strict-mcp-config',
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    ...gateArgs,
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
  ];
}

function sessionView(session: SessionRecord, permissionMode: string | null): SessionView {
  return {
    id: session.id, claudeSessionId: session.claudeSessionId, status: session.status,
    model: session.model, cliVersion: session.cliVersion, permissionMode, startedAt: session.startedAt,
  };
}

function messageItem(message: MessageRecord): ChatItem {
  const base = { id: message.id, seq: message.seq, turnId: message.turnId, parentToolUseId: message.parentToolUseId, text: message.text, ts: message.ts };
  return message.role === 'notice' ? { kind: 'notice', ...base } : { kind: 'message', role: message.role, ...base };
}

function toolItem(event: ToolEventRecord, root: string, decision?: ToolDecisionRecord): ChatItem {
  return {
    kind: 'tool', id: event.toolUseId, seq: event.seq, turnId: event.turnId, parentToolUseId: event.parentToolUseId,
    tool: event.tool, summary: summarizeToolInput(event.input, root), status: event.status, startedAt: event.toolUseAt, endedAt: event.endedAt,
    decision: decision?.decision ?? null, targets: decision?.targets ?? [],
  };
}

function promptItem(prompt: PromptRecord): ChatItem {
  return {
    kind: 'prompt', id: prompt.requestId, seq: prompt.seq, turnId: prompt.turnId, parentToolUseId: prompt.parentToolUseId,
    body: prompt.body, status: prompt.status, answer: prompt.answer, ts: prompt.ts,
  };
}

function crashNotice(exit: ProcessExit): string {
  const reason = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
  const lastLine = exit.stderr.trim().split('\n').at(-1);
  return `claude stopped unexpectedly (${reason})${lastLine ? `: ${lastLine}` : ''}`;
}

async function stopStale(session: SessionRecord, graceMs: number): Promise<void> {
  const { pid, launchId } = session;
  if (pid === null || launchId === null) return;
  const launchedWith = new RegExp(`--(?:session-id|resume) ${launchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  const isStale = () => launchedWith.test(commandLine(pid) ?? '');
  if (!isStale()) return;
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, STALE_POLL_MS));
  if (isAlive(pid) && isStale()) forceKill(pid);
}
