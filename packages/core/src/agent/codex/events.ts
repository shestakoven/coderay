import type { LimitWindow } from '@ide/protocol';
import { isRecord } from '../../json';
import type { AssistantBlock, StreamEvent, ToolResultBlock } from '../stream';
import type { FileUpdateChange, McpToolCallItem, RateLimitSnapshot, RateLimitWindow, ThreadItem, Turn } from './protocol';

const WORDS: Record<number, string> = { 1: 'one', 5: 'five', 7: 'seven', 30: 'thirty' };
const SUBTYPES: Record<string, string> = { completed: 'success', interrupted: 'error_during_execution', failed: 'failed' };
// A server's startup state in the session's words, the ones claude reports.
const SERVER_STATES: Record<string, string> = { ready: 'connected', starting: 'pending', failed: 'failed', cancelled: 'failed' };
// What the app-server tells that CodeRay shows another way (diffs and output from items, the gate's own prompts) or not at all.
const IGNORED = new Set([
  'thread/started', 'thread/status/changed', 'turn/diff/updated', 'serverRequest/resolved', 'account/updated', 'account/login/completed',
  'remoteControl/status/changed', 'hook/started', 'hook/completed', 'warning', 'configWarning', 'deprecationNotice', 'thread/goal/cleared',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
  'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress',
]);
// Items that are not tool calls and need no row of their own: the user's message, the reply (its deltas and completion), the reasoning.
const QUIET_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning']);
// codex runs a command as `<shell> -lc <script>`, the script quoted as one shell word.
const WRAPPED = /^\S+ -lc (.+)$/s;
const DOUBLE_QUOTED_ESCAPES = '$`"\\\n';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A limit window Codex reports by its length, labelled the way the meters label Claude's ("5h", "7d"). */
export function limitWindow(window: RateLimitWindow | null): LimitWindow | null {
  if (!isRecord(window) || !finite(window.windowDurationMins) || !finite(window.resetsAt) || !finite(window.usedPercent)) return null;
  const minutes = window.windowDurationMins;
  const [count, unit, word] = minutes % 1440 === 0 ? [minutes / 1440, 'd', 'day'] : minutes % 60 === 0 ? [minutes / 60, 'h', 'hour'] : [minutes, 'm', 'minute'];
  return { label: `${count}${unit}`, name: `${WORDS[count] ?? count}-${word}`, minutes, utilization: window.usedPercent / 100, resetsAt: window.resetsAt };
}

/** The one shell word `text` spells, or null when it is not exactly one word. */
export function shellWord(text: string): string | null {
  let word = '';
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      word += text.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < text.length && text.charAt(j) !== '"'; j++) {
        if (text.charAt(j) === '\\' && j + 1 < text.length && DOUBLE_QUOTED_ESCAPES.includes(text.charAt(j + 1))) j++;
        word += text.charAt(j);
      }
      if (j >= text.length) return null;
      i = j;
    } else if (char === '\\') {
      if (i + 1 >= text.length) return null;
      word += text.charAt(++i);
    } else if (/\s/.test(char)) {
      return null;
    } else {
      word += char;
    }
  }
  return word;
}

// The script the model wrote, not codex's shell around it; codex's parsed actions can drop pipes, so one action is only a fallback.
function shown(item: Extract<ThreadItem, { type: 'commandExecution' }>): string {
  const command = typeof item.command === 'string' ? item.command : '';
  const wrapped = WRAPPED.exec(command)?.[1];
  const script = wrapped === undefined ? null : shellWord(wrapped);
  if (script !== null) return script;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const only = actions.length === 1 ? actions[0] : undefined;
  return isRecord(only) && typeof only.command === 'string' ? only.command : command;
}

function toolUse(item: ThreadItem): AssistantBlock | null {
  if (item.type === 'commandExecution') return { kind: 'tool_use', id: item.id, name: 'Bash', input: { command: shown(item) } };
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const first = changes[0];
    const created = changes.length === 1 && first?.kind?.type === 'add';
    return { kind: 'tool_use', id: item.id, name: created ? 'Write' : 'Edit', input: { file_path: first?.path ?? '', ...(changes.length > 1 ? { files: changes.map((change) => change.path) } : {}) } };
  }
  if (item.type === 'mcpToolCall') return { kind: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
  return null;
}

