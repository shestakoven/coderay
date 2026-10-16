import type { LimitWindow } from '@ide/protocol';
import { isRecord } from '../../json';
import type { AssistantBlock, StreamEvent, ToolResultBlock } from '../stream';
import type { FileUpdateChange, McpToolCallItem, RateLimitSnapshot, RateLimitWindow, ThreadItem, ThreadTokenUsage, Turn } from './protocol';

const WORDS: Record<number, string> = { 1: 'one', 5: 'five', 7: 'seven', 30: 'thirty' };
const SUBTYPES: Record<string, string> = { completed: 'success', interrupted: 'error_during_execution', failed: 'failed' };
// What the app-server tells that CodeRay shows another way (diffs and output from items, the gate's own prompts) or not at all.
const IGNORED = new Set([
  'thread/started', 'thread/status/changed', 'turn/diff/updated', 'serverRequest/resolved', 'account/updated', 'account/login/completed',
  'remoteControl/status/changed', 'hook/started', 'hook/completed', 'warning', 'configWarning', 'deprecationNotice', 'thread/goal/cleared',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
  'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress',
]);
// Items that are not tool calls and need no row of their own: the user's message, the reply (its deltas and completion), the reasoning.
const QUIET_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning']);

/** A limit window Codex reports by its length, labelled the way the meters label Claude's ("5h", "7d"). */
export function limitWindow(window: RateLimitWindow | null): LimitWindow | null {
  if (!window || window.windowDurationMins === null || window.resetsAt === null) return null;
  const minutes = window.windowDurationMins;
  const [count, unit, word] = minutes % 1440 === 0 ? [minutes / 1440, 'd', 'day'] : minutes % 60 === 0 ? [minutes / 60, 'h', 'hour'] : [minutes, 'm', 'minute'];
  return { label: `${count}${unit}`, name: `${WORDS[count] ?? count}-${word}`, minutes, utilization: window.usedPercent / 100, resetsAt: window.resetsAt };
}

// The command as the user typed it to the model, not codex's shell wrapper around it.
const shown = (item: Extract<ThreadItem, { type: 'commandExecution' }>): string => item.commandActions.map((action) => action.command).join(' && ') || item.command;

