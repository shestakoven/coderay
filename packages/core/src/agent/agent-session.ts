import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EFFORT_LEVELS, EMPTY_USAGE,
  type ChatImage, type ChatItem, type ChatSummary, type EffortLevel, type McpServerState, type PromptAnswer, type PromptBody, type SessionPatch, type SessionServerMessage,
  type SessionState, type SessionView, type TaskView, type TurnView, type UsageView,
} from '@ide/protocol';
import { CANARY_MS } from '../gate/canary';
import { defaultTranscriptsDir, largest, recoverTranscript, UNCLEAN_STOP_KEY } from '../watchdog/recovery';
import { projectDir, runDir } from '../home';
import { commandLine, forceKill, isAlive, signal } from '../os-process';
import type { MessageRecord, PromptRecord, SessionRecord, Store, ToolDecisionRecord, ToolEventRecord } from '../store/store';
import { KILL_GRACE_MS, startClaude, type ClaudeCommand, type ClaudeProcess, type ProcessExit } from './claude-process';
import { answerProblem, parsePromptBody, PROMPT_TOOLS, promptResponse } from './prompts';
import { parseStreamLine, type StreamEvent } from './stream';
import { parseUsage } from './usage';
import { DISALLOWED_TOOLS, isModelChoice, isOlderVersion, MIN_CLAUDE_VERSION, summarizeToolInput } from './tools';
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
  transcriptsDir?: string;
  canLeave?: () => string | null;
}

const ACTIVE_SESSION_KEY = 'activeSessionId';

const HOOK_OFF_NOTICE =
  "The IDE's hook did not start, so the agent was not started. Claude Code settings (a managed policy or disableAllHooks) may be switching hooks off.";

const GAP_NOTICE = "Calls made while the core was down may be missing; claude's transcript could not be read.";

