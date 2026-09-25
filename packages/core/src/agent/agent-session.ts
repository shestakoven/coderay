import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ChatItem, McpServerState, PromptAnswer, PromptBody, SessionPatch, SessionServerMessage, SessionState, SessionView, TaskView, TurnView,
} from '@ide/protocol';
import { projectDir, runDir } from '../home';
import { commandLine, forceKill, isAlive, signal } from '../os-process';
import type { MessageRecord, PromptRecord, SessionRecord, Store, ToolEventRecord } from '../store/store';
import { KILL_GRACE_MS, startClaude, type ClaudeCommand, type ClaudeProcess, type ProcessExit } from './claude-process';
import { answerProblem, parsePromptBody, PROMPT_TOOLS, promptResponse } from './prompts';
import { parseStreamLine, type StreamEvent } from './stream';
import { DISALLOWED_TOOLS, isOlderVersion, MIN_CLAUDE_VERSION, summarizeToolInput } from './tools';
import { TurnTracker, type Change } from './tracker';

export type McpServers = Record<string, object>;

export interface AgentSessionOptions {
  root: string;
  home: string;
  store: Store;
  claude: ClaudeCommand;
  mcpServers?: () => McpServers;
  killGraceMs?: number;
}

const SESSION_ERRORS = {
  'turn-open': 'The agent is busy. Wait for the turn to end, press Stop to end it, or Restart to also end background tasks.',
  empty: 'Type a message first.',
  restarting: 'The session is restarting. Try again in a moment.',
  'prompt-gone': 'That question is no longer waiting for an answer.',
  'bad-answer': 'That answer does not fit the question.',
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

  send(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    if (this.terminating) throw new SessionError('restarting');
    if (this.tracker.hasOpenTurn()) throw new SessionError('turn-open');
    if (!this.session || this.session.status === 'ended') this.begin();
    if (!this.process) this.spawn();
    this.process?.write({ type: 'user', message: { role: 'user', content: text } });
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
  }

  async newSession(): Promise<void> {
    await this.terminate('new');
    if (this.session && this.session.status !== 'ended') this.update({ status: 'ended' });
    this.reset(null);
  }

  async close(): Promise<void> {
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
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  private load(session: SessionRecord): void {
    const history = this.options.store.history(session.id);
    const lastSeq = [...history.messages, ...history.toolEvents, ...history.prompts].reduce((max, record) => Math.max(max, record.seq), 0);
    this.session = session;
    this.turns = new Map(history.turns.map((turn) => [turn.id, turn]));
    this.items = new Map([
      ...history.messages.map(messageItem),
      ...history.toolEvents.map((event) => toolItem(event, this.options.root)),
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
    const dir = runDir(this.options.home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, RUN_DIR_MODE);
    const configPath = this.configPath(session.id);
    rmSync(configPath, { force: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: this.options.mcpServers?.() ?? {} }), { mode: PRIVATE_FILE_MODE });
    const child = startClaude(this.options.claude, claudeArgs(session, configPath), session.cwd, (line) => this.onLine(line), {
      killGraceMs: this.options.killGraceMs,
    });
    this.process = child;
    this.exitReason = null;
    this.versionChecked = false;
    this.update({ status: 'running', pid: child.pid ?? null, launchId: session.claudeSessionId });
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
    const reason = this.exitReason;
    this.apply(this.tracker.processExited());
    if (reason === null) this.apply(this.tracker.notice(crashNotice(exit)));
    this.update({ status: reason === null ? 'crashed' : reason === 'new' ? 'ended' : 'stopped', pid: null, launchId: null });
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
        const item = toolItem(change.tool, this.options.root);
        this.items.set(item.id, item);
        (patch.items ??= []).push(item);
      } else if (change.kind === 'task') {
        this.persist(() => store.saveTask(session.id, change.task));
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
  }

  private persist(write: () => void): void {
    try {
      write();
    } catch (error) {
      console.error('agent: could not save session history', error);
    }
  }

  private emit(message: SessionServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private configPath(sessionId: string): string {
    return join(runDir(this.options.home), `${basename(projectDir(this.options.home, this.options.root))}-${sessionId}.mcp.json`);
  }
}

function claudeArgs(session: SessionRecord, mcpConfigPath: string): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    session.conversationStarted ? '--resume' : '--session-id', session.claudeSessionId,
    '--mcp-config', mcpConfigPath, '--strict-mcp-config',
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
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

function toolItem(event: ToolEventRecord, root: string): ChatItem {
  return {
    kind: 'tool', id: event.toolUseId, seq: event.seq, turnId: event.turnId, parentToolUseId: event.parentToolUseId,
    tool: event.tool, summary: summarizeToolInput(event.input, root), status: event.status, startedAt: event.toolUseAt, endedAt: event.endedAt,
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
