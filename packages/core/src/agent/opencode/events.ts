import { isRecord } from '../../json';
import type { StreamEvent, ToolResultBlock } from '../stream';
import type { SseEvent } from './api';

/** How opencode's error for a tool call begins when the user (or CodeRay's gate) refused it. */
export const REJECTED_PREFIX = 'The user rejected permission';

const NAMES = new Map(Object.entries({
  bash: 'Bash', read: 'Read', glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', codesearch: 'Grep',
  lsp: 'LSP', task: 'Task', todowrite: 'TodoWrite', question: 'AskUserQuestion', skill: 'Skill',
}));
// apply_patch's own format: one header per file the patch adds, updates or deletes.
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
// What opencode tells that CodeRay shows another way or not at all; the asks and their replies are the transport's.
const IGNORED = new Set([
  'server.heartbeat', 'server.connected', 'server.instance.disposed', 'session.updated', 'session.deleted', 'session.diff', 'todo.updated',
  'message.updated', 'message.removed', 'file.edited', 'file.watcher.updated', 'lsp.client.diagnostics', 'installation.updated',
  'plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated', 'command.executed',
  'permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected',
]);
// A step's start and the files a step changed need no row of their own.
const QUIET_PARTS = new Set(['step-start', 'patch']);

interface OpenCall {
  parent: string | null;
  session: string;
  task: boolean;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function patchFiles(input: Record<string, unknown>): [kind: string, path: string][] {
  const patch = text(input.patchText) ?? '';
  return [...patch.matchAll(PATCH_FILE)].map((match) => [match[1] ?? '', match[2] ?? '']);
}

/** opencode's tool name in Claude's vocabulary (the gate, tracker, map and UI know only those). */
export function toolName(tool: string, input: Record<string, unknown>, servers: string[]): string {
  if (tool === 'write') return 'Write';
  if (tool === 'edit') return input.oldString === '' ? 'Write' : 'Edit';
  if (tool === 'apply_patch') return patchFiles(input).every(([kind]) => kind === 'Add') ? 'Write' : 'Edit';
  const name = NAMES.get(tool);
  if (name !== undefined) return name;
  // opencode names an MCP tool `<server>_<tool>`; the longest server wins when one name starts another.
  const server = servers.filter((candidate) => tool.startsWith(`${candidate}_`)).sort((a, b) => b.length - a.length)[0];
  return server === undefined ? tool : `mcp__${server}__${tool.slice(server.length + 1)}`;
}

// What a row shows of the call: Claude's `file_path` and `command`, not opencode's whole input.
function shownInput(tool: string, input: Record<string, unknown>): unknown {
  if (tool === 'bash') return { command: text(input.command) ?? '', ...(typeof input.workdir === 'string' ? { workdir: input.workdir } : {}) };
  if (tool === 'apply_patch') {
    const files = patchFiles(input).map(([, path]) => path);
    return { file_path: files[0] ?? '', ...(files.length > 1 ? { files } : {}) };
  }
  return typeof input.filePath === 'string' ? { file_path: input.filePath } : input;
}

/** Turns opencode's SSE events into the session's events, with tool names in Claude's vocabulary. */
export class OpencodeEvents {
  private readonly servers: string[];
  private chat = '';
  private model: string | null = null;
  private version: string | null = null;
  private window: number | null = null;
  private skills: string[] = [];
  // A child session → the task call its parts show under.
  private readonly children = new Map<string, string | null>();
  private readonly open = new Map<string, OpenCall>();
  private readonly inputs = new Map<string, Record<string, unknown>>();
  // Text parts under way: their deltas are the reply's (reasoning streams as `text` deltas of a part not shown yet).
  private readonly streaming = new Set<string>();
  private turn = false;
  private stopped = false;
  private failed = false;
  private lastError: string | null = null;
  // After a stop 1.19 sends a second session.idle; it must not end the turn that follows.
  private stray = false;

  constructor(servers: string[]) {
    this.servers = servers;
  }

