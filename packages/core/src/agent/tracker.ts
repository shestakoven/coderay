import { randomUUID } from 'node:crypto';
import type { McpServerState, PromptAnswer, PromptBody, PromptStatus, TaskKind, TaskView, ToolStatus, TurnKind, TurnView } from '@ide/protocol';
import type { MessageRecord, PromptRecord, ToolEventRecord } from '../store/store';
import type { AgentEvent, BackgroundTask, TaskNotice } from './hook-events';
import type { AssistantBlock, StreamEvent, ToolResultBlock } from './stream';

export type Change =
  | { kind: 'turn'; turn: TurnView }
  | { kind: 'message'; message: MessageRecord }
  | { kind: 'tool'; tool: ToolEventRecord }
  | { kind: 'task'; task: TaskView }
  | { kind: 'prompt'; prompt: PromptRecord }
  | { kind: 'init'; engineSessionId: string; model: string | null; cliVersion: string | null; mcpServers: McpServerState[]; skills: string[] }
  | { kind: 'mode'; permissionMode: string | null };

export interface OpenWork {
  turns: TurnView[];
  tools: ToolEventRecord[];
  tasks: TaskView[];
  prompts: PromptRecord[];
}

export interface ToolEndInfo {
  toolUseId: string;
  tool: string;
  parentToolUseId: string | null;
  status: ToolStatus;
  toolUseAt: number;
  endedAt: number;
}

export interface TrackerOptions {
  nextSeq?: number;
  open?: OpenWork;
  now?: () => number;
  mono?: () => number;
  newId?: () => string;
}

// Recorded: completed and killed (task_updated), completed and stopped (task_notification); the rest cannot mean "still running".
export const TERMINAL_TASK_STATUSES = new Set(['completed', 'killed', 'stopped', 'failed', 'error', 'cancelled']);

const TASK_KINDS: Record<string, TaskKind> = { Agent: 'subagent', Task: 'subagent', spawn_agent: 'subagent', Bash: 'shell', Monitor: 'monitor' };
const REJECTED = "The user doesn't want to proceed with this tool use";
const PLAN_MODE = 'plan';

export class TurnTracker {
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly toolStarts = new Map<string, number>();
  private readonly toolEnds = new Map<string, ToolEndInfo>();
  private readonly newId: () => string;
  private seq: number;
  private readonly openTurns: TurnView[];
  private readonly openTools: Map<string, ToolEventRecord>;
  private readonly openTasks: Map<string, TaskView>;
  private readonly openPrompts: Map<string, PromptRecord>;
  private readonly backgroundTasks: Map<string, TaskView>;
  private readonly toolNames = new Map<string, string>();
  private readonly agentTools = new Map<string, string>();
  private running: string | null = null;
  private lastText: string | null = null;
  private waitingForInit: string[] = [];
  private permissionMode: string | null = null;

  constructor(options: TrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mono = options.mono ?? (() => performance.now());
    this.newId = options.newId ?? randomUUID;
    this.seq = options.nextSeq ?? 1;
    this.openTurns = [...(options.open?.turns ?? [])];
    this.openTools = new Map((options.open?.tools ?? []).map((tool) => [tool.toolUseId, tool]));
    this.openTasks = new Map((options.open?.tasks ?? []).map((task) => [task.id, task]));
    this.openPrompts = new Map((options.open?.prompts ?? []).map((prompt) => [prompt.requestId, prompt]));
    this.backgroundTasks = new Map(this.openTasks);
  }

  hasOpenTurn(): boolean {
    return this.openTurns.length > 0;
  }

  openTurnId(): string | null {
    return this.running ?? this.openTurns[0]?.id ?? null;
  }

  endInfo(toolUseId: string): ToolEndInfo | null {
    const info = this.toolEnds.get(toolUseId) ?? null;
    this.toolEnds.delete(toolUseId);
    return info;
  }

  canInterrupt(): boolean {
    return this.openTurns.some((turn) => turn.startedAt !== null);
  }

  userMessage(text: string): Change[] {
    const turn = this.openTurn('user', null);
    this.waitingForInit.push(turn.id);
    return [{ kind: 'turn', turn }, this.message(turn.id, null, 'user', text)];
  }

  // Spike c27b: a message written into an open turn is absorbed at the next tool boundary, with no init or result of its own.
  injectedMessage(text: string): Change[] {
    return [this.message(this.running ?? this.openTurns[0]?.id ?? null, null, 'user', text)];
  }

  notice(text: string): Change[] {
    return [this.message(this.running, null, 'notice', text)];
  }

