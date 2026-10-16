import { basename, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../json';
import type { HookAnswer } from '../../gate/hook-gate';
import type { GateCall } from '../transport';
import { shellWord } from './events';
import type {
  ApprovalResponse, CommandExecutionRequestApprovalParams, ElicitationResponse, FileChangeRequestApprovalParams, FileUpdateChange, JsonValue,
  McpServerElicitationRequestParams, McpToolCallItem, PermissionsRequestApprovalResponse, ThreadItem,
} from './protocol';

export type Decide = (call: GateCall, signal: AbortSignal) => Promise<HookAnswer | null>;
export type Verdict = 'accept' | 'decline' | null;

// codex-cli 0.160 runs the tool on this accept.
const ELICITATION_ACCEPT_CONTENT: JsonValue = null;

const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

const READ_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// Shells whose scripts the gate's shell reader does not parse (or not under that spelling): a write in one would look like none.
const UNREAD_SHELLS = new Set([...READ_SHELLS, 'ash', 'busybox', 'csh', 'elvish', 'fish', 'ksh', 'mksh', 'nu', 'oksh', 'posh', 'powershell', 'pwsh', 'tcsh', 'xonsh', 'yash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// One word of a command line as written, quotes included; an operator ends it.
const RAW_WORD = /^\s*((?:[^\s'"\\;&|()<>]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+)/s;

// A change of a kind or shape CodeRay does not know, or with a path not absolute, could write where no gate call looks.
function readable(change: unknown): change is FileUpdateChange {
  if (!isRecord(change) || typeof change.path !== 'string' || !isAbsolute(change.path) || typeof change.diff !== 'string' || !isRecord(change.kind)) return false;
  const { type, move_path: to } = change.kind;
  return type === 'add' || type === 'delete' || (type === 'update' && (to === null || (typeof to === 'string' && isAbsolute(to))));
}

/**
 * The gate calls of a patch: a new file a Write, an edit an Edit with its diff, a deletion or a move the shell command that does it
 * (a move that also edits, then an Edit of the destination); none when a change cannot be read.
 */
export function patchCalls(itemId: string, changes: FileUpdateChange[], cwd: string): GateCall[] {
  if (!Array.isArray(changes) || !changes.every(readable)) return [];
  return changes.flatMap((change): GateCall[] => {
    const base = { tool_use_id: itemId, cwd };
    if (change.kind.type === 'add') return [{ ...base, tool_name: 'Write', tool_input: { file_path: change.path, content: change.diff } }];
    if (change.kind.type === 'delete') return [{ ...base, tool_name: 'Bash', tool_input: { command: `rm -- ${quote(change.path)}` } }];
    const to = change.kind.move_path;
    const edit = { ...base, tool_name: 'Edit', tool_input: { file_path: to ?? change.path, diff: change.diff } };
    if (to === null) return [edit];
    const move = { ...base, tool_name: 'Bash', tool_input: { command: `mv -- ${quote(change.path)} ${quote(to)}` } };
    return change.diff === '' ? [move] : [move, edit];
  });
}

/** A patch's approval: its item's latest changes; no call (so a decline) when it asks for a writable root for the session or names no open patch. */
export function fileChangeCalls(params: FileChangeRequestApprovalParams, item: ThreadItem | undefined, cwd: string): GateCall[] {
  if (params.grantRoot !== null && params.grantRoot !== undefined) {
    console.warn('codex: declined a patch that asks for a writable root for the rest of the session');
    return [];
  }
  return item?.type === 'fileChange' && item.id === params.itemId ? patchCalls(item.id, item.changes, cwd) : [];
}

/** The shell a command line runs in when the gate cannot read it (one it does not parse, or env with options); null when it can. */
function unreadShell(command: string): string | null {
  let rest = command;
  let env = false;
  for (let count = 0; count < 32; count++) {
    const raw = RAW_WORD.exec(rest);
    const word = raw ? shellWord(raw[1]!) : null;
    if (raw === null || word === null) return null;
    rest = rest.slice(raw[0].length);
    const name = basename(word);
    if (name === 'env') env = true;
    else if (env && word.startsWith('-')) return `env ${word}`;
    else if (!ASSIGNMENT.test(word)) return !READ_SHELLS.has(name) && UNREAD_SHELLS.has(name.toLowerCase().replace(/\.exe$/, '')) ? name : null;
  }
  return null;
}

/** An escalated command as the shell call it is; a stdin write, a request that names no command, or a shell the gate cannot read has none. */
export function commandCall(params: CommandExecutionRequestApprovalParams, cwd: string): GateCall | null {
  if (params.kind !== 'command' || typeof params.command !== 'string' || params.command === '') return null;
  const shell = unreadShell(params.command);
  if (shell !== null) {
    console.warn(`codex: declined a command run by ${shell}, which the gate cannot read`);
    return null;
  }
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
      if (signal.aborted) return null;
      console.warn(`codex: declined ${call.tool_name} ${call.tool_use_id}: the gate failed (${error instanceof Error ? error.message : String(error)})`);
      return 'decline';
    }
    if (signal.aborted || answer === null) return null;
    if (answer?.permissionDecision !== 'allow') return 'decline';
  }
  return 'accept';
}

// Whitelisted replies only: never acceptForSession, an execpolicy amendment or a persisted elicitation.
export const approvalReply = (verdict: 'accept' | 'decline'): ApprovalResponse => ({ decision: verdict });

export const elicitationReply = (verdict: 'accept' | 'decline'): ElicitationResponse =>
  ({ action: verdict, content: verdict === 'accept' ? ELICITATION_ACCEPT_CONTENT : null, _meta: null });
