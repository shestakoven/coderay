import type { McpServerState } from '@ide/protocol';
import { isRecord } from '../json';
import type { UsageUpdate } from './usage';

export interface ToolResultBlock {
  toolUseId: string;
  isError: boolean;
  text: string;
  // The base64 data of the result's image parts, in order; their claimed media type is not kept, the bytes decide.
  images: string[];
}

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown };

export type StreamEvent =
  | { type: 'init'; sessionId: string; model: string | null; cliVersion: string | null; permissionMode: string | null; mcpServers: McpServerState[]; skills: string[] }
  | { type: 'mode'; permissionMode: string }
  | { type: 'assistant'; parentToolUseId: string | null; blocks: AssistantBlock[] }
  | { type: 'user'; parentToolUseId: string | null; toolResults: ToolResultBlock[] }
  | { type: 'text_delta'; parentToolUseId: string | null; text: string }
  | { type: 'result'; subtype: string; origin: string | null }
  | { type: 'task_started'; taskId: string; toolUseId: string | null; backgrounded: boolean; description: string }
  | { type: 'task_notification'; taskId: string; toolUseId: string | null; status: string }
  | { type: 'task_updated'; taskId: string; status: string | null }
  | { type: 'conversation_reset'; trigger: string | null }
  | { type: 'compact_boundary'; trigger: string | null; preTokens: number | null; postTokens: number | null }
  | { type: 'command_output'; text: string }
  | { type: 'usage'; update: UsageUpdate }
  | { type: 'control_request'; requestId: string; subtype: string; toolName: string | null; input: unknown }
  | { type: 'control_cancel'; requestId: string }
  | { type: 'ignored' }
  | { type: 'unknown'; label: string };

const IGNORED_TYPES = new Set(['rate_limit_event', 'control_response', 'tool_progress', 'active_goal', 'autocompact_state']);
const IGNORED_SYSTEM = new Set([
  'hook_started', 'hook_progress', 'hook_response', 'thinking_tokens', 'status',
  'task_progress', 'background_tasks_changed', 'commands_changed',
  // The agent SDK's run bookkeeping, which it hands over too; the session keeps its own.
  'session_state_changed', 'post_turn_summary', 'task_summary', 'session_metadata',
]);

type Json = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One message as claude prints it on its stream-json output, which is also what the agent SDK hands over. */
export function parseStreamMessage(event: unknown): StreamEvent {
  if (!isRecord(event)) return { type: 'unknown', label: 'not an object' };
  const type = text(event.type) ?? 'missing type';
  const parentToolUseId = text(event.parent_tool_use_id);
  switch (type) {
    case 'system':
      return parseSystem(event);
    case 'assistant':
      return { type: 'assistant', parentToolUseId, blocks: contentBlocks(event).flatMap(assistantBlock) };
    case 'user':
      return { type: 'user', parentToolUseId, toolResults: contentBlocks(event).flatMap(toolResult) };
    case 'stream_event':
      return textDelta(event, parentToolUseId);
    case 'result': {
      const origin = event.origin;
      return { type: 'result', subtype: text(event.subtype) ?? 'unknown', origin: isRecord(origin) ? (text(origin.kind) ?? 'unknown') : null };
    }
    case 'conversation_reset':
      return { type: 'conversation_reset', trigger: text(event.trigger) };
    case 'control_request': {
      const request = isRecord(event.request) ? event.request : {};
      return {
        type: 'control_request', requestId: text(event.request_id) ?? '', subtype: text(request.subtype) ?? 'unknown',
        toolName: text(request.tool_name), input: request.input,
      };
    }
    case 'control_cancel_request':
      return { type: 'control_cancel', requestId: text(event.request_id) ?? '' };
    default:
      return IGNORED_TYPES.has(type) ? { type: 'ignored' } : { type: 'unknown', label: type };
  }
}

function textDelta(event: Json, parentToolUseId: string | null): StreamEvent {
  const inner = isRecord(event.event) ? event.event : {};
  const delta = isRecord(inner.delta) ? inner.delta : {};
  const chunk = inner.type === 'content_block_delta' && delta.type === 'text_delta' ? text(delta.text) : null;
  return chunk === null || chunk === '' ? { type: 'ignored' } : { type: 'text_delta', parentToolUseId, text: chunk };
}

function parseSystem(event: Json): StreamEvent {
  const subtype = text(event.subtype) ?? 'missing subtype';
  if (subtype === 'init') {
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isRecord) : [];
    return {
      type: 'init',
      sessionId: text(event.session_id) ?? '',
      model: text(event.model),
      cliVersion: text(event.claude_code_version),
      permissionMode: text(event.permissionMode),
      mcpServers: servers.map((server) => ({ name: text(server.name) ?? '?', status: text(server.status) ?? 'unknown' })),
      skills: Array.isArray(event.skills) ? event.skills.flatMap((skill) => text(skill) ?? []) : [],
    };
  }
  if (subtype === 'task_started') {
    return {
      type: 'task_started', taskId: text(event.task_id) ?? '', toolUseId: text(event.tool_use_id),
      backgrounded: event.is_backgrounded !== false, description: text(event.description) ?? '',
    };
  }
  if (subtype === 'task_notification') {
    return { type: 'task_notification', taskId: text(event.task_id) ?? '', toolUseId: text(event.tool_use_id), status: text(event.status) ?? 'unknown' };
  }
  if (subtype === 'task_updated') {
    const patch = isRecord(event.patch) ? event.patch : {};
    return { type: 'task_updated', taskId: text(event.task_id) ?? '', status: text(patch.status) };
  }
  if (subtype === 'compact_boundary') {
    const meta = isRecord(event.compact_metadata) ? event.compact_metadata : {};
    return { type: 'compact_boundary', trigger: text(meta.trigger), preTokens: count(meta.pre_tokens), postTokens: count(meta.post_tokens) };
  }
  if (subtype === 'local_command_output') return { type: 'command_output', text: text(event.content) ?? '' };
  const permissionMode = text(event.permissionMode);
  if (subtype === 'status' && permissionMode !== null) return { type: 'mode', permissionMode };
  return IGNORED_SYSTEM.has(subtype) ? { type: 'ignored' } : { type: 'unknown', label: `system/${subtype}` };
}

function contentBlocks(event: Json): Json[] {
  const content = isRecord(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function assistantBlock(block: Json): AssistantBlock[] {
  if (block.type === 'text') return [{ kind: 'text', text: text(block.text) ?? '' }];
  if (block.type === 'thinking') return [{ kind: 'thinking', text: text(block.thinking) ?? '' }];
  if (block.type === 'tool_use') return [{ kind: 'tool_use', id: text(block.id) ?? '', name: text(block.name) ?? '?', input: block.input }];
  return [];
}

function toolResult(block: Json): ToolResultBlock[] {
  if (block.type !== 'tool_result') return [];
  const content = block.content;
  const parts = Array.isArray(content) ? content.filter(isRecord) : [];
  const body = typeof content === 'string' ? content : parts.map((part) => text(part.text) ?? '').join('\n');
  return [{ toolUseId: text(block.tool_use_id) ?? '', isError: block.is_error === true, text: body, images: parts.flatMap(imageData) }];
}

function imageData(part: Json): string[] {
  const source = part.source;
  if (part.type !== 'image' || !isRecord(source) || source.type !== 'base64') return [];
  const data = text(source.data);
  return data === null || data === '' ? [] : [data];
}