  prompt(requestId: string, body: PromptBody): Change[] {
    const prompt: PromptRecord = {
      requestId, seq: this.seq++, turnId: this.running, parentToolUseId: null, body, status: 'pending', answer: null, ts: this.now(),
    };
    this.openPrompts.set(requestId, prompt);
    return [{ kind: 'prompt', prompt }];
  }

  promptAnswered(requestId: string, answer: PromptAnswer): Change[] {
    return this.endPrompt(requestId, 'answered', answer);
  }

  event(event: StreamEvent): Change[] {
    switch (event.type) {
      case 'init':
        return this.init(event);
      case 'mode':
        return this.mode(event.permissionMode);
      case 'assistant':
        return this.assistant(event.parentToolUseId, event.blocks);
      case 'user':
        return this.toolResults(event.toolResults);
      case 'result':
        return this.result(event.subtype, event.origin !== null);
      case 'task_started':
        return event.backgrounded ? this.taskStarted(event.taskId, event.toolUseId, event.description) : [];
      case 'task_notification':
        return this.taskNotification(event.taskId, event.status);
      case 'task_updated':
        return event.status !== null && TERMINAL_TASK_STATUSES.has(event.status) ? this.endTask(event.taskId, event.status) : [];
      case 'control_cancel':
        return this.endPrompt(event.requestId, 'dropped', null);
      default:
        return [];
    }
  }

  // An agent in a terminal reports through hooks; its turns, tools and tasks become the same records as a chat's.
  agentEvent(event: AgentEvent): Change[] {
    switch (event.type) {
      case 'prompt':
        return event.task ? this.taskPrompt(event.task) : this.prompted(event.text);
      case 'tool-start':
        return this.toolStarted(event.toolUseId, event.tool, event.input, event.agentId);
      case 'tool-end':
        return this.toolEnded(event.toolUseId, event.status, event.launched);
      case 'turn-end':
        return this.turnEnded(event.lastMessage, event.failed, event.runningTaskIds);
      case 'subagent-start':
        return this.subagentStarted(event.agentId, event.agentType);
      case 'subagent-stop':
        return this.subagentStopped(event.agentId, event.lastMessage);
      case 'interrupted':
        return [...this.openTurns].flatMap((turn) => this.close(turn.id, 'error_during_execution', turn.kind));
      case 'assistant-text':
        return this.assistantText(event.text);
      default:
        return [];
    }
  }

  // A call the gate denies never runs, so no hook reports its end.
  toolRejected(toolUseId: string): Change[] {
    return this.endTool(toolUseId, 'rejected');
  }

  processExited(): Change[] {
    const now = this.now();
    const changes = this.closeTools(() => true, now);
    for (const task of this.openTasks.values()) changes.push({ kind: 'task', task: { ...task, status: 'unfinished', endedAt: now } });
    this.openTasks.clear();
    for (const prompt of this.openPrompts.values()) changes.push({ kind: 'prompt', prompt: { ...prompt, status: 'dropped' } });
    this.openPrompts.clear();
    for (const turn of this.openTurns.splice(0)) changes.push({ kind: 'turn', turn: { ...turn, closedAt: now, resultSubtype: 'crashed' } });
    this.running = null;
    this.waitingForInit = [];
    changes.push(...this.mode(null));
    return changes;
  }

  private init(event: Extract<StreamEvent, { type: 'init' }>): Change[] {
    const changes: Change[] = [{ kind: 'init', engineSessionId: event.sessionId, model: event.model, cliVersion: event.cliVersion, mcpServers: event.mcpServers, skills: event.skills }];
    if (this.running === null) changes.push(...this.startTurn());
    changes.push(...this.mode(event.permissionMode));
    return changes;
  }

  private prompted(text: string): Change[] {
    if (this.running !== null) return this.injectedMessage(text);
    return [...this.userMessage(text), ...this.startTurn()];
  }

  private taskPrompt(task: TaskNotice): Change[] {
    const changes = this.taskNotification(task.taskId, task.status);
    return this.running === null ? [...changes, ...this.startTurn()] : changes;
  }

  private toolStarted(toolUseId: string, name: string, input: unknown, agentId: string | null): Change[] {
    if (this.openTools.has(toolUseId)) return [];
    const parentToolUseId = agentId === null ? null : this.agentTools.get(agentId) ?? null;
    return this.assistant(parentToolUseId, [{ kind: 'tool_use', id: toolUseId, name, input }]);
  }