const SESSION_ERRORS = {
  'turn-open': 'The agent is busy. Wait for the turn to end, press Stop to end it, or Restart to also end background tasks.',
  empty: 'Type a message first.',
  restarting: 'The session is restarting. Try again in a moment.',
  'prompt-gone': 'That question is no longer waiting for an answer.',
  'bad-answer': 'That answer does not fit the question.',
  'no-gate': 'The IDE could not prepare the hook settings for claude, so the agent was not started.',
  'hook-off': HOOK_OFF_NOTICE,
  'no-turn': 'The agent has no open turn to add a note to.',
  'busy-configure': 'Wait for the agent to finish or press Stop before changing the model.',
  'busy-switch': 'Wait for the agent to finish or press Stop before switching chats.',
  'bad-model': 'That model name is not valid.',
  'bad-effort': 'That effort level is not valid.',
  'no-chat': 'That chat does not exist.',
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
type SessionUpdate = Partial<Pick<SessionRecord, 'status' | 'pid' | 'launchId' | 'modelChoice' | 'effort'>>;

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
  private readonly userMessageListeners = new Set<() => void>();
  private readonly toolResultListeners = new Set<(info: ToolEndInfo) => void>();
  private readonly taskEndListeners = new Set<(toolUseId: string) => void>();
  private readonly turnClosedListeners = new Set<() => void>();
  private readonly interruptListeners = new Set<() => void>();
  private readonly newSessionListeners = new Set<() => void>();
  private started = false;
  private session: SessionRecord | null = null;
  private previous: SessionRecord | null = null;
  private tracker = new TurnTracker();
  private turns = new Map<string, TurnView>();
  private items = new Map<string, ChatItem>();
  private tasks = new Map<string, TaskView>();
  private mcpServers: McpServerState[] = [];
  private permissionMode: string | null = null;
  private usage: UsageView = EMPTY_USAGE;
  private process: ClaudeProcess | null = null;
  private exitReason: ExitReason | null = null;
  private terminating = false;
  private versionChecked = false;
  private idle = true;
  private hookReady = true;
  private refused = false;
  private pendingSends: object[] = [];
  private notes: string[] = [];
  private crashed = false;

  constructor(options: AgentSessionOptions) {
    this.options = options;
  }

  onMessage(listener: (message: SessionServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasStarted(): boolean {
    return this.started;
  }

  onNewSession(listener: () => void): () => boolean {
    this.newSessionListeners.add(listener);
    return () => this.newSessionListeners.delete(listener);
  }

  toolStamp(toolUseId: string): { planId: string; planVersion: number; stepKey: string | null } | null {
    const decision = this.decisions.get(toolUseId);
    if (!decision || decision.planId === null || decision.planVersion === null) return null;
    return { planId: decision.planId, planVersion: decision.planVersion, stepKey: decision.stepKey };
  }

  async start(): Promise<void> {
    try {
      await this.loadLatest();
    } finally {
      this.started = true;
    }
  }

  private async loadLatest(): Promise<void> {
    const { store } = this.options;
    const activeId = store.meta(ACTIVE_SESSION_KEY);
    const latest = activeId === '' ? null : (activeId ? store.session(activeId) : null) ?? store.latestSession();
    if (!latest || latest.status === 'ended') {
      this.previous = latest ?? store.latestSession();
      return;
    }
    if (latest.status === 'running') this.options.store.setMeta(UNCLEAN_STOP_KEY, '1');
    this.crashed = this.options.store.meta(UNCLEAN_STOP_KEY) === '1';
    if (latest.status === 'running') {
      await stopStale(latest, this.options.killGraceMs ?? KILL_GRACE_MS);
      rmSync(this.configPath(latest.id), { force: true });
      this.options.gate?.remove(latest.id);
    }
    const gap = latest.status === 'running' ? await this.recoverChat(latest) : null;
    this.load(latest);
    this.apply(this.tracker.processExited());
    for (const id of gap?.ids ?? []) {
      const item = this.items.get(id);
      if (item?.kind === 'message' || item?.kind === 'tool') this.items.set(id, { ...item, recovered: true });
    }
    if (gap?.unreadable) this.apply(this.tracker.notice(GAP_NOTICE));
    if (latest.status === 'running') this.update({ status: 'crashed', pid: null, launchId: null });
  }

  startedFromCrash(): boolean {
    return this.crashed;
  }

  private async recoverChat(session: SessionRecord): Promise<{ ids: string[]; unreadable: boolean }> {
    const { store } = this.options;
    try {
      const history = store.history(session.id);
      const since = largest([
        ...history.messages.map((m) => m.ts),
        ...history.toolEvents.flatMap((t) => [t.toolUseAt, t.endedAt ?? 0]),
      ]);
      const recovered = await recoverTranscript({
        claudeSessionId: session.claudeSessionId, cwd: session.cwd, since, dir: this.options.transcriptsDir ?? defaultTranscriptsDir(),
      });
      if (recovered.unreadable) return { ids: [], unreadable: true };
      const messageIds = new Set(history.messages.map((m) => m.id));
      const storedTools = new Map(history.toolEvents.map((t) => [t.toolUseId, t]));
      let seq = largest([...history.messages.map((m) => m.seq), ...history.toolEvents.map((t) => t.seq), ...history.prompts.map((p) => p.seq)]);
      const ids: string[] = [];
      for (const item of recovered.items) {
        if (item.kind === 'message') {
          if (messageIds.has(item.id)) continue;
          seq += 1;
          store.saveMessage(session.id, { id: item.id, seq, turnId: null, parentToolUseId: null, role: 'assistant', text: item.text, ts: item.ts });
          ids.push(item.id);
          continue;
        }
        const stored = storedTools.get(item.toolUseId);
        if (stored) {
          const open = stored.status === 'running' || stored.status === 'unfinished';
          if (open && (item.status === 'ok' || item.status === 'error')) store.saveToolEvent(session.id, { ...stored, status: item.status, endedAt: item.endedAt });
          continue;
        }
        seq += 1;
        store.saveToolEvent(session.id, {
          toolUseId: item.toolUseId, seq, turnId: null, parentToolUseId: null, tool: item.tool, input: item.input,
          status: item.status, toolUseAt: item.toolUseAt, endedAt: item.endedAt,
        });
        ids.push(item.toolUseId);
      }
      return { ids, unreadable: false };
    } catch (error) {
      console.error('agent: could not recover the chat from claude\'s transcript', error);
      return { ids: [], unreadable: true };
    }
  }

  state(): SessionState {
    return {
      session: this.session ? sessionView(this.session, this.permissionMode) : null,
      turns: [...this.turns.values()],
      items: [...this.items.values()].sort((a, b) => a.seq - b.seq),
      tasks: [...this.tasks.values()],
      mcpServers: this.mcpServers,
      usage: this.usage,
    };
  }

  sessionId(): string | null {
    return this.session?.id ?? null;
  }

  listChats(): { activeId: string | null; sessions: ChatSummary[] } {
    return { activeId: this.session?.id ?? null, sessions: this.options.store.listSessions() };
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

  onToolResult(listener: (info: ToolEndInfo) => void): () => void {
    this.toolResultListeners.add(listener);
    return () => this.toolResultListeners.delete(listener);
  }

  onTaskEnd(listener: (toolUseId: string) => void): () => void {
    this.taskEndListeners.add(listener);
    return () => this.taskEndListeners.delete(listener);
  }

  hasOpenTurn(): boolean {
    return this.tracker.hasOpenTurn();
  }

  processAlive(): boolean {
    return this.process !== null;
  }

  onInterrupt(listener: () => void): () => boolean {
    this.interruptListeners.add(listener);
    return () => this.interruptListeners.delete(listener);
  }

  hasLiveTask(toolUseId: string): boolean {
    return [...this.tasks.values()].some((task) => task.toolUseId === toolUseId && task.endedAt === null);
  }

  toolInfo(toolUseId: string): { tool: string; summary: string; stepKey: string | null } | undefined {
    const item = this.items.get(toolUseId);
    if (item?.kind !== 'tool') return undefined;
    return { tool: item.tool, summary: item.summary, stepKey: this.decisions.get(toolUseId)?.stepKey ?? null };
  }

  onTurnClosed(listener: () => void): () => boolean {
    this.turnClosedListeners.add(listener);
    return () => this.turnClosedListeners.delete(listener);
  }

  runningSubagents(): number {
    return this.openTasks('subagent');
  }

  runningSubagentNames(): string[] {
    return [...this.tasks.values()].filter((task) => task.kind === 'subagent' && task.endedAt === null).map((task) => task.description);
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

  send(text: string, options: { fromUser?: boolean; images?: ChatImage[] } = {}): void {
    const images = options.images ?? [];
    if (text.trim() === '' && images.length === 0) throw new SessionError('empty');
    if (this.terminating) throw new SessionError('restarting');
    if (this.refused) throw new SessionError('hook-off');
    if (this.tracker.hasOpenTurn()) throw new SessionError('turn-open');
    if (!this.session || this.session.status === 'ended') this.begin();
    if (!this.process) this.spawn();
    if (!this.process) throw new SessionError('no-gate');
    if (options.fromUser !== false) notify(this.userMessageListeners);
    const notes = this.notes.splice(0);
    const message = userMessage([...notes, text].filter((part) => part !== '').join('\n\n'), images);
    try {
      if (this.hookReady) this.process.write(message);
      else this.pendingSends.push(message);
    } catch (error) {
      this.notes.unshift(...notes);
      throw error;
    }
    this.apply(this.tracker.userMessage(images.length > 0 ? [text, `[${images.length} image${images.length > 1 ? 's' : ''} attached]`].filter((part) => part !== '').join('\n') : text));
    for (const note of notes) this.apply(this.tracker.notice(note));
  }

  notice(text: string): void {
    this.apply(this.tracker.notice(text));
  }

  queueNote(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    this.notes.push(text);
  }

  sendAbsorbed(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    if (this.terminating) throw new SessionError('restarting');
    if (this.refused) throw new SessionError('hook-off');
    if (!this.process) throw new SessionError('no-gate', 'The agent is not running.');
    if (!this.tracker.hasOpenTurn()) throw new SessionError('no-turn');
    if (this.hookReady) this.process.write(userMessage(text, []));
    else this.pendingSends.push(userMessage(text, []));
    this.apply(this.tracker.notice('IDE note sent to the agent'));
  }

  stop(): boolean {
    if (!this.process || !this.tracker.canInterrupt()) return false;
    this.process.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
    notify(this.interruptListeners);
    return true;
  }

  interrupt(): boolean {
    return this.stop();
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
    this.notes = [];
    notify(this.newSessionListeners);
    this.previous = this.session ?? this.previous;
    this.setActive('');
    this.reset(null);
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.options.store.session(id)) throw new SessionError('no-chat');
    if (this.session?.id !== id) {
      this.options.store.deleteSession(id);
      return;
    }
    await this.discardActive(() => this.options.store.deleteSession(id));
  }

  async deleteAllSessions(): Promise<void> {
    await this.discardActive(() => this.options.store.deleteAllSessions());
  }

  async switchSession(id: string): Promise<void> {
    if (this.session?.id === id) return;
    const target = this.options.store.session(id);
    if (!target) throw new SessionError('no-chat');
    if (this.terminating) throw new SessionError('restarting');
    if (!this.isIdle()) throw new SessionError('busy-switch');
    const blocked = this.options.canLeave?.() ?? null;
    if (blocked !== null) throw new SessionError('busy-switch', blocked);
    await this.terminate('close');
    this.clearRefusal();
    this.notes = [];
    notify(this.newSessionListeners);
    this.load(target);
    this.apply(this.tracker.processExited());
    // An ended chat is reopened so the next message resumes it instead of starting a new one.
    if (target.status === 'ended' || target.status === 'running' || target.status === 'refused') this.update({ status: 'stopped', pid: null, launchId: null });
    this.setActive(target.id);
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  async configure(modelChoice: string | null, effort: EffortLevel | null): Promise<void> {
    if (modelChoice !== null && !isModelChoice(modelChoice)) throw new SessionError('bad-model');
    if (effort !== null && !EFFORT_LEVELS.includes(effort)) throw new SessionError('bad-effort');
    if (this.terminating) throw new SessionError('restarting');
    if (!this.isIdle()) throw new SessionError('busy-configure');
    if (!this.session || this.session.status === 'ended') this.begin();
    if (this.session?.modelChoice === modelChoice && this.session.effort === effort) return;
    this.update({ modelChoice, effort });
    if (this.process) await this.restart();
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
      for (const message of this.pendingSends.splice(0)) child.write(message);
      return;
    }
    this.pendingSends = [];
    this.refused = true;
    this.apply(this.tracker.notice(HOOK_OFF_NOTICE));
    await this.terminate('close');
  }

  private begin(): void {
    const from = this.session ?? this.previous;
    const session: SessionRecord = {
      id: randomUUID(), claudeSessionId: randomUUID(), cwd: this.options.root, status: 'stopped', model: null,
      modelChoice: from?.modelChoice ?? 'sonnet', effort: from?.effort ?? 'medium', cliVersion: null,
      pid: null, launchId: null, conversationStarted: false, startedAt: Date.now(),
    };
    this.persist(() => this.options.store.saveSession(session));
    this.setActive(session.id);
    this.reset(session);
  }

  private setActive(id: string): void {
    this.persist(() => this.options.store.setMeta(ACTIVE_SESSION_KEY, id));
  }

  private reset(session: SessionRecord | null): void {
    this.session = session;
    this.tracker = new TurnTracker();
    this.turns = new Map();
    this.items = new Map();
    this.tasks = new Map();
    this.mcpServers = [];
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, fiveHour: this.usage.fiveHour, sevenDay: this.usage.sevenDay };
    this.pendingPrompts.clear();
    this.decisions.clear();
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  private load(session: SessionRecord): void {
    const history = this.options.store.history(session.id);
    const lastSeq = [...history.messages, ...history.toolEvents, ...history.prompts].reduce((max, record) => Math.max(max, record.seq), 0);
    this.session = session;
    this.turns = new Map(history.turns.map((turn) => [turn.id, turn]));
    this.mcpServers = [];
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, fiveHour: this.usage.fiveHour, sevenDay: this.usage.sevenDay };
    this.pendingPrompts.clear();
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
      this.trackUsage(line);
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

  private trackUsage(line: string): void {
    const update = parseUsage(line, this.session?.model ?? null);
    if (!update) return;
    const usage = { ...this.usage, ...update };
    if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
    this.usage = usage;
    this.emit({ type: 'session.patch', patch: { usage } });
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

  private async discardActive(remove: () => void): Promise<void> {
    await this.terminate('close');
    this.clearRefusal();
    remove();
    this.notes = [];
    notify(this.newSessionListeners);
    this.previous = this.session ?? this.previous;
    this.setActive('');
    this.reset(null);
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
    let turnClosed = false;
    for (const change of changes) {
      if (change.kind === 'turn') {
        this.persist(() => store.saveTurn(session.id, change.turn));
        const before = this.turns.get(change.turn.id);
        if (change.turn.closedAt !== null && change.turn.resultSubtype !== 'crashed' && (before === undefined || before.closedAt === null)) turnClosed = true;
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
      const info = this.tracker.endInfo(toolUseId);
      if (info) notify(this.toolResultListeners, info);
    }
    for (const toolUseId of endedTasks) notify(this.taskEndListeners, toolUseId);
    if (turnClosed) notify(this.turnClosedListeners);
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

function userMessage(text: string, images: ChatImage[]): object {
  if (images.length === 0) return { type: 'user', message: { role: 'user', content: text } };
  const blocks = images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }));
  return { type: 'user', message: { role: 'user', content: text === '' ? blocks : [...blocks, { type: 'text', text }] } };
}

function claudeArgs(session: SessionRecord, mcpConfigPath: string, gateArgs: string[]): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    session.conversationStarted ? '--resume' : '--session-id', session.claudeSessionId,
    ...(session.modelChoice !== null && isModelChoice(session.modelChoice) ? ['--model', session.modelChoice] : []),
    ...(session.effort !== null && EFFORT_LEVELS.includes(session.effort) ? ['--effort', session.effort] : []),
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
    model: session.model, modelChoice: session.modelChoice, effort: session.effort, cliVersion: session.cliVersion, permissionMode, startedAt: session.startedAt,
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