  session(id: string, model: string | null, version: string | null, contextWindow: number | null): void {
    this.chat = id;
    this.model = model;
    this.version = version;
    this.window = contextWindow;
  }

  setModel(model: string | null, contextWindow: number | null): void {
    if (model !== null) this.model = model;
    this.window = contextWindow;
  }

  setSkills(names: string[]): void {
    this.skills = names;
  }

  /** A child session of the chat, and the task call that started it (its parts show under that call). */
  adopt(sessionID: string, parentID: string): void {
    if (this.children.has(sessionID)) return;
    // Parallel task calls start their sessions in the order they run: a child belongs to the first open task without one.
    const claimed = new Set(this.children.values());
    const task = [...this.open].find(([id, call]) => call.task && call.session === parentID && !claimed.has(id))?.[0];
    this.children.set(sessionID, task ?? null);
  }

  /** The session ids whose asks belong to the chat: the chat's and its children's. */
  owns(sessionID: string): boolean {
    return sessionID === this.chat || this.children.has(sessionID);
  }

  /** The latest `state.input` of a tool part, by callID (the ask that follows is judged with it). */
  input(callID: string): Record<string, unknown> | undefined {
    return this.inputs.get(callID);
  }

  /** The chat's turn is open (a prompt was accepted and session.idle has not come). */
  busy(): boolean {
    return this.turn;
  }

  turnStarted(): StreamEvent[] {
    this.turn = true;
    this.stopped = false;
    this.failed = false;
    this.lastError = null;
    this.inputs.clear();
    return [{ type: 'init', sessionId: this.chat, model: this.model, cliVersion: this.version, permissionMode: null, mcpServers: [], skills: this.skills }];
  }

  /** Marks the turn as stopped by the user: its idle reads as error_during_execution. */
  interrupted(): void {
    this.stopped = true;
  }

  handle(event: SseEvent): StreamEvent[] {
    const properties = event.properties;
    switch (event.type) {
      case 'message.part.updated':
        return isRecord(properties.part) ? this.part(properties.part) : [];
      case 'message.part.delta': {
        const sessionID = text(properties.sessionID);
        const delta = text(properties.delta);
        if (properties.field !== 'text' || sessionID === null || !this.streaming.has(text(properties.partID) ?? '') || !delta) return [];
        return [{ type: 'text_delta', parentToolUseId: this.parentOf(sessionID), text: delta }];
      }
      case 'session.created': {
        const info = isRecord(properties.info) ? properties.info : {};
        if (typeof info.id === 'string' && typeof info.parentID === 'string' && this.owns(info.parentID)) this.adopt(info.id, info.parentID);
        return [];
      }
      case 'session.status':
        if (properties.sessionID === this.chat && isRecord(properties.status) && properties.status.type === 'busy') this.stray = false;
        return [];
      case 'session.error':
        return properties.sessionID === this.chat ? this.error(properties.error) : [];
      case 'session.idle':
        return properties.sessionID === this.chat ? this.idle() : [];
      default:
        return IGNORED.has(event.type) ? [] : [{ type: 'unknown', label: event.type }];
    }
  }

  private parentOf(sessionID: string): string | null {
    return sessionID === this.chat ? null : (this.children.get(sessionID) ?? null);
  }

  private part(part: Record<string, unknown>): StreamEvent[] {
    const sessionID = text(part.sessionID);
    if (sessionID === null || !this.owns(sessionID)) return [];
    const parent = this.parentOf(sessionID);
    const type = text(part.type) ?? '';
    switch (type) {
      case 'text':
      case 'reasoning': {
        const id = text(part.id) ?? '';
        // A text with no end is under way, or the user's own message.
        if (!isRecord(part.time) || part.time.end === undefined) {
          if (type === 'text') this.streaming.add(id);
          return [];
        }
        this.streaming.delete(id);
        const body = text(part.text) ?? '';
        return body.trim() === '' ? [] : [{ type: 'assistant', parentToolUseId: parent, blocks: [{ kind: type === 'text' ? 'text' : 'thinking', text: body }] }];
      }
      case 'tool':
        return this.tool(part, sessionID, parent);
      case 'step-finish':
        // A subagent's steps fill its own context, not the chat's.
        return sessionID === this.chat ? this.usage(part.tokens) : [];
      default:
        return QUIET_PARTS.has(type) ? [] : [{ type: 'unknown', label: `part/${type}` }];
    }
  }