  private toolEnded(toolUseId: string, status: 'ok' | 'error', launched: BackgroundTask | null): Change[] {
    const tool = this.openTools.get(toolUseId);
    const changes = this.endTool(toolUseId, status);
    if (!tool || !launched) return changes;
    if (launched.kind === 'subagent') this.agentTools.set(launched.id, toolUseId);
    const input = tool.input as { description?: unknown } | null;
    return [...changes, ...this.taskStarted(launched.id, toolUseId, typeof input?.description === 'string' ? input.description : tool.tool)];
  }

  private endTool(toolUseId: string, status: ToolStatus): Change[] {
    const tool = this.openTools.get(toolUseId);
    if (!tool) return [];
    this.openTools.delete(toolUseId);
    this.finish(tool, status);
    return [{ kind: 'tool', tool: { ...tool, status, endedAt: this.now() } }];
  }

  private turnEnded(lastMessage: string | null, failed: boolean, runningTaskIds: string[] | null): Change[] {
    const turn = this.openTurns.find((open) => open.id === this.running) ?? this.openTurns[0];
    const changes: Change[] = [];
    if (turn) {
      if (lastMessage !== null && lastMessage.trim() !== '' && lastMessage.trim() !== this.lastText?.trim()) {
        changes.push(this.message(turn.id, null, 'assistant', lastMessage));
      }
      changes.push(...this.close(turn.id, failed ? 'error' : 'success', turn.kind));
    }
    if (runningTaskIds !== null) {
      for (const id of [...this.openTasks.keys()]) if (!runningTaskIds.includes(id)) changes.push(...this.endTask(id, 'completed'));
    }
    return changes;
  }

  // The hooks do not say which call started a synchronous subagent: subagents start in call order, so it is the oldest
  // call of the agent's type that has none yet.
  private subagentStarted(agentId: string, agentType: string): Change[] {
    if (this.agentTools.has(agentId)) return [];
    const taken = new Set(this.agentTools.values());
    const free = [...this.openTools.values()].filter((open) => TASK_KINDS[open.tool] === 'subagent' && !taken.has(open.toolUseId));
    const typed = free.find((open) => (open.input as { subagent_type?: unknown } | null)?.subagent_type === agentType);
    const tool = typed ?? free[0];
    if (tool) this.agentTools.set(agentId, tool.toolUseId);
    return [];
  }

  private subagentStopped(agentId: string, lastMessage: string | null): Change[] {
    const parent = this.agentTools.get(agentId) ?? null;
    const changes: Change[] = lastMessage !== null && lastMessage.trim() !== '' ? [this.message(null, parent, 'assistant', lastMessage)] : [];
    return [...changes, ...this.endTask(agentId, 'completed')];
  }

  private assistantText(text: string): Change[] {
    if (this.running === null) return [];
    this.lastText = text;
    return [this.message(this.running, null, 'assistant', text)];
  }

  private startTurn(): Change[] {
    const waiting = this.waitingForInit.shift();
    const turn = waiting === undefined ? undefined : this.openTurns.find((open) => open.id === waiting);
    const started = turn ? { ...turn, startedAt: this.now() } : this.openTurn('agent-initiated', this.now());
    if (turn) this.openTurns[this.openTurns.indexOf(turn)] = started;
    this.running = started.id;
    this.lastText = null;
    return [{ kind: 'turn', turn: started }];
  }

  private mode(permissionMode: string | null): Change[] {
    const previous = this.permissionMode;
    if (permissionMode === previous) return [];
    this.permissionMode = permissionMode;
    const changes: Change[] = [{ kind: 'mode', permissionMode }];
    if (permissionMode === PLAN_MODE) {
      changes.push(...this.notice('The agent entered plan mode: it explores and plans, and changes no files until you approve a plan.'));
    } else if (previous === PLAN_MODE && permissionMode !== null) {
      changes.push(...this.notice('The agent left plan mode.'));
    }
    return changes;
  }

  private result(subtype: string, hasOrigin: boolean): Change[] {
    const id = this.running ?? this.openTurns[0]?.id;
    return id === undefined ? [] : this.close(id, subtype, hasOrigin ? 'agent-initiated' : 'user');
  }

  private close(id: string, subtype: string, kind: TurnKind): Change[] {
    const index = this.openTurns.findIndex((turn) => turn.id === id);
    const turn = index === -1 ? undefined : this.openTurns.splice(index, 1)[0];
    if (!turn) return [];
    this.waitingForInit = this.waitingForInit.filter((waiting) => waiting !== id);
    if (this.running === id) this.running = null;
    const now = this.now();
    const changes = this.closeTools((tool) => tool.turnId === id, now);
    for (const prompt of [...this.openPrompts.values()]) {
      if (prompt.turnId === id) changes.push(...this.endPrompt(prompt.requestId, 'dropped', null));
    }
    changes.push({ kind: 'turn', turn: { ...turn, kind, closedAt: now, resultSubtype: subtype } });
    return changes;
  }