function toolUse(item: ThreadItem): AssistantBlock | null {
  if (item.type === 'commandExecution') return { kind: 'tool_use', id: item.id, name: 'Bash', input: { command: shown(item) } };
  if (item.type === 'fileChange') {
    const first = item.changes[0];
    const created = item.changes.length === 1 && first?.kind.type === 'add';
    return { kind: 'tool_use', id: item.id, name: created ? 'Write' : 'Edit', input: { file_path: first?.path ?? '', ...(item.changes.length > 1 ? { files: item.changes.map((change) => change.path) } : {}) } };
  }
  if (item.type === 'mcpToolCall') return { kind: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
  return null;
}

function toolResult(item: ThreadItem): ToolResultBlock | null {
  if (item.type === 'commandExecution') {
    return { toolUseId: item.id, isError: item.status !== 'completed' || (item.exitCode ?? 0) !== 0, rejected: item.status === 'declined', text: item.aggregatedOutput ?? '', images: [] };
  }
  if (item.type === 'fileChange') return { toolUseId: item.id, isError: item.status !== 'completed', rejected: item.status === 'declined', text: item.status === 'completed' ? 'Applied.' : item.status, images: [] };
  if (item.type === 'mcpToolCall') {
    const text = item.error?.message ?? (item.result?.content ?? []).map((part) => part.text ?? '').join('\n');
    return { toolUseId: item.id, isError: item.status !== 'completed' || item.error !== null, rejected: false, text, images: [] };
  }
  return null;
}

function rateLimits(snapshot: unknown): LimitWindow[] {
  if (!isRecord(snapshot)) return [];
  const { primary, secondary } = snapshot as unknown as RateLimitSnapshot;
  return [limitWindow(primary), limitWindow(secondary)].filter((window): window is LimitWindow => window !== null);
}

/** Turns the app-server's notifications into the session's events, with tool names in Claude's vocabulary. */
export class CodexEvents {
  private threadId = '';
  private model: string | null = null;
  private cliVersion: string | null = null;
  private skills: string[] = [];
  private readonly servers = new Map<string, string>();
  private readonly open = new Map<string, ThreadItem>();
  // codex reports an error it gave up on, then fails the turn with the same message: the user reads it once.
  private lastError: string | null = null;

  thread(threadId: string, model: string | null, cliVersion: string | null): void {
    this.threadId = threadId;
    this.model = model;
    this.cliVersion = cliVersion;
  }

  setModel(model: string | null): void {
    if (model !== null) this.model = model;
  }

  setSkills(names: string[]): void {
    this.skills = names;
  }

  item(id: string): ThreadItem | undefined {
    return this.open.get(id);
  }

  mcpCalls(): McpToolCallItem[] {
    return [...this.open.values()].filter((item): item is McpToolCallItem => item.type === 'mcpToolCall');
  }

  handle(method: string, params: unknown): StreamEvent[] {
    if (!isRecord(params)) return [{ type: 'unknown', label: method }];
    switch (method) {
      case 'turn/started':
        this.lastError = null;
        return [{
          type: 'init', sessionId: this.threadId, model: this.model, cliVersion: this.cliVersion, permissionMode: null,
          mcpServers: [...this.servers].map(([name, status]) => ({ name, status })), skills: this.skills,
        }];
      case 'item/agentMessage/delta':
        return typeof params.delta === 'string' && params.delta !== '' ? [{ type: 'text_delta', parentToolUseId: null, text: params.delta }] : [];
      case 'item/started':
        return isRecord(params.item) ? this.started(params.item as unknown as ThreadItem) : [];
      case 'item/completed':
        return isRecord(params.item) ? this.completed(params.item as unknown as ThreadItem) : [];
      case 'item/fileChange/patchUpdated': {
        // A patch can change after it started; the gate judges the latest list of changes, never the first.
        const patch = typeof params.itemId === 'string' ? this.open.get(params.itemId) : undefined;
        if (patch?.type === 'fileChange' && Array.isArray(params.changes)) this.open.set(patch.id, { ...patch, changes: params.changes as FileUpdateChange[] });
        return [];
      }
      case 'turn/completed':
        return isRecord(params.turn) ? this.ended(params.turn as unknown as Turn) : [];
      case 'thread/tokenUsage/updated': {
        if (!isRecord(params.tokenUsage)) return [];
        const usage = params.tokenUsage as unknown as ThreadTokenUsage;
        return [{ type: 'usage', update: { contextTokens: usage.last.totalTokens, ...(usage.modelContextWindow === null ? {} : { contextWindow: usage.modelContextWindow }) } }];
      }
      case 'account/rateLimits/updated': {
        const limits = rateLimits(params.rateLimits);
        return limits.length === 0 ? [] : [{ type: 'usage', update: { limits } }];
      }
      case 'mcpServer/startupStatus/updated':
        if (typeof params.name === 'string' && typeof params.status === 'string') this.servers.set(params.name, params.status);
        return [];
      case 'error': {
        const error = isRecord(params.error) ? params.error : {};
        if (params.willRetry === true || typeof error.message !== 'string') return [];
        this.lastError = error.message;
        return [{ type: 'notice', text: `Codex: ${error.message}` }];
      }
      default:
        return IGNORED.has(method) ? [] : [{ type: 'unknown', label: method }];
    }
  }

  private started(item: ThreadItem): StreamEvent[] {
    const use = toolUse(item);
    if (!use) return QUIET_ITEMS.has(item.type) ? [] : [{ type: 'unknown', label: `item/${item.type}` }];
    this.open.set(item.id, item);
    return [{ type: 'assistant', parentToolUseId: null, blocks: [use] }];
  }

  private completed(item: ThreadItem): StreamEvent[] {
    if (item.type === 'agentMessage') return item.text.trim() === '' ? [] : [{ type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: item.text }] }];
    const result = this.open.delete(item.id) ? toolResult(item) : null;
    return result ? [{ type: 'user', parentToolUseId: null, toolResults: [result] }] : [];
  }

  // Interrupted commands and MCP calls never complete: the turn's end closes them (the tracker marks them unfinished).
  private ended(turn: Turn): StreamEvent[] {
    this.open.clear();
    const said = this.lastError;
    this.lastError = null;
    const failure: StreamEvent[] = turn.status === 'failed' && turn.error && turn.error.message !== said ? [{ type: 'notice', text: `Codex: ${turn.error.message}` }] : [];
    return [...failure, { type: 'result', subtype: SUBTYPES[turn.status] ?? turn.status, origin: null }];
  }
}
