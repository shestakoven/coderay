import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EFFORT_LEVELS, EMPTY_USAGE, MAX_CHAT_IMAGES,
  type ChatImage, type ChatItem, type ChatSummary, type EffortLevel, type ImageRef, type McpServerState, type PromptAnswer, type PromptBody, type SessionPatch, type SessionServerMessage,
  type SessionState, type SessionView, type TaskView, type TurnView, type UsageView,
} from '@ide/protocol';
import { CANARY_MS } from '../gate/canary';
import type { TerminalLaunch } from '../terminal/terminal-service';
import { defaultTranscriptsDir, largest, recoverTranscript, transcriptPath, UNCLEAN_STOP_KEY } from '../watchdog/recovery';
import { projectDir, runDir } from '../home';
import { BlobStore, MAX_STORED_IMAGE_BYTES } from '../images/blob-store';
import { commandLine, forceKill, isAlive, signal } from '../os-process';
import type { MessageRecord, PromptRecord, SessionRecord, Store, ToolDecisionRecord, ToolEventRecord } from '../store/store';
import { KILL_GRACE_MS, startClaude, type ClaudeCommand, type ClaudeProcess, type ProcessExit } from './claude-process';
import { answerProblem, parsePromptBody, PROMPT_TOOLS, promptResponse } from './prompts';
import { hookEventInfo, parseHookEvent, parseTranscriptLine, type AgentEvent } from './hook-events';
import { parseStreamLine, type StreamEvent, type ToolResultBlock } from './stream';
import { TranscriptTail } from './transcript-tail';
import { parseUsage } from './usage';
import { DISALLOWED_TOOLS, isModelChoice, isOlderVersion, MIN_CLAUDE_VERSION, summarizeToolInput } from './tools';
import { TurnTracker, type Change, type ToolEndInfo } from './tracker';

export type McpServers = Record<string, object>;

export interface SessionGate {
  write(sessionId: string, events?: boolean): { settingsPath: string };
  remove(sessionId: string): void;
  systemPrompt(): string;
  canary?: { expect(sessionId: string): void; wait(sessionId: string, ms: number): Promise<boolean> };
}

// A session runs under the Claude account it started with: claude looks --resume transcripts up in that account's config directory.
export interface SessionAccounts {
  activeId(): string | null;
  configDir(id: string | null): string | null;
  label(id: string | null): string;
}

export interface AgentSessionOptions {
  root: string;
  home: string;
  store: Store;
  claude: ClaudeCommand;
  accounts?: SessionAccounts;
  mcpServers?: () => McpServers;
  killGraceMs?: number;
  gate?: SessionGate;
  canaryMs?: number;
  // Writes to the agent's terminal; CodeRay only ever sends Esc, to stop a turn.
  terminalInput?: (data: string) => void;
  // A turn CodeRay holds in the terminal waits here for the user's answer; null when nothing holds it.
  holdTurnEnd?: (signal: AbortSignal) => Promise<void> | null;
  // The step the agent started and has not finished, in the plan the gate enforces.
  activeStep?: () => { planId: string; key: string; title: string } | null;
  transcriptsDir?: string;
  canLeave?: () => string | null;
}

const ACTIVE_SESSION_KEY = 'activeSessionId';

const HOOK_OFF_NOTICE =
  "CodeRay's hook did not start, so the agent was not started. Claude Code settings (a managed policy or disableAllHooks) may be switching hooks off.";

const GAP_NOTICE = "Calls made while the core was down may be missing; claude's transcript could not be read.";

