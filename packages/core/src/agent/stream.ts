import type { McpServerState } from '@ide/protocol';
import { isRecord } from '../json';

export interface ToolResultBlock {
  toolUseId: string;
  isError: boolean;
  text: string;
}

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown };

export type StreamEvent =
  | { type: 'init'; sessionId: string; model: string | null; cliVersion: string | null; permissionMode: string | null; mcpServers: McpServerState[] }
  | { type: 'mode'; permissionMode: string }
  | { type: 'assistant'; parentToolUseId: string | null; blocks: AssistantBlock[] }
  | { type: 'user'; parentToolUseId: string | null; toolResults: ToolResultBlock[] }
  | { type: 'text_delta'; parentToolUseId: string | null; text: string }
  | { type: 'result'; subtype: string; origin: string | null }
  | { type: 'task_started'; taskId: string; toolUseId: string | null; backgrounded: boolean; description: string }
  | { type: 'task_notification'; taskId: string; toolUseId: string | null; status: string }
  | { type: 'task_updated'; taskId: string; status: string | null }
  | { type: 'control_request'; requestId: string; subtype: string; toolName: string | null; input: unknown }
  | { type: 'control_cancel'; requestId: string }
  | { type: 'ignored' }
  | { type: 'unknown'; label: string };

const IGNORED_TYPES = new Set(['rate_limit_event', 'control_response', 'tool_progress']);
const IGNORED_SYSTEM = new Set([
  'hook_started', 'hook_progress', 'hook_response', 'thinking_tokens', 'status',
  'task_progress', 'background_tasks_changed', 'compact_boundary', 'commands_changed',
]);

type Json = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function parseStreamLine(line: string): StreamEvent | null {
  if (line.trim() === '') return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { type: 'unknown', label: 'invalid JSON' };
  }
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
  if (block.type === 'tool_use') return [{ kind: 'tool_use', id: text(block.id) ?? '', name: text(block.name) ?? '?', input: block.input }];
  return [];
}

function toolResult(block: Json): ToolResultBlock[] {
  if (block.type !== 'tool_result') return [];
  const content = block.content;
  const body = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter(isRecord).map((part) => text(part.text) ?? '').join('\n') : '';
  return [{ toolUseId: text(block.tool_use_id) ?? '', isError: block.is_error === true, text: body }];
}
