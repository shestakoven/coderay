import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../json';
import type { HookAnswer } from '../../gate/hook-gate';
import type { GateCall } from '../transport';
import type {
  ApprovalResponse, CommandExecutionRequestApprovalParams, ElicitationResponse, FileUpdateChange, JsonValue, McpServerElicitationRequestParams, McpToolCallItem,
  PermissionsRequestApprovalResponse,
} from './protocol';

export type Decide = (call: GateCall, signal: AbortSignal) => Promise<HookAnswer | null>;
export type Verdict = 'accept' | 'decline' | null;

// codex-cli 0.160 runs the tool on this accept.
const ELICITATION_ACCEPT_CONTENT: JsonValue = null;

const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

// A change of a kind or shape CodeRay does not know could write where no gate call looks.
function readable(change: unknown): change is FileUpdateChange {
  if (!isRecord(change) || typeof change.path !== 'string' || change.path === '' || typeof change.diff !== 'string' || !isRecord(change.kind)) return false;
  const { type, move_path: to } = change.kind;
  return type === 'add' || type === 'delete' || (type === 'update' && (to === null || (typeof to === 'string' && to !== '')));
}

/** One gate call per changed file: a new file a Write, an edit an Edit with its diff, a deletion or a move the shell command that does it; none when a change cannot be read. */
export function patchCalls(itemId: string, changes: FileUpdateChange[], cwd: string): GateCall[] {
  if (!Array.isArray(changes) || !changes.every(readable)) return [];
  return changes.map((change): GateCall => {
    const base = { tool_use_id: itemId, cwd };
    if (change.kind.type === 'add') return { ...base, tool_name: 'Write', tool_input: { file_path: change.path, content: change.diff } };
    if (change.kind.type === 'delete') return { ...base, tool_name: 'Bash', tool_input: { command: `rm -- ${quote(change.path)}` } };
    if (change.kind.move_path) return { ...base, tool_name: 'Bash', tool_input: { command: `mv -- ${quote(change.path)} ${quote(change.kind.move_path)}` } };
    return { ...base, tool_name: 'Edit', tool_input: { file_path: change.path, diff: change.diff } };
  });
}

/** An escalated command as the shell call it is; a stdin write, or a request that names no command, has nothing the gate can judge. */
export function commandCall(params: CommandExecutionRequestApprovalParams, cwd: string): GateCall | null {
  if (params.kind !== 'command' || typeof params.command !== 'string' || params.command === '') return null;
  const description = typeof params.reason === 'string' && params.reason !== '' ? { description: params.reason } : {};
  const where = typeof params.cwd === 'string' ? resolve(cwd, params.cwd) : cwd;
  return { tool_name: 'Bash', tool_input: { command: params.command, ...description }, tool_use_id: params.itemId, cwd: where };
}

// More permissions (network, file system) are never granted: the chat's sandbox stays read-only.
export const NO_PERMISSIONS: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };

/**
 * The MCP call an elicitation asks about: none comes with it, so the latest open call of that server with the same arguments.
 * Open calls of different tools with those arguments leave it unknown which one would run, so the elicitation links to none.
 */
export function elicitationCall(params: McpServerElicitationRequestParams, calls: McpToolCallItem[], cwd: string): GateCall | null {
  const meta = isRecord(params._meta) ? params._meta : null;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || (params.mode !== undefined && params.mode !== 'form')) return null;
  const matching = calls.filter((call) => call.server === params.serverName && isDeepStrictEqual(call.arguments, meta.tool_params));
  const item = matching.at(-1);
  if (!item || matching.some((call) => call.tool !== item.tool)) return null;
  return { tool_name: `mcp__${item.server}__${item.tool}`, tool_input: isRecord(item.arguments) ? item.arguments : {}, tool_use_id: item.id, cwd };
}

/** Accept only when every call is allowed; a denial or a gate that failed declines; a hold that ended without an answer leaves the request unanswered. */
export async function judge(calls: GateCall[], decide: Decide | undefined, signal: AbortSignal): Promise<Verdict> {
  if (!decide || calls.length === 0) return 'decline';
  for (const call of calls) {
    let answer: HookAnswer | null;
    try {
      answer = await decide(call, signal);
    } catch (error) {
      console.warn(`codex: declined ${call.tool_name} ${call.tool_use_id}: the gate failed (${(error as Error).message})`);
      return 'decline';
    }
    if (answer === null) return null;
    if (answer.permissionDecision !== 'allow') return 'decline';
  }
  return 'accept';
}

// Whitelisted replies only: never acceptForSession, an execpolicy amendment or a persisted elicitation.
export const approvalReply = (verdict: 'accept' | 'decline'): ApprovalResponse => ({ decision: verdict });

export const elicitationReply = (verdict: 'accept' | 'decline'): ElicitationResponse =>
  ({ action: verdict, content: verdict === 'accept' ? ELICITATION_ACCEPT_CONTENT : null, _meta: null });