const SESSION_ERRORS = {
  empty: 'Type a message first.',
  restarting: 'The session is restarting. Try again in a moment.',
  'prompt-gone': 'That question is no longer waiting for an answer.',
  'bad-answer': 'That answer does not fit the question.',
  'no-gate': 'CodeRay could not prepare the hook settings for claude, so the agent was not started.',
  'hook-off': HOOK_OFF_NOTICE,
  'no-turn': 'The agent has no open turn to add a note to.',
  'busy-configure': 'Wait for the agent to finish or press Stop before changing the model.',
  'busy-switch': 'Wait for the agent to finish or press Stop before switching chats.',
  'busy-account': 'Wait for the agent to finish or press Stop before switching accounts.',
  'bad-model': 'That model name is not valid.',
  'bad-effort': 'That effort level is not valid.',
  'no-chat': 'That chat does not exist.',
  'busy-terminal': 'Wait for the agent to finish or press Stop before opening the terminal.',
  'in-terminal': 'The agent runs in the terminal view. Switch back to the chat to do this.',
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
type SessionUpdate = Partial<Pick<SessionRecord, 'status' | 'pid' | 'launchId' | 'modelChoice' | 'effort' | 'accountId' | 'claudeSessionId' | 'conversationStarted'>>;

interface LaunchFiles {
  claude: ClaudeCommand;
  configPath: string;
  gateArgs: string[];
}

interface PendingPrompt {
  input: unknown;
  body: PromptBody;
}

const RUN_DIR_MODE = 0o700;
const DENIED = new Set(['deny', 'ask-denied']);
const INTERRUPT_KEYS = new Set(['\x1b', '\x03']);
const INTERRUPT_CONFIRM_MS = 5000;
const PRIVATE_FILE_MODE = 0o600;
const STALE_POLL_MS = 50;
const NEVER_ABORTED = new AbortController().signal;
const MAX_RESULT_IMAGES = 8;
const MAX_STORED_BASE64 = Math.ceil(MAX_STORED_IMAGE_BYTES / 3) * 4;

export class AgentSession {
  private readonly options: AgentSessionOptions;
  private readonly blobs: BlobStore;
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
  private readonly titleListeners = new Set<() => void>();
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
  private skills: string[] = [];
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
  private terminalOpen = false;
  private readonly transcriptTail = new TranscriptTail((line) => this.agentEvents(parseTranscriptLine(line)));
  private absorbed: string[] = [];
  private nudgedTurn: string | null = null;
  private readonly nudged = new Set<string>();
  private interruptKeyAt = Number.NEGATIVE_INFINITY;
  private sweepPending = false;
  // After /clear claude names the new conversation in its next init; it has no message of its own until one is sent.
  private clearPending = false;
  private clearedTo: string | null = null;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.blobs = new BlobStore(projectDir(options.home, options.root));
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
    // A crash between deleting a chat and sweeping its images leaves them behind until here.
    this.sweepBlobs();
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
      const recovered = await recoverTranscript({ claudeSessionId: session.claudeSessionId, cwd: session.cwd, since, dir: this.transcriptsDir(session) });
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
      skills: this.skills,
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
    return this.process !== null || this.terminalOpen;
  }

  // The chat's process takes a message after an interrupt; a terminal's input belongs to the user.
  interruptResumes(): boolean {
    return !this.terminalOpen;
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

  onTitleChanged(listener: () => void): () => boolean {
    this.titleListeners.add(listener);
    return () => this.titleListeners.delete(listener);
  }

  // The agent names the active chat; a name the user typed always wins.
  setTitle(title: string): boolean {
    if (!this.session || !this.options.store.setSessionTitle(this.session.id, title, false)) return false;
    notify(this.titleListeners);
    return true;
  }

  renameSession(id: string, title: string): void {
    if (!this.options.store.session(id)) throw new SessionError('no-chat');
    if (!this.options.store.setSessionTitle(id, title, true)) throw new SessionError('empty');
    notify(this.titleListeners);
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
    if (this.terminalOpen && DENIED.has(record.decision)) this.apply(this.tracker.toolRejected(record.toolUseId));
  }

  // The gate's PreToolUse hook: the call starts before the gate decides on it.
  toolCalled(raw: unknown): void {
    if (!this.terminalOpen || !this.fromAgent(raw)) return;
    const event = parseHookEvent(raw);
    if (event?.type === 'tool-start') this.apply(this.tracker.agentEvent(event));
  }

  // An event hook of the agent; the answer goes back to claude as the hook's output. A chat's agent reports only the end of its turn, a terminal's everything.
  hookEvent(sessionId: string, raw: unknown, signal?: AbortSignal): object | null | Promise<object | null> {
    const session = this.session;
    if (!session || sessionId !== session.id) return null;
    const event = parseHookEvent(raw);
    // The chat's stream closes its turns; only the answer to the end of one is the hook's.
    if (!this.terminalOpen) return event?.type === 'turn-end' && !event.failed && this.fromAgent(raw) ? this.turnEndBlock() : null;
    // Only the terminal's claude runs the event hooks, so its SessionStart names the conversation it is in: after /clear or /resume a new one.
    if (event?.type === 'conversation' && event.claudeSessionId !== session.claudeSessionId) {
      this.update({ claudeSessionId: event.claudeSessionId, conversationStarted: false });
      const moved = event.source === 'clear' ? 'The conversation was cleared in the terminal' : event.source === 'resume' ? 'The terminal switched to another conversation' : null;
      if (moved) this.apply(this.tracker.notice(`${moved}; the chat goes on with that one.`));
    }
    if (!this.fromAgent(raw)) return null;
    const transcriptPath = hookEventInfo(raw)?.transcriptPath;
    if (transcriptPath) this.transcriptTail.follow(transcriptPath);
    if (!event || event.type === 'conversation') return null;
    return this.answerHook(event, hookEventInfo(raw)?.name ?? '', signal);
  }

  // The agent's next call of its own carries the note the user's answer left, so the turn goes on with it instead of waiting for the user.
  callNote(raw: unknown): string | null {
    if (!this.terminalOpen || !this.fromAgent(raw) || this.absorbed.length === 0) return null;
    const event = parseHookEvent(raw);
    return event?.type === 'tool-start' && event.agentId === null ? this.absorbed.splice(0).join('\n\n') : null;
  }

  private fromAgent(raw: unknown): boolean {
    const claudeSessionId = (raw as { session_id?: unknown } | null)?.session_id;
    return claudeSessionId === this.session?.claudeSessionId;
  }

  private answerHook(event: AgentEvent, hookName: string, signal: AbortSignal = NEVER_ABORTED, waited = false): object | null | Promise<object | null> {
    if (event.type === 'turn-end' && !event.failed) {
      // The turn does not end while the user decides what to do with the agent's changes: the answer then keeps it going.
      const held = waited || this.absorbed.length > 0 ? null : this.options.holdTurnEnd?.(signal);
      if (held) {
        return held.then(() => {
          if (!signal.aborted) return this.answerHook(event, hookName, signal, true);
          // Claude stopped waiting for the answer, and its turn ends all the same.
          this.agentEvents([event]);
          return null;
        });
      }
      const block = this.turnEndBlock();
      if (block) return block;
    }
    this.agentEvents([event]);
    if (event.type === 'prompt' && event.task === null) {
      notify(this.userMessageListeners);
      const notes = [...this.notes.splice(0), ...this.absorbed.splice(0)];
      for (const note of notes) this.apply(this.tracker.notice(note));
      return notes.length > 0 ? { hookSpecificOutput: { hookEventName: hookName, additionalContext: notes.join('\n\n') } } : null;
    }
    // A subagent's tool step would take the note away from the agent it is meant for.
    if (event.type === 'tool-end' && event.agentId === null && this.absorbed.length > 0) {
      return { hookSpecificOutput: { hookEventName: hookName, additionalContext: this.absorbed.splice(0).join('\n\n') } };
    }
    return null;
  }

  // Keeps the agent going at the end of its turn: with the notes the user's answer left too late for a tool step, and with a question about a step it left active.
  // They are one reason, so a turn never meets two blocks where one will do.
  private turnEndBlock(): object | null {
    const reasons = [...this.absorbed.splice(0), ...this.stepNudge()];
    return reasons.length > 0 ? { decision: 'block', reason: reasons.join('\n\n') } : null;
  }

  // CodeRay never marks a step done itself: it asks once per turn, and the agent's answer stands.
  private stepNudge(): string[] {
    const step = this.options.activeStep?.();
    const turn = this.tracker.openTurnId();
    if (!step || turn === null) return [];
    if (turn !== this.nudgedTurn) {
      this.nudgedTurn = turn;
      this.nudged.clear();
    }
    const asked = `${step.planId}/${step.key}`;
    if (this.nudged.has(asked)) return [];
    this.nudged.add(asked);
    this.apply(this.tracker.notice(`CodeRay asked the agent about the step "${step.key}", which is still active.`));
    return [`CodeRay: step ${JSON.stringify(step.key)} (${step.title}) is still active. If it is finished, call mcp__idecore__step {"key": ${JSON.stringify(step.key)}, "phase": "done"}; if not, say in one sentence why it stays open.`];
  }

  // Keys typed into the agent's terminal. Only the user and CodeRay type there, never the agent's tools.
  terminalTyped(data: string): void {
    if (INTERRUPT_KEYS.has(data)) this.interruptKeyAt = Date.now();
  }

  private agentEvents(events: AgentEvent[]): void {
    for (const event of events) {
      if (event.type === 'interrupted') {
        // The transcript is a file the agent's tools can write: its interrupt marker counts only right after Esc or Ctrl+C.
        if (Date.now() - this.interruptKeyAt > INTERRUPT_CONFIRM_MS) continue;
        this.interruptKeyAt = Number.NEGATIVE_INFINITY;
        const open = this.tracker.hasOpenTurn();
        this.apply(this.tracker.agentEvent(event));
        if (open) notify(this.interruptListeners);
        continue;
      }
      this.apply(this.tracker.agentEvent(event));
    }
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
    if (this.terminalOpen) {
      // The terminal's input belongs to the user: CodeRay's own message goes with the user's next one.
      if (options.fromUser !== false || images.length > 0) throw new SessionError('in-terminal');
      this.notes.push(text);
      return;
    }
    const injected = this.tracker.hasOpenTurn();
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
    this.clearPending = false;
    this.clearedTo = null;
    const shown = images.length > 0 ? [text, `[${images.length} image${images.length > 1 ? 's' : ''} attached]`].filter((part) => part !== '').join('\n') : text;
    const changes = injected ? this.tracker.injectedMessage(shown) : this.tracker.userMessage(shown);
    const refs = this.storeImages(images.map((image) => image.data), MAX_CHAT_IMAGES);
    this.apply(refs.length === 0 ? changes : changes.map((change) =>
      change.kind === 'message' && change.message.role === 'user' ? { ...change, message: { ...change.message, images: refs } } : change));
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
    if (this.terminalOpen) {
      if (!this.tracker.hasOpenTurn()) throw new SessionError('no-turn');
      this.absorbed.push(text);
      this.apply(this.tracker.notice('CodeRay note sent to the agent'));
      return;
    }
    if (!this.process) throw new SessionError('no-gate', 'The agent is not running.');
    if (!this.tracker.hasOpenTurn()) throw new SessionError('no-turn');
    if (this.hookReady) this.process.write(userMessage(text, []));
    else this.pendingSends.push(userMessage(text, []));
    this.apply(this.tracker.notice('CodeRay note sent to the agent'));
  }

  stop(): boolean {
    // In the terminal the interrupt counts once claude confirms it in its transcript; Esc may close a menu instead.
    if (this.terminalOpen && this.options.terminalInput && this.tracker.canInterrupt()) {
      this.terminalTyped('\x1b');
      this.options.terminalInput('\x1b');
      return true;
    }
    if (!this.process || !this.tracker.canInterrupt()) return false;
    this.process.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
    notify(this.interruptListeners);
    return true;
  }

  stopTask(taskId: string): boolean {
    if (!this.process) return false;
    this.process.write({ type: 'control_request', request_id: `stop-task-${randomUUID()}`, request: { subtype: 'stop_task', task_id: taskId } });
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
    if (this.terminalOpen) throw new SessionError('in-terminal');
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
      this.sweepBlobs();
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
    if (this.terminalOpen) throw new SessionError('in-terminal');
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
    if (this.terminalOpen) throw new SessionError('in-terminal');
    if (!this.isIdle()) throw new SessionError('busy-configure');
    if (!this.session || this.session.status === 'ended') this.begin();
    if (this.session?.modelChoice === modelChoice && this.session.effort === effort) return;
    this.update({ modelChoice, effort });
    if (this.process) await this.restart();
  }

  // An idle claude still runs under the previous account, so it is stopped and the next message starts one under the new account.
  async changeAccount(change: () => void | Promise<void>): Promise<void> {
    if (this.terminating) throw new SessionError('restarting');
    if (!this.isIdle()) throw new SessionError('busy-account');
    await change();
    if (this.process && this.isIdle() && this.session?.accountId !== this.activeAccount()) await this.restart();
  }

  async close(): Promise<void> {
    await this.terminate('close');
  }

  private activeAccount(): string | null {
    return this.options.accounts?.activeId() ?? null;
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
      pid: null, launchId: null, conversationStarted: false, startedAt: Date.now(), accountId: this.activeAccount(),
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
    this.skills = [];
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, fiveHour: this.usage.fiveHour, sevenDay: this.usage.sevenDay };
    this.pendingPrompts.clear();
    this.clearPending = false;
    this.clearedTo = null;
    this.decisions.clear();
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  private load(session: SessionRecord): void {
    const history = this.options.store.history(session.id);
    const lastSeq = [...history.messages, ...history.toolEvents, ...history.prompts].reduce((max, record) => Math.max(max, record.seq), 0);
    this.session = session;
    this.turns = new Map(history.turns.map((turn) => [turn.id, turn]));
    this.mcpServers = [];
    this.skills = [];
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, fiveHour: this.usage.fiveHour, sevenDay: this.usage.sevenDay };
    this.pendingPrompts.clear();
    this.clearPending = false;
    this.clearedTo = null;
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

  // The terminal view runs claude's own interface on the chat's conversation, MCP servers and hooks; the chat's process stops first.
  // Null when CodeRay's hooks do not run (the session is then refused, as a chat whose canary stays silent) or the terminal was closed meanwhile.
  async terminalLaunch(): Promise<TerminalLaunch | null> {
    if (this.terminalOpen) throw new SessionError('in-terminal');
    if (this.terminating) throw new SessionError('restarting');
    if (!this.isIdle()) throw new SessionError('busy-terminal');
    await this.terminate('close');
    this.clearRefusal();
    if (!this.session || this.session.status === 'ended') this.begin();
    this.syncAccount();
    const session = this.session;
    // The headless check runs no turn, so none of its hooks reports an event: every event then comes from the terminal's own claude.
    const probeFiles = session && this.launchFiles(session, false);
    if (!session || !probeFiles) throw new SessionError('no-gate');
    this.terminalOpen = true;
    let hooksRun = false;
    let cancelled = false;
    let files: LaunchFiles | null = null;
    try {
      hooksRun = await this.hooksRun(session, probeFiles);
      // The terminal was closed while the hooks were checked: no claude may start outside the terminal mode.
      cancelled = !this.terminalOpen;
      if (hooksRun && !cancelled) files = this.launchFiles(session, true);
    } finally {
      if (!files) this.terminalClosed();
    }
    if (cancelled) return null;
    if (hooksRun && !files) throw new SessionError('no-gate');
    if (!files) {
      this.refused = true;
      this.update({ status: 'refused' });
      this.apply(this.tracker.notice(HOOK_OFF_NOTICE));
      return null;
    }
    return {
      kind: 'agent', title: 'claude', file: files.claude.command, cwd: session.cwd, env: files.claude.env ?? {},
      args: [...files.claude.args, ...conversationArgs(session, this.resumable(session), files.configPath, files.gateArgs)],
    };
  }

  terminalClosed(): void {
    if (!this.terminalOpen) return;
    this.terminalOpen = false;
    this.transcriptTail.stop();
    this.absorbed = [];
    this.interruptKeyAt = Number.NEGATIVE_INFINITY;
    this.apply(this.tracker.processExited());
    const session = this.session;
    if (!session) return;
    rmSync(this.configPath(session.id), { force: true });
    this.options.gate?.remove(session.id);
    if (!session.conversationStarted && existsSync(this.transcript(session))) this.update({ conversationStarted: true });
    notify(this.exitListeners);
  }

  // Interactive claude runs SessionStart only after the folder-trust dialog, so a headless claude with the same settings proves the hooks run before the terminal opens.
  private async hooksRun(session: SessionRecord, files: LaunchFiles): Promise<boolean> {
    const canary = this.options.gate?.canary;
    if (!canary) return true;
    canary.expect(session.id);
    const probe = startClaude(
      files.claude,
      ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--strict-mcp-config', ...files.gateArgs],
      session.cwd, () => {}, { killGraceMs: this.options.killGraceMs },
    );
    try {
      return await Promise.race([canary.wait(session.id, this.options.canaryMs ?? CANARY_MS), probe.exited.then(() => false)]);
    } finally {
      await probe.kill();
    }
  }

  private transcriptsDir(session: SessionRecord): string {
    const configDir = this.options.accounts?.configDir(session.accountId) ?? null;
    return this.options.transcriptsDir ?? (configDir === null ? defaultTranscriptsDir() : join(configDir, 'projects'));
  }

  private transcript(session: SessionRecord): string {
    return transcriptPath(this.transcriptsDir(session), session.cwd, session.claudeSessionId);
  }

  // claude refuses to resume a conversation it has no transcript of, as after /clear until the next message.
  private resumable(session: SessionRecord): boolean {
    return session.conversationStarted || existsSync(this.transcript(session));
  }

  private syncAccount(): void {
    if (!this.session) return;
    const accountId = this.activeAccount();
    if (this.session.accountId === accountId) return;
    const resumable = this.session.conversationStarted;
    this.update({ accountId, claudeSessionId: randomUUID(), conversationStarted: false });
    if (resumable) this.apply(this.tracker.notice(`Switched to account ${this.options.accounts?.label(accountId) ?? 'System'}; Claude starts a fresh conversation.`));
  }

  // Writes the MCP config and the gate's hook settings claude starts with; null when the hook settings could not be written.
  private launchFiles(session: SessionRecord, terminal = false): LaunchFiles | null {
    let gateArgs: string[] = [];
    if (this.options.gate) {
      try {
        const { settingsPath } = this.options.gate.write(session.id, terminal);
        gateArgs = ['--settings', settingsPath, '--append-system-prompt', this.options.gate.systemPrompt(), '--system-prompt-snapshot', 'off'];
      } catch (error) {
        console.error('agent: could not write the hook settings', error);
        this.apply(this.tracker.notice(`CodeRay could not write the hook settings for claude (${(error as Error).message}), so the agent was not started.`));
        return null;
      }
    }
    const dir = runDir(this.options.home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, RUN_DIR_MODE);
    const configPath = this.configPath(session.id);
    rmSync(configPath, { force: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: this.options.mcpServers?.() ?? {} }), { mode: PRIVATE_FILE_MODE });
    const accountDir = this.options.accounts?.configDir(session.accountId) ?? null;
    const claude = accountDir === null ? this.options.claude : { ...this.options.claude, env: { ...this.options.claude.env, CLAUDE_CONFIG_DIR: accountDir } };
    return { claude, configPath, gateArgs };
  }

  private spawn(): void {
    if (!this.session) return;
    this.syncAccount();
    const session = this.session;
    const files = this.launchFiles(session);
    if (!files) return;
    const child = startClaude(files.claude, claudeArgs(session, this.resumable(session), files.configPath, files.gateArgs), session.cwd, (line) => this.onLine(line), {
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
      if (event.type === 'text_delta') {
        // Subagent text is shown only once it is complete.
        if (event.parentToolUseId === null) this.emit({ type: 'session.delta', text: event.text });
        return;
      }
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
    if (event.type === 'conversation_reset') {
      this.clearPending = true;
      return [];
    }
    if (event.type === 'control_request') return this.controlRequest(event);
    const changes = this.tracker.event(event);
    if (event.type === 'user') this.attachResultImages(event.toolResults, changes);
    if (event.type === 'init' && !this.versionChecked) {
      this.versionChecked = true;
      if (event.cliVersion !== null && isOlderVersion(event.cliVersion, MIN_CLAUDE_VERSION)) {
        changes.push(...this.tracker.notice(
          `claude ${event.cliVersion} is older than ${MIN_CLAUDE_VERSION}, the version CodeRay was verified with; tool names and stream events may differ.`,
        ));
      }
    }
    return changes;
  }

  // A call's images are kept once it ends; its item carries only their refs.
  private attachResultImages(results: ToolResultBlock[], changes: Change[]): void {
    for (const result of results) {
      if (result.images.length === 0) continue;
      const index = changes.findIndex((change) => change.kind === 'tool' && change.tool.toolUseId === result.toolUseId);
      const change = changes[index];
      if (change?.kind !== 'tool') continue;
      const images = this.storeImages(result.images, MAX_RESULT_IMAGES);
      if (images.length > 0) changes[index] = { kind: 'tool', tool: { ...change.tool, images } };
    }
  }

  // Parts that are not a png, jpeg, gif or webp, or are too large to keep, are left out.
  private storeImages(images: string[], limit: number): ImageRef[] {
    const refs: ImageRef[] = [];
    for (const data of images) {
      if (refs.length >= limit) break;
      if (data.length > MAX_STORED_BASE64) continue;
      try {
        const ref = this.blobs.put(Buffer.from(data, 'base64'));
        if (ref) refs.push(ref);
      } catch (error) {
        console.error('agent: could not keep an image of the chat', error);
      }
    }
    return refs;
  }

  private controlRequest(event: Extract<StreamEvent, { type: 'control_request' }>): Change[] {
    const asksUser = event.subtype === 'can_use_tool' && event.toolName !== null && PROMPT_TOOLS.includes(event.toolName);
    const body = asksUser ? parsePromptBody(event.toolName, event.input) : null;
    if (body) {
      this.pendingPrompts.set(event.requestId, { input: event.input, body });
      return this.tracker.prompt(event.requestId, body);
    }
    const reason = event.subtype === 'can_use_tool'
      ? `CodeRay does not answer permission prompts for ${event.toolName ?? 'this tool'}.`
      : `CodeRay does not handle "${event.subtype}" requests.`;
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
    if (this.terminalOpen) throw new SessionError('in-terminal');
    await this.terminate('close');
    this.clearRefusal();
    remove();
    this.sweepBlobs();
    this.notes = [];
    notify(this.newSessionListeners);
    this.previous = this.session ?? this.previous;
    this.setActive('');
    this.reset(null);
  }

  // Chats share blobs, so one goes only when no remaining row refers to it. The sweep runs in one go, so no image stored meanwhile can lose its row.
  private sweepBlobs(): void {
    if (this.sweepPending) return;
    this.sweepPending = true;
    setImmediate(() => {
      this.sweepPending = false;
      try {
        this.blobs.sweep(() => this.options.store.imageIds());
      } catch (error) {
        console.error('agent: could not remove the images of deleted chats', error);
      }
    });
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
        const claudeSessionId = change.claudeSessionId || session.claudeSessionId;
        if (this.clearPending) {
          this.clearPending = false;
          this.clearedTo = claudeSessionId;
        }
        const updated: SessionRecord = {
          ...(this.session ?? session),
          claudeSessionId,
          model: change.model,
          cliVersion: change.cliVersion,
          conversationStarted: claudeSessionId !== this.clearedTo,
        };
        this.session = updated;
        this.persist(() => store.saveSession(updated));
        this.mcpServers = change.mcpServers;
        this.skills = change.skills;
        patch.session = sessionView(updated, this.permissionMode);
        patch.mcpServers = change.mcpServers;
        patch.skills = change.skills;
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

function claudeArgs(session: SessionRecord, resume: boolean, mcpConfigPath: string, gateArgs: string[]): string[] {
  return [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    ...conversationArgs(session, resume, mcpConfigPath, gateArgs),
    '--permission-prompt-tool', 'stdio',
  ];
}

function conversationArgs(session: SessionRecord, resume: boolean, mcpConfigPath: string, gateArgs: string[]): string[] {
  return [
    resume ? '--resume' : '--session-id', session.claudeSessionId,
    ...(session.modelChoice !== null && isModelChoice(session.modelChoice) ? ['--model', session.modelChoice] : []),
    ...(session.effort !== null && EFFORT_LEVELS.includes(session.effort) ? ['--effort', session.effort] : []),
    '--mcp-config', mcpConfigPath,
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    ...gateArgs,
    '--dangerously-skip-permissions',
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
  return message.role === 'notice' ? { kind: 'notice', ...base } : { kind: 'message', role: message.role, ...base, ...(message.images ? { images: message.images } : {}) };
}

function toolItem(event: ToolEventRecord, root: string, decision?: ToolDecisionRecord): ChatItem {
  return {
    kind: 'tool', id: event.toolUseId, seq: event.seq, turnId: event.turnId, parentToolUseId: event.parentToolUseId,
    tool: event.tool, summary: summarizeToolInput(event.input, root), status: event.status, startedAt: event.toolUseAt, endedAt: event.endedAt,
    decision: decision?.decision ?? null, targets: decision?.targets ?? [],
    ...(event.images ? { images: event.images } : {}),
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