  private tool(part: Record<string, unknown>, sessionID: string, parent: string | null): StreamEvent[] {
    const callID = text(part.callID);
    const tool = text(part.tool);
    const state = isRecord(part.state) ? part.state : {};
    if (callID === null || tool === null) return [];
    // A pending part's input is always empty (1.19 fills it when the call runs): an ask that comes first finds no input.
    if (state.status !== 'pending' && isRecord(state.input)) this.inputs.set(callID, state.input);
    const input = this.inputs.get(callID) ?? {};
    if (state.status === 'running') {
      if (this.open.has(callID)) return [];
      this.open.set(callID, { parent, session: sessionID, task: tool === 'task' });
      return [{ type: 'assistant', parentToolUseId: parent, blocks: [{ kind: 'tool_use', id: callID, name: toolName(tool, input, this.servers), input: shownInput(tool, input) }] }];
    }
    if (state.status !== 'completed' && state.status !== 'error') return [];
    const call = this.open.get(callID);
    // A call that never showed, or one the turn's end already closed (1.19 ends a stopped tool after the idle).
    if (call === undefined) return [];
    this.open.delete(callID);
    let result: ToolResultBlock;
    if (state.status === 'completed') {
      const metadata = isRecord(state.metadata) ? state.metadata : {};
      const failed = tool === 'bash' && finite(metadata.exit) && metadata.exit !== 0;
      result = { toolUseId: callID, isError: failed, rejected: false, text: text(state.output) ?? '', images: [] };
    } else {
      const error = text(state.error) ?? '';
      result = { toolUseId: callID, isError: true, rejected: error.startsWith(REJECTED_PREFIX), text: error, images: [] };
    }
    return [{ type: 'user', parentToolUseId: call.parent, toolResults: [result] }];
  }

  // The meter shows the last step's whole prompt: its fresh input and what the cache read and wrote.
  private usage(tokens: unknown): StreamEvent[] {
    if (!isRecord(tokens) || !finite(tokens.input)) return [];
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const contextTokens = tokens.input + (finite(cache.read) ? cache.read : 0) + (finite(cache.write) ? cache.write : 0);
    return [{ type: 'usage', update: { contextTokens, ...(this.window !== null ? { contextWindow: this.window } : {}) } }];
  }

  private error(error: unknown): StreamEvent[] {
    const value = isRecord(error) ? error : {};
    // The user's stop: the turn's end says so.
    if (value.name === 'MessageAbortedError') return [];
    const data = isRecord(value.data) ? value.data : {};
    // An internal error carries its stack trace: the user reads its first line.
    const message = (text(data.message) ?? text(value.name) ?? 'an unknown error').replace(/\n.*/s, '');
    this.failed = true;
    if (message === this.lastError) return [];
    this.lastError = message;
    return [{ type: 'notice', text: `opencode: ${message}` }];
  }

  // Calls still open at the end were cut off (the tracker marks them unfinished).
  private idle(): StreamEvent[] {
    if (this.stray) {
      this.stray = false;
      return [];
    }
    if (!this.turn) return [];
    const closed = [...this.open].map(([id, call]): StreamEvent => ({
      type: 'user', parentToolUseId: call.parent, toolResults: [{ toolUseId: id, isError: true, rejected: false, text: 'unfinished', images: [] }],
    }));
    const subtype = this.stopped ? 'error_during_execution' : this.failed ? 'failed' : 'success';
    this.stray = this.stopped;
    this.turn = false;
    this.open.clear();
    this.streaming.clear();
    return [...closed, { type: 'result', subtype, origin: null }];
  }
}
