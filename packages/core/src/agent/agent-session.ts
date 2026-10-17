import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EMPTY_USAGE, ENGINE_CAPABILITIES, ENGINE_NAMES, isClaudeEffort, isEffortFor, MAX_CHAT_IMAGES, parseModelId,
  type ChatImage, type ChatItem, type ChatPick, type ChatSummary, type EngineId, type ImageRef, type LimitWindow, type McpEntry, type McpServerState, type PromptAnswer, type PromptBody,
  type SessionPatch, type SessionServerMessage, type SessionState, type SessionView, type TaskView, type TurnView, type UsageView,
} from '@ide/protocol';
import { SYSTEM_HOME, type AccountHome } from '../accounts/account-homes';
import { CANARY_MS } from '../gate/canary';
import type { HookAnswer } from '../gate/hook-gate';
import type { TerminalLaunch } from '../terminal/terminal-service';
import { defaultTranscriptsDir, largest, recoverTranscript, transcriptPath, UNCLEAN_STOP_KEY } from '../watchdog/recovery';
import { projectDir, runDir } from '../home';
import { BlobStore, MAX_STORED_IMAGE_BYTES } from '../images/blob-store';
import { commandLine, forceKill, isAlive, reaches, signal } from '../os-process';
import type { MessageRecord, PromptRecord, SessionRecord, Store, ToolDecisionRecord, ToolEventRecord } from '../store/store';
import { claudeUnder, KILL_GRACE_MS, startClaude, type ClaudeCommand, type ProcessExit } from './claude-process';
import { codexUnder, type CodexCommand } from './codex/command';
import { codexMcp } from './codex/mcp';
import { claudeEngine } from './engines/claude';
import { codexEngine, keyRejectedHint, signedOutHint } from './engines/codex';
import { EngineRegistry } from './engines/registry';
import { answerProblem, parsePromptBody, PROMPT_TOOLS, promptResponse } from './prompts';
import { hookEventInfo, parseHookEvent, parseTranscriptLine, type AgentEvent } from './hook-events';
import { reapOrphans } from './reaper';
import { type StreamEvent, type ToolResultBlock } from './stream';
import { CLAUDE_PROMPT_NAMES, CODEX_PROMPT_NAMES, codexInstructions, type PromptNames } from './system-prompt';
import { TranscriptTail } from './transcript-tail';
import {
  gateArgs, userMessage, type AgentTransport, type ClaudeLaunch, type CodexLaunch, type ControlResponse, type GateCall, type GateLaunch, type TransportSink, type UserMessage,
} from './transport';
import { mergeLimits, type UsageUpdate } from './usage';
import { DISALLOWED_TOOLS, ENGINE_BINARIES, isOlderVersion, MIN_VERSIONS, summarizeToolInput } from './tools';
import { TurnTracker, type Change, type ToolEndInfo } from './tracker';

export type McpServers = Record<string, McpEntry>;

export interface SessionGate {
  write(sessionId: string, events?: boolean): { settingsPath: string };
  remove(sessionId: string): void;
  systemPrompt(names: PromptNames): string;
  canary?: { expect(sessionId: string): void; wait(sessionId: string, ms: number): Promise<boolean> };
  /** Throws while the gate cannot decide yet, so no agent starts unguarded. */
  check?(): void;
  /** Decides calls that may write and run together or not at all, as claude's PreToolUse hook does one; null when they went away first. */
  decide?(calls: GateCall[], signal: AbortSignal): Promise<HookAnswer | null>;
}

// A chat runs under the account its engine had active when it started: claude looks --resume transcripts up in that account's directory.
export interface SessionAccounts {
  activeId(): string | null;
  home(id: string | null): AccountHome;
  label(id: string | null): string;
  activeLabel(): string | null;
}

export interface AgentSessionOptions {
  root: string;
  home: string;
  store: Store;
  claude: ClaudeCommand;
  accounts?: Partial<Record<EngineId, SessionAccounts>>;
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
  // The engines a chat can run on; Claude only, by default.
  engines?: EngineRegistry;
  // What a project's first chat starts with; without it nothing starts until the user picks a model.
  defaultModel?: ChatPick;
  // The codex the core runs; registers the Codex engine.
  codex?: CodexCommand;
}

const ACTIVE_SESSION_KEY = 'activeSessionId';

const HOOK_OFF_NOTICE =
  "CodeRay's hook did not start, so the agent was not started. Claude Code settings (a managed policy or disableAllHooks) may be switching hooks off.";

const GAP_NOTICE = "Calls made while the core was down may be missing; claude's transcript could not be read.";
const NO_TRANSCRIPT_GAP_NOTICE = 'Calls made while the core was down may be missing.';