  private assistant(parentToolUseId: string | null, blocks: AssistantBlock[]): Change[] {
    const turnId = parentToolUseId === null ? this.running : null;
    const changes: Change[] = [];
    for (const block of blocks) {
      if (block.kind === 'text') {
        if (block.text.trim() !== '') changes.push(this.message(turnId, parentToolUseId, 'assistant', block.text));
        continue;
      }
      if (block.kind === 'thinking') continue;
      this.toolNames.set(block.id, block.name);
      const tool: ToolEventRecord = {
        toolUseId: block.id, seq: this.seq++, turnId, parentToolUseId, tool: block.name, input: block.input,
        status: 'running', toolUseAt: this.now(), endedAt: null,
      };
      this.openTools.set(tool.toolUseId, tool);
      this.toolStarts.set(tool.toolUseId, this.mono());
      changes.push({ kind: 'tool', tool });
    }
    return changes;
  }

  private toolResults(results: ToolResultBlock[]): Change[] {
    const changes: Change[] = [];
    for (const result of results) {
      const status = result.text.trimStart().startsWith(REJECTED) ? 'rejected' : result.isError ? 'error' : 'ok';
      changes.push(...this.endTool(result.toolUseId, status));
    }
    return changes;
  }

  private taskStarted(taskId: string, toolUseId: string | null, description: string): Change[] {
    const toolName = toolUseId === null ? undefined : this.toolNames.get(toolUseId);
    const kind = (toolName && TASK_KINDS[toolName]) || 'other';
    const task: TaskView = { id: taskId, toolUseId, kind, description, status: 'running', startedAt: this.now(), endedAt: null };
    this.openTasks.set(taskId, task);
    this.backgroundTasks.set(taskId, task);
    return [{ kind: 'task', task }];
  }

  private taskNotification(taskId: string, status: string): Change[] {
    const task = this.backgroundTasks.get(taskId);
    if (!task) return [];
    const ended = TERMINAL_TASK_STATUSES.has(status) ? this.endTask(taskId, status) : [];
    return [...ended, ...this.notice(`Background ${task.kind} ${status}: ${task.description}`)];
  }

  private endTask(taskId: string, status: string): Change[] {
    const task = this.openTasks.get(taskId);
    if (!task) return [];
    this.openTasks.delete(taskId);
    const now = this.now();
    const changes: Change[] = [{ kind: 'task', task: { ...task, status, endedAt: now } }];
    if (task.toolUseId !== null) changes.push(...this.closeTools((tool) => tool.parentToolUseId === task.toolUseId, now));
    return changes;
  }

  private endPrompt(requestId: string, status: PromptStatus, answer: PromptAnswer | null): Change[] {
    const prompt = this.openPrompts.get(requestId);
    if (!prompt) return [];
    this.openPrompts.delete(requestId);
    return [{ kind: 'prompt', prompt: { ...prompt, status, answer } }];
  }

  private closeTools(matches: (tool: ToolEventRecord) => boolean, now: number): Change[] {
    const changes: Change[] = [];
    for (const tool of [...this.openTools.values()]) {
      if (!matches(tool)) continue;
      this.openTools.delete(tool.toolUseId);
      changes.push({ kind: 'tool', tool: { ...tool, status: 'unfinished', endedAt: now } });
      this.finish(tool, 'unfinished');
    }
    return changes;
  }

  private finish(tool: ToolEventRecord, status: ToolStatus): void {
    const endedAt = this.mono();
    const toolUseAt = this.toolStarts.get(tool.toolUseId) ?? endedAt;
    this.toolStarts.delete(tool.toolUseId);
    this.toolEnds.set(tool.toolUseId, { toolUseId: tool.toolUseId, tool: tool.tool, parentToolUseId: tool.parentToolUseId, status, toolUseAt, endedAt });
  }

  private openTurn(kind: TurnKind, startedAt: number | null): TurnView {
    const turn: TurnView = { id: this.newId(), kind, openedAt: this.now(), startedAt, closedAt: null, resultSubtype: null };
    this.openTurns.push(turn);
    return turn;
  }

  private message(turnId: string | null, parentToolUseId: string | null, role: MessageRecord['role'], text: string): Change {
    return { kind: 'message', message: { id: this.newId(), seq: this.seq++, turnId, parentToolUseId, role, text, ts: this.now() } };
  }
}