function toolResult(item: ThreadItem): ToolResultBlock | null {
  if (item.type === 'commandExecution') {
    const text = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    return { toolUseId: item.id, isError: item.status !== 'completed' || (item.exitCode ?? 0) !== 0, rejected: item.status === 'declined', text, images: [] };
  }
  if (item.type === 'fileChange') return { toolUseId: item.id, isError: item.status !== 'completed', rejected: item.status === 'declined', text: item.status === 'completed' ? 'Applied.' : item.status, images: [] };
  if (item.type === 'mcpToolCall') {
    const error = isRecord(item.error) && typeof item.error.message === 'string' ? item.error.message : null;
    const content: unknown[] = isRecord(item.result) && Array.isArray(item.result.content) ? item.result.content : [];
    const text = error ?? content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n');
    return { toolUseId: item.id, isError: item.status !== 'completed' || isRecord(item.error), rejected: false, text, images: [] };
  }
  return null;
}

function rateLimits(snapshot: unknown): LimitWindow[] {
  if (!isRecord(snapshot)) return [];
  const { primary, secondary } = snapshot as unknown as RateLimitSnapshot;
  return [limitWindow(primary), limitWindow(secondary)].filter((window): window is LimitWindow => window !== null);
}

function contextUsage(tokenUsage: unknown): StreamEvent[] {
  const usage = isRecord(tokenUsage) ? tokenUsage : {};
  const last = isRecord(usage.last) ? usage.last : {};
  const update = {
    ...(finite(last.totalTokens) ? { contextTokens: last.totalTokens } : {}),
    ...(finite(usage.modelContextWindow) ? { contextWindow: usage.modelContextWindow } : {}),
  };
  return Object.keys(update).length === 0 ? [] : [{ type: 'usage', update }];
}

/** Turns the app-server's notifications into the session's events, with tool names in Claude's vocabulary. */
export class CodexEvents {
  private threadId = '';
  private model: string | null = null;
  private cliVersion: string | null = null;
  private skills: string[] = [];
  private readonly servers = new Map<string, string>();
  private readonly open = new Map<string, ThreadItem>();
  // MCP calls CodeRay declined: codex reports them failed, the session reads them as refused.
  private readonly rejected = new Set<string>();
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

  /** The gate declined this open call: its result reads as refused. */
  reject(itemId: string): void {
    if (this.open.has(itemId)) this.rejected.add(itemId);
  }

  handle(method: string, params: unknown): StreamEvent[] {
    if (!isRecord(params)) return [{ type: 'unknown', label: method }];
    // A sub-agent's thread reports on the same connection: the chat is its own thread only.
    if (this.threadId !== '' && typeof params.threadId === 'string' && params.threadId !== this.threadId) return [];
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
      case 'thread/tokenUsage/updated':
        return contextUsage(params.tokenUsage);
      case 'account/rateLimits/updated': {
        const limits = rateLimits(params.rateLimits);
        return limits.length === 0 ? [] : [{ type: 'usage', update: { limits } }];
      }
      case 'mcpServer/startupStatus/updated':
        if (typeof params.name === 'string' && typeof params.status === 'string') this.servers.set(params.name, SERVER_STATES[params.status] ?? params.status);
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
    if (item.type === 'agentMessage') {
      return typeof item.text === 'string' && item.text.trim() !== '' ? [{ type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: item.text }] }] : [];
    }
    if (!this.open.has(item.id)) return [];
    const result = toolResult(item);
    this.open.delete(item.id);
    const rejected = this.rejected.delete(item.id);
    return result ? [{ type: 'user', parentToolUseId: null, toolResults: [rejected ? { ...result, rejected } : result] }] : [];
  }

  // Interrupted commands and MCP calls never complete: the turn's end closes them (the tracker marks them unfinished).
  private ended(turn: Turn): StreamEvent[] {
    this.open.clear();
    this.rejected.clear();
    const said = this.lastError;
    this.lastError = null;
    const message = isRecord(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : null;
    const failure: StreamEvent[] = turn.status === 'failed' && message !== null && message !== said ? [{ type: 'notice', text: `Codex: ${message}` }] : [];
    return [...failure, { type: 'result', subtype: SUBTYPES[turn.status] ?? turn.status, origin: null }];
  }
}