const SESSION_ERRORS = {
  empty: 'Type a message first.',
  'no-model': 'Choose a model for this chat first.',
  restarting: 'The session is restarting. Try again in a moment.',
  'prompt-gone': 'That question is no longer waiting for an answer.',
  'bad-answer': 'That answer does not fit the question.',
  'no-gate': 'CodeRay could not prepare the hook settings for claude, so the agent was not started.',
  'hook-off': HOOK_OFF_NOTICE,
  'no-turn': 'The agent has no open turn to add a note to.',
  'busy-configure': 'Wait for the agent to finish or press Stop before changing the model.',
  'busy-switch': 'Wait for the agent to finish or press Stop before switching chats.',
  'busy-account': 'Wait for the agent to finish or press Stop before switching accounts.',
  'engine-locked': 'This chat runs on another engine. Start a new chat to use that model.',
  'bad-model': 'That model name is not valid.',
  'bad-effort': 'That effort level is not valid.',
  'no-chat': 'That chat does not exist.',
  'busy-terminal': 'Wait for the agent to finish or press Stop before opening the terminal.',
  'in-terminal': 'The agent runs in the terminal view. Switch back to the chat to do this.',
  'no-engine': 'That model needs an engine CodeRay does not have.',
  'no-terminal': 'This engine has no terminal view.',
  refused: "This chat's agent was refused; the chat says why.",
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
type SessionUpdate = Partial<Pick<SessionRecord, 'status' | 'pid' | 'launchId' | 'engine' | 'modelChoice' | 'effort' | 'accountId' | 'engineSessionId' | 'conversationStarted'>>;

interface LaunchFiles {
  claude: ClaudeCommand;
  configPath: string;
  gate: GateLaunch | null;
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
  /** The engines a chat can run on, whose status and models the core reports, under the active account. */
  readonly engines: EngineRegistry;
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
  private skillsKnown = false;
  private permissionMode: string | null = null;
  private usage: UsageView = EMPTY_USAGE;
  private transport: AgentTransport | null = null;
  private exitReason: ExitReason | null = null;
  private terminating = false;
  // Set by close(): no claude starts after the core began to shut down.
  private closed = false;
  private versionChecked = false;
  private idle = true;
  private hookReady = true;
  private refused = false;
  private refusal: string | null = null;
  // Each engine's account reports its own windows; a new chat shows those of its own engine and account.
  private readonly limits = new Map<string, LimitWindow[]>();
  private pendingSends: UserMessage[] = [];
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
    const codex = options.codex;
    this.engines = options.engines ?? new EngineRegistry([
      claudeEngine({ command: () => this.activeClaude(), cwd: options.root, account: () => this.options.accounts?.claude?.activeLabel() ?? null }),
      ...(codex ? [codexEngine({
        command: () => codexUnder(codex, this.accountHome('codex', this.activeAccount('codex'))), cwd: options.root,
        signedOut: () => signedOutHint(this.accountHome('codex', this.activeAccount('codex'))),
        account: () => this.options.accounts?.codex?.activeLabel() ?? null,
      })] : []),
    ]);
  }

  private activeClaude(): ClaudeCommand {
    return claudeUnder(this.options.claude, this.accountHome('claude', this.activeAccount('claude')));
  }

  private accountHome(engine: EngineId, id: string | null): AccountHome {
    return this.options.accounts?.[engine]?.home(id) ?? SYSTEM_HOME;
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
      await reapOrphans(runDir(this.options.home), this.options.killGraceMs ?? KILL_GRACE_MS);
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
    // A new chat's claude starts before its first message: a chat left without one is dropped, so it neither looks crashed nor gets resumed.
    const discard = (latest.status === 'running' || latest.status === 'stopped') && this.unused(latest);
    if (latest.status === 'running' && !discard) this.options.store.setMeta(UNCLEAN_STOP_KEY, '1');
    this.crashed = !discard && this.options.store.meta(UNCLEAN_STOP_KEY) === '1';
    if (latest.status === 'running') {
      await stopStale(latest, this.options.killGraceMs ?? KILL_GRACE_MS);
      rmSync(this.configPath(latest.id), { force: true });
      this.options.gate?.remove(latest.id);
    }
    if (discard) {
      this.persist(() => store.deleteSession(latest.id));
      this.setActive('');
      this.previous = store.latestSession();
      return;
    }
    const recovers = latest.foreignEngine === undefined && ENGINE_CAPABILITIES[latest.engine].transcriptRecovery;
    const gap = latest.status === 'running' && recovers ? await this.recoverChat(latest) : null;
    this.load(latest);
    this.apply(this.tracker.processExited());
    for (const id of gap?.ids ?? []) {
      const item = this.items.get(id);
      if (item?.kind === 'message' || item?.kind === 'tool') this.items.set(id, { ...item, recovered: true });
    }
    if (gap?.unreadable) this.apply(this.tracker.notice(GAP_NOTICE));
    if (latest.status === 'running' && !recovers) this.apply(this.tracker.notice(NO_TRANSCRIPT_GAP_NOTICE));
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
      const recovered = await recoverTranscript({ engineSessionId: session.engineSessionId, cwd: session.cwd, since, dir: this.transcriptsDir(session) });
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
      skillsKnown: this.skillsKnown,
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
    return this.transport !== null || this.terminalOpen;
  }

  /** The open chat's engine keeps its calls in an OS sandbox. */
  sandboxed(): boolean {
    return this.session !== null && this.session.foreignEngine === undefined && ENGINE_CAPABILITIES[this.session.engine].hardSandbox;
  }

  engineOf(): EngineId | null {
    return this.session?.engine ?? null;
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
    if (event?.type === 'conversation' && event.engineSessionId !== session.engineSessionId) {
      this.update({ engineSessionId: event.engineSessionId, conversationStarted: false });
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
    const engineSessionId = (raw as { session_id?: unknown } | null)?.session_id;
    return engineSessionId === this.session?.engineSessionId;
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
    if (this.refused) {
      // Codex's checks run again with the next message (signed in meanwhile, a configuration fixed); claude's hook-off holds until a restart.
      if (this.session === null || this.session.engine === 'claude') throw new SessionError('hook-off', this.refusal ?? undefined);
      this.clearRefusal();
    }
    if (this.terminalOpen) {
      // The terminal's input belongs to the user: CodeRay's own message goes with the user's next one.
      if (options.fromUser !== false || images.length > 0) throw new SessionError('in-terminal');
      this.notes.push(text);
      return;
    }
    const injected = this.tracker.hasOpenTurn();
    if (!this.session || this.session.status === 'ended') this.begin();
    if (!this.transport) this.spawn();
    if (!this.transport) throw new SessionError('no-gate', this.session?.engine === 'claude' ? undefined : 'CodeRay could not get the gate ready, so the agent was not started.');
    if (options.fromUser !== false) notify(this.userMessageListeners);
    const notes = this.notes.splice(0);
    const message = userMessage([...notes, text].filter((part) => part !== '').join('\n\n'), images);
    try {
      if (this.hookReady) this.transport.send(message);
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

  // A failure each attempt meets again is said once, until something else happens in the chat.
  private noticeOnce(text: string): void {
    const last = [...this.items.values()].reduce<ChatItem | null>((latest, item) => (latest === null || item.seq > latest.seq ? item : latest), null);
    if (last?.kind !== 'notice' || last.text !== text) this.apply(this.tracker.notice(text));
  }

  queueNote(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    this.notes.push(text);
  }

  sendAbsorbed(text: string): void {
    if (text.trim() === '') throw new SessionError('empty');
    if (this.terminating) throw new SessionError('restarting');
    if (this.refused) throw new SessionError(this.session === null || this.session.engine === 'claude' ? 'hook-off' : 'refused', this.refusal ?? undefined);
    if (this.terminalOpen) {
      if (!this.tracker.hasOpenTurn()) throw new SessionError('no-turn');
      this.absorbed.push(text);
      this.apply(this.tracker.notice('CodeRay note sent to the agent'));
      return;
    }
    if (!this.transport) throw new SessionError('no-gate', 'The agent is not running.');
    if (!this.tracker.hasOpenTurn()) throw new SessionError('no-turn');
    if (this.hookReady) this.transport.send(userMessage(text, []));
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
    if (!this.transport || !this.tracker.canInterrupt()) return false;
    this.transport.interrupt();
    notify(this.interruptListeners);
    return true;
  }

  stopTask(taskId: string): boolean {
    if (!this.transport) return false;
    this.transport.stopTask(taskId);
    return true;
  }

  interrupt(): boolean {
    return this.stop();
  }

  answerPrompt(requestId: string, answer: PromptAnswer): void {
    const pending = this.pendingPrompts.get(requestId);
    if (!pending || !this.transport) throw new SessionError('prompt-gone');
    const problem = answerProblem(pending.body, answer);
    if (problem) throw new SessionError('bad-answer', problem);
    this.pendingPrompts.delete(requestId);
    this.transport.respond({ subtype: 'success', request_id: requestId, response: promptResponse(pending.input, answer) });
    this.apply(this.tracker.promptAnswered(requestId, answer));
  }

  async restart(): Promise<void> {
    await this.terminate('restart');
    this.clearRefusal();
    if (this.session && this.unused(this.session)) this.warm();
  }

  async newSession(pick: { modelChoice: string; effort: string | null } | null = null): Promise<void> {
    if (this.terminalOpen) throw new SessionError('in-terminal');
    const chosen = pick === null ? null : this.checkedPick(pick.modelChoice, pick.effort);
    const current = this.session;
    if (current && current.foreignEngine === undefined && this.unused(current)) {
      this.clearRefusal();
      if (chosen) await this.configure(chosen.modelChoice, chosen.effort);
      this.warm();
      return;
    }
    await this.terminate('new');
    // A second New chat while the first one waited: the first already opened the new chat.
    if (this.session?.id !== current?.id) return;
    this.clearRefusal();
    if (this.session && this.session.status !== 'ended') this.update({ status: 'ended' });
    this.notes = [];
    notify(this.newSessionListeners);
    this.previous = this.session ?? this.previous;
    this.setActive('');
    this.reset(null);
    this.warm(chosen);
  }

  // A new chat's claude starts before its first message, so its skills are listed by the time the user types "/".
  private warm(pick: ChatPick | null = null): void {
    if (this.closed || this.terminalOpen || this.terminating || this.transport || this.refused || (pick ?? this.nextPick()) === null) return;
    try {
      if (!this.session || this.session.status === 'ended') this.begin(pick);
      this.spawn();
    } catch (error) {
      if (error instanceof SessionError && this.session) this.apply(this.tracker.notice(error.message));
      else console.error('agent: could not start the agent of a new chat', error);
    }
  }

  // Neither the user nor the agent has written to the chat yet, so dropping it loses nothing.
  private unused(session: SessionRecord): boolean {
    if (session.conversationStarted || (session.engine === 'claude' && existsSync(this.transcript(session)))) return false;
    if (session.id === this.session?.id && [...this.items.values()].some((item) => item.kind !== 'notice')) return false;
    const { store } = this.options;
    if (store.manualTitle(session.id)) return false;
    const history = store.history(session.id);
    // The file watcher records the user's own edits into the open chat, and a revert the user makes lands there too.
    return history.messages.every((message) => message.role === 'notice') && history.toolEvents.length === 0 && history.prompts.length === 0
      && store.watchdogEvents(session.id).length === 0 && store.changes(session.id, 1).length === 0 && store.reverts(session.id).length === 0;
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
    // A chat opened and left without a word would only clutter the list.
    const left = this.session;
    if (left && left.id !== target.id && this.unused(left)) this.persist(() => this.options.store.deleteSession(left.id));
    notify(this.newSessionListeners);
    this.load(target);
    this.apply(this.tracker.processExited());
    // An ended chat is reopened so the next message resumes it instead of starting a new one.
    if (target.status === 'ended' || target.status === 'running' || target.status === 'refused') this.update({ status: 'stopped', pid: null, launchId: null });
    this.setActive(target.id);
    this.emit({ type: 'session.snapshot', state: this.state() });
  }

  async configure(modelChoice: string | null, effort: string | null): Promise<void> {
    const pick = this.checkedPick(modelChoice, effort);
    // An effort alone names no model, and with nothing to inherit a chat would start on none.
    if (pick.modelChoice === null && this.nextPick() === null) throw new SessionError('no-model');
    if (this.terminating) throw new SessionError('restarting');
    if (this.terminalOpen) throw new SessionError('in-terminal');
    if (!this.isIdle()) throw new SessionError('busy-configure');
    if (!this.session || this.session.status === 'ended') this.begin(this.nextPick() === null ? pick : null);
    const session = this.session;
    if (!session || (session.engine === pick.engine && session.modelChoice === pick.modelChoice && session.effort === pick.effort)) return;
    // The conversation lives in its engine: once the chat is in use, another engine needs a new chat; a chat of an unknown engine never changes.
    if (session.foreignEngine !== undefined || (session.engine !== pick.engine && !this.unused(session))) throw new SessionError('engine-locked');
    // An effort change restarts claude: its only live path, applyFlagSettings, writes the settings layer that also carries the gate's hooks.
    const liveModel = session.engine === pick.engine && session.effort === pick.effort;
    const swap = session.engine !== pick.engine;
    const running = this.transport !== null;
    // The old engine's agent stops before the chat names the new engine, so none of its last events land under that name.
    if (swap && running) await this.terminate('restart');
    if (swap) {
      // The unused chat moves to the new engine's active account and its windows; a refusal was the old engine's.
      this.update({ engine: pick.engine, modelChoice: pick.modelChoice, effort: pick.effort, accountId: this.activeAccount(pick.engine) });
      this.showLimits();
      this.clearRefusal();
      // As restart() does: only an agent that was running is started again, on the new engine.
      if (running) this.warm();
      return;
    }
    this.update({ engine: pick.engine, modelChoice: pick.modelChoice, effort: pick.effort });
    if (!this.transport) return;
    if (liveModel) {
      try {
        await this.transport.setModel(modelOf(pick.modelChoice));
        return;
      } catch (error) {
        console.error('agent: claude did not switch the model, so it restarts with it', error);
      }
    }
    await this.restart();
  }

  // A null model keeps the engine of the chat it would apply to.
  private checkedPick(modelChoice: string | null, effort: string | null): ChatPick {
    const engine = modelChoice === null ? ((this.session ?? this.previous)?.engine ?? 'claude') : parseModelId(modelChoice)?.engine;
    if (engine === undefined) throw new SessionError('bad-model');
    if (!this.engines.get(engine)) throw new SessionError('no-engine');
    if (effort !== null && !isEffortFor(engine, effort)) throw new SessionError('bad-effort');
    return { engine, modelChoice, effort };
  }

  // An idle agent still runs under the previous account, so it is stopped and the next message starts one under the new account.
  async changeAccount(engine: EngineId, change: () => void | Promise<void>): Promise<void> {
    if (this.terminating) throw new SessionError('restarting');
    const affected = this.session?.engine === engine;
    if (affected && !this.isIdle()) throw new SessionError('busy-account');
    await change();
    if (affected && this.transport && this.isIdle() && this.session?.accountId !== this.activeAccount(engine)) await this.restart();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminate('close');
  }

  private activeAccount(engine: EngineId): string | null {
    return this.options.accounts?.[engine]?.activeId() ?? null;
  }

  // A chat of an engine this CodeRay does not know is kept, never run: claude would resume that engine's conversation id.
  private refuseForeign(session: SessionRecord | null): void {
    if (session?.foreignEngine !== undefined) throw new SessionError('no-engine', `This chat runs on ${session.foreignEngine}, which this CodeRay does not have.`);
  }

  private clearRefusal(): void {
    if (!this.refused) return;
    this.refused = false;
    this.refusal = null;
    if (this.session?.status === 'refused') this.update({ status: 'stopped' });
  }

  private async awaitCanary(transport: AgentTransport, sessionId: string, canary: NonNullable<SessionGate['canary']>): Promise<void> {
    const reported = await canary.wait(sessionId, this.options.canaryMs ?? CANARY_MS);
    if (this.transport !== transport) return;
    if (reported) {
      this.hookReady = true;
      for (const message of this.pendingSends.splice(0)) transport.send(message);
      return;
    }
    await this.refuseChat(HOOK_OFF_NOTICE);
  }

  // The chat's agent may not run (the gate is not demonstrably on): it is stopped, and the chat says why.
  private async refuseChat(reason: string): Promise<void> {
    if (this.refused) return;
    this.pendingSends = [];
    this.refused = true;
    this.refusal = reason;
    this.apply(this.tracker.notice(reason));
    await this.terminate('close');
  }

  private begin(pick: ChatPick | null = null): void {
    const chosen = pick ?? this.nextPick();
    if (chosen === null) throw new SessionError('no-model');
    const session: SessionRecord = {
      id: randomUUID(), engine: chosen.engine, engineSessionId: randomUUID(), cwd: this.options.root, status: 'stopped', model: null,
      modelChoice: chosen.modelChoice, effort: chosen.effort, cliVersion: null,
      pid: null, launchId: null, conversationStarted: false, startedAt: Date.now(), accountId: this.activeAccount(chosen.engine),
    };
    this.persist(() => this.options.store.saveSession(session));
    this.setActive(session.id);
    this.reset(session);
  }

  /** What a new chat starts with: the open or previous chat's engine, model and effort, else the default model; null when nothing names one. */
  nextPick(): ChatPick | null {
    // A chat, or a default model, of an engine this CodeRay does not know, or does not run, names nothing it can start.
    const runs = (engine: EngineId): boolean => this.engines.get(engine) !== undefined;
    const chat = [this.session, this.previous].find((candidate): candidate is SessionRecord =>
      candidate !== null && candidate.foreignEngine === undefined && runs(candidate.engine));
    const fallback = this.options.defaultModel;
    const from = chat ?? (fallback !== undefined && runs(fallback.engine) ? fallback : null);
    if (from === null) return null;
    // An earlier Claude chat with no model or effort ran on claude's defaults; the chat after it names them, as it always has.
    return from.engine === 'claude'
      ? { engine: 'claude', modelChoice: from.modelChoice ?? 'sonnet', effort: from.effort ?? 'medium' }
      : { engine: from.engine, modelChoice: from.modelChoice, effort: from.effort };
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
    this.skillsKnown = false;
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, limits: this.limits.get(limitKey(session)) ?? [] };
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
    this.skillsKnown = false;
    this.permissionMode = null;
    this.usage = { ...EMPTY_USAGE, limits: this.limits.get(limitKey(session)) ?? [] };
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
    const open = this.session && this.session.status !== 'ended' ? this.session : null;
    this.refuseForeign(open);
    const engine = (open ?? this.nextPick())?.engine ?? 'claude';
    if (!this.engines.get(engine)) throw new SessionError('no-engine');
    if (!ENGINE_CAPABILITIES[engine].terminalView) throw new SessionError('no-terminal');
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
      args: [...files.claude.args, ...conversationArgs(session, this.resumable(session), files.configPath, gateArgs(files.gate))],
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
      ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--strict-mcp-config', ...gateArgs(files.gate)],
      session.cwd, () => {}, { killGraceMs: this.options.killGraceMs },
    );
    try {
      return await Promise.race([canary.wait(session.id, this.options.canaryMs ?? CANARY_MS), probe.exited.then(() => false)]);
    } finally {
      await probe.kill();
    }
  }

  private transcriptsDir(session: SessionRecord): string {
    const configDir = this.accountHome('claude', session.accountId).dir;
    return this.options.transcriptsDir ?? (configDir === null ? defaultTranscriptsDir() : join(configDir, 'projects'));
  }

  private transcript(session: SessionRecord): string {
    return transcriptPath(this.transcriptsDir(session), session.cwd, session.engineSessionId);
  }

  // claude refuses to resume a conversation with no transcript yet, so a new one starts with --session-id; the id an init gives after /clear already has one.
  private resumable(session: SessionRecord): boolean {
    return session.conversationStarted || (session.engine === 'claude' && existsSync(this.transcript(session)));
  }

  private syncAccount(): void {
    const session = this.session;
    if (!session) return;
    const accountId = this.activeAccount(session.engine);
    if (session.accountId === accountId) return;
    this.update({ accountId, engineSessionId: randomUUID(), conversationStarted: false });
    this.showLimits();
    if (!session.conversationStarted) return;
    const label = this.options.accounts?.[session.engine]?.label(accountId) ?? 'System';
    this.apply(this.tracker.notice(`Switched to account ${label}; ${ENGINE_NAMES[session.engine]} starts a fresh conversation.`));
  }

  // Writes the MCP config and the gate's hook settings claude starts with; null when the hook settings could not be written.
  private launchFiles(session: SessionRecord, terminal = false): LaunchFiles | null {
    let gate: GateLaunch | null = null;
    if (this.options.gate) {
      try {
        const { settingsPath } = this.options.gate.write(session.id, terminal);
        gate = { settingsPath, appendSystemPrompt: this.options.gate.systemPrompt(CLAUDE_PROMPT_NAMES) };
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
    const claude = claudeUnder(this.options.claude, this.accountHome('claude', session.accountId));
    return { claude, configPath, gate };
  }

  // Claude's part of a launch: the MCP config and the gate's settings it starts with; null when the settings could not be written.
  private prepareClaude(session: SessionRecord): ClaudeLaunch | null {
    const files = this.launchFiles(session);
    if (!files) return null;
    return {
      engine: session.engine, cwd: session.cwd, engineSessionId: session.engineSessionId, resume: this.resumable(session),
      model: claudeModel(session.modelChoice),
      effort: session.effort !== null && isClaudeEffort(session.effort) ? session.effort : null,
      claude: files.claude, mcpConfigPath: files.configPath, disallowedTools: DISALLOWED_TOOLS, gate: files.gate,
      killGraceMs: this.options.killGraceMs, pidDir: runDir(this.options.home),
    };
  }

  // Codex's part of a launch: its command under the chat's account, the IDE's MCP list in its dialect, the instructions and the gate.
  private prepareCodex(session: SessionRecord): CodexLaunch | null {
    const codex = this.options.codex;
    if (!codex) throw new SessionError('no-engine');
    const gate = this.options.gate;
    try {
      gate?.check?.();
    } catch (error) {
      this.noticeOnce(`CodeRay could not get the gate ready for Codex (${(error as Error).message}).`);
      return null;
    }
    let mcp: ReturnType<typeof codexMcp>;
    try {
      mcp = codexMcp(this.options.mcpServers?.() ?? {});
    } catch (error) {
      throw new SessionError('no-gate', `CodeRay could not give Codex its MCP servers (${(error as Error).message}), so the agent was not started.`);
    }
    const home = this.accountHome('codex', session.accountId);
    return {
      engine: 'codex', cwd: session.cwd, engineSessionId: session.engineSessionId, resume: session.conversationStarted,
      model: modelOf(session.modelChoice), effort: session.effort,
      codex: codexUnder(codex, home),
      // The transport switches codex's apps and plugins off and keeps these secrets out of the model's shell, whatever the launch says.
      servers: mcp.names, config: mcp.config, env: mcp.env,
      developerInstructions: codexInstructions(gate?.systemPrompt(CODEX_PROMPT_NAMES) ?? null),
      signedOutHint: signedOutHint(home), keyRejectedHint: keyRejectedHint(home),
      ...(gate?.decide ? { decide: (calls: GateCall[], signal: AbortSignal) => gate.decide!(calls, signal) } : {}),
      killGraceMs: this.options.killGraceMs, pidDir: runDir(this.options.home),
    };
  }

  private spawn(): void {
    if (!this.session || this.closed) return;
    this.refuseForeign(this.session);
    const engine = this.engines.get(this.session.engine);
    if (!engine) throw new SessionError('no-engine');
    this.syncAccount();
    const session = this.session;
    const launch = session.engine === 'codex' ? this.prepareCodex(session) : this.prepareClaude(session);
    if (!launch) return;
    // A stopped claude's last events may arrive while the next one starts; they no longer belong to the chat.
    const sink: TransportSink = { event: (event) => { if (this.transport === transport) this.onStreamEvent(event); } };
    const transport = engine.start(launch, sink);
    this.transport = transport;
    this.exitReason = null;
    this.versionChecked = false;
    this.update({ status: 'running', pid: transport.pid ?? null, launchId: session.engineSessionId });
    const canary = session.engine === 'claude' ? this.options.gate?.canary : undefined;
    this.hookReady = canary === undefined;
    this.pendingSends = [];
    if (canary) {
      canary.expect(session.id);
      void this.awaitCanary(transport, session.id, canary).catch((error: unknown) => console.error('agent: could not check the hook canary', error));
    }
    // Claude lists its skills in init only after the first message; until then the chat shows this list, and init's replaces it.
    void transport.skills().then((skills) => {
      if (this.transport !== transport || this.skillsKnown) return;
      this.skills = skills;
      this.skillsKnown = true;
      this.emit({ type: 'session.patch', patch: { skills, skillsKnown: true } });
    }, (error: unknown) => {
      if (this.transport !== transport) return;
      console.error('agent: could not list the skills before claude\'s init', error);
      if (this.skillsKnown) return;
      // The chat stops saying it is loading them; init still lists them after the first message.
      this.skillsKnown = true;
      this.emit({ type: 'session.patch', patch: { skillsKnown: true } });
    });
    void transport.exited.then((exit) => this.onExit(transport, exit)).catch((error: unknown) => console.error('agent: could not process claude exit', error));
  }

  private onStreamEvent(event: StreamEvent): void {
    try {
      if (event.type === 'usage') {
        this.trackUsage(event.update);
        return;
      }
      if (event.type === 'notice') {
        this.apply(this.tracker.notice(event.text));
        return;
      }
      if (event.type === 'refused') {
        void this.refuseChat(event.reason).catch((error: unknown) => console.error('agent: could not refuse the chat', error));
        return;
      }
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

  private trackUsage(update: UsageUpdate): void {
    const key = limitKey(this.session);
    const limits = update.limits ? mergeLimits(this.limits.get(key) ?? [], update.limits) : this.usage.limits;
    if (update.limits) this.limits.set(key, limits);
    const usage = { ...this.usage, ...update, limits };
    if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
    this.usage = usage;
    this.emit({ type: 'session.patch', patch: { usage } });
  }

  // The meter shows the windows of the chat's engine and account: another account's never stay after a switch.
  private showLimits(): void {
    const limits = this.limits.get(limitKey(this.session)) ?? [];
    if (JSON.stringify(limits) === JSON.stringify(this.usage.limits)) return;
    this.usage = { ...this.usage, limits };
    this.emit({ type: 'session.patch', patch: { usage: this.usage } });
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
      const engine = this.session?.engine ?? 'claude';
      const floor = MIN_VERSIONS[engine];
      if (event.cliVersion !== null && isOlderVersion(event.cliVersion, floor)) {
        changes.push(...this.tracker.notice(
          `${ENGINE_BINARIES[engine]} ${event.cliVersion} is older than ${floor}, the version CodeRay was verified with; tool names and stream events may differ.`,
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
    const response: ControlResponse = event.subtype === 'can_use_tool'
      ? { subtype: 'success', request_id: event.requestId, response: { behavior: 'deny', message: reason } }
      : { subtype: 'error', request_id: event.requestId, error: reason };
    this.transport?.respond(response);
    return this.tracker.notice(`Refused a "${event.subtype}" request from claude: ${reason}`);
  }

  private onExit(transport: AgentTransport, exit: ProcessExit): void {
    if (this.transport !== transport || !this.session) return;
    this.transport = null;
    this.terminating = false;
    rmSync(this.configPath(this.session.id), { force: true });
    this.options.gate?.remove(this.session.id);
    const reason = this.exitReason;
    this.apply(this.tracker.processExited());
    if (reason === null) this.apply(this.tracker.notice(crashNotice(exit, this.session.engine)));
    const status = reason === null ? 'crashed' : reason === 'new' ? 'ended' : this.refused ? 'refused' : 'stopped';
    this.update({ status, pid: null, launchId: null });
    notify(this.exitListeners);
  }

  private async discardActive(remove: () => void): Promise<void> {
    if (this.terminalOpen) throw new SessionError('in-terminal');
    // New chat or a restart waiting for the old claude would start the next one into the chat this drops.
    if (this.terminating) throw new SessionError('restarting');
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
    const transport = this.transport;
    if (!transport) return;
    this.terminating = true;
    this.exitReason = reason;
    await transport.kill();
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
        const engineSessionId = change.engineSessionId || session.engineSessionId;
        if (this.clearPending) {
          this.clearPending = false;
          this.clearedTo = engineSessionId;
        }
        const updated: SessionRecord = {
          ...(this.session ?? session),
          engineSessionId,
          model: change.model,
          cliVersion: change.cliVersion,
          conversationStarted: engineSessionId !== this.clearedTo,
        };
        this.session = updated;
        this.persist(() => store.saveSession(updated));
        this.mcpServers = change.mcpServers;
        this.skills = change.skills;
        this.skillsKnown = true;
        patch.session = sessionView(updated, this.permissionMode);
        patch.mcpServers = change.mcpServers;
        patch.skills = change.skills;
        patch.skillsKnown = true;
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

// The model as its engine names it, without the engine's prefix.
const modelOf = (modelChoice: string | null): string | null => (modelChoice === null ? null : (parseModelId(modelChoice)?.model ?? null));

// Claude's windows stay one set across its accounts and with no chat open, as before engines; another engine's are its account's own.
const limitKey = (session: SessionRecord | null): string =>
  (session === null || session.engine === 'claude' ? 'claude' : `${session.engine}:${session.accountId ?? 'system'}`);

// The model as claude's --model takes it; null for no model, or for one of another engine.
function claudeModel(modelChoice: string | null): string | null {
  const ref = modelChoice === null ? null : parseModelId(modelChoice);
  return ref?.engine === 'claude' ? ref.model : null;
}

function conversationArgs(session: SessionRecord, resume: boolean, mcpConfigPath: string, gateFlags: string[]): string[] {
  const model = claudeModel(session.modelChoice);
  return [
    resume ? '--resume' : '--session-id', session.engineSessionId,
    ...(model !== null ? ['--model', model] : []),
    ...(session.effort !== null && isClaudeEffort(session.effort) ? ['--effort', session.effort] : []),
    '--mcp-config', mcpConfigPath,
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    ...gateFlags,
    '--dangerously-skip-permissions',
  ];
}

function sessionView(session: SessionRecord, permissionMode: string | null): SessionView {
  return {
    id: session.id, engine: session.engine, engineSessionId: session.engineSessionId, status: session.status,
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

function crashNotice(exit: ProcessExit, engine: EngineId): string {
  const reason = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
  const lastLine = exit.stderr.trim().split('\n').at(-1);
  return `${ENGINE_BINARIES[engine]} stopped unexpectedly (${reason})${lastLine ? `: ${lastLine}` : ''}`;
}

async function stopStale(session: SessionRecord, graceMs: number): Promise<void> {
  const { pid, launchId } = session;
  if (pid === null || launchId === null) return;
  const launchedWith = new RegExp(`--(?:session-id|resume)[ =]${launchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  // A core started from that claude's Bash would stop itself with it.
  const isStale = () => launchedWith.test(commandLine(pid) ?? '') && !reaches(pid, process.pid);
  if (!isStale()) return;
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, STALE_POLL_MS));
  if (isAlive(pid) && isStale()) forceKill(pid);
}
