import { resolve } from 'node:path';
import type { HookAnswer } from '../../gate/hook-gate';
import { isRecord } from '../../json';
import { patchCalls, type Decide } from '../codex/approvals';
import type { FileUpdateChange, PatchChangeKind } from '../codex/protocol';
import { unreadShell } from '../shell-read';
import type { GateCall } from '../transport';
import { toolName } from './events';

/** The server's own variables (its password, CodeRay's config, its pid): a bash that names one is refused before the gate. */
export const SECRET_NAMES = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PID'] as const;

/** A `permission.asked` as CodeRay reads it. */
export interface Ask {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  callID: string | null;
}

export type Reply = { reply: 'once' } | { reply: 'reject'; message?: string };

// An apply_patch file's change type as Codex's, whose patches the gate already judges; a move also needs its destination.
const KINDS = new Map<unknown, PatchChangeKind>([['add', { type: 'add' }], ['update', { type: 'update', move_path: null }], ['delete', { type: 'delete' }]]);
// Asks that write nothing, one read per pattern (a write outside the project asks external_directory first, then its own ask).
const READS = new Map<string, [tool: string, field: string]>([['webfetch', ['WebFetch', 'url']], ['websearch', ['WebSearch', 'query']], ['external_directory', ['Read', 'file_path']]]);

/** The ask as the transport reads it from permission.asked; null when it cannot be read. */
export function readAsk(properties: unknown): Ask | null {
  if (!isRecord(properties)) return null;
  const { id, sessionID, permission, patterns, metadata, tool } = properties;
  if (typeof id !== 'string' || typeof sessionID !== 'string' || typeof permission !== 'string') return null;
  return {
    id, sessionID, permission,
    patterns: Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === 'string') : [],
    metadata: isRecord(metadata) ? metadata : {},
    callID: isRecord(tool) && typeof tool.callID === 'string' ? tool.callID : null,
  };
}

/**
 * The gate calls an ask stands for, judged together; `[]` when the ask cannot be mapped (then it is rejected). `input` is the tool part's
 * input, unknown while the part is pending: a task's, a webfetch's and the first external_directory's ask come before it runs.
 * A bash and a task without it are rejected.
 */
export function askCalls(
  ask: Ask, input: Record<string, unknown> | undefined, cwd: string, subagents: string[], ownSessions: Set<string>, servers: string[],
): GateCall[] {
  const refuse = (why: string): GateCall[] => {
    console.warn(`opencode: rejected the ${ask.permission} ask ${ask.id}: ${why}`);
    return [];
  };
  if (ask.callID === null) return refuse('it names no tool call');
  const base = { tool_use_id: ask.callID, cwd };
  // Normalised too: a workdir of `<project>/../elsewhere` is not in the project.
  const abs = (path: string): string => resolve(cwd, path);
  const read = READS.get(ask.permission);
  if (read !== undefined) {
    // A call outside the project asks for the directory, then for itself, under one callID: the gate's decision on the directory must not stand for the call's.
    const id = ask.permission === 'external_directory' ? `${ask.callID}:external_directory` : ask.callID;
    return ask.patterns.map((pattern) => ({ ...base, tool_use_id: id, tool_name: read[0], tool_input: { [read[1]]: pattern } }));
  }
  if (ask.permission === 'edit') {
    // The edit, write and apply_patch tools all ask `edit`; a patch lists its files, each with its own diff.
    const { diff, filepath, files } = ask.metadata;
    if (files !== undefined) {
      const changes = Array.isArray(files) ? files.map(fileChange) : [null];
      if (changes.includes(null)) return refuse('its patch changes a file in a way CodeRay cannot read');
      return patchCalls(ask.callID, changes as FileUpdateChange[], cwd);
    }
    // `patterns` are relative to the worktree, not to cwd: only the absolute filepath says which file is written.
    if (typeof filepath !== 'string' || typeof diff !== 'string') return refuse('it names no file or no diff');
    const kind: PatchChangeKind = input?.oldString === '' ? { type: 'add' } : { type: 'update', move_path: null };
    return patchCalls(ask.callID, [{ path: abs(filepath), kind, diff }], cwd);
  }
  if (ask.permission === 'bash') {
    // The whole command line: `patterns` split it into its commands and lose what joins them.
    const command = ask.metadata.command;
    if (typeof command !== 'string') return refuse('it names no command');
    if (input === undefined) return refuse('its workdir is not known yet');
    const secret = SECRET_NAMES.find((name) => command.includes(name));
    if (secret !== undefined) return refuse(`the command names ${secret}`);
    const shell = unreadShell(command);
    if (shell !== null) return refuse(`the command runs in ${shell}, which the gate cannot read`);
    const where = typeof input.workdir === 'string' ? abs(input.workdir) : cwd;
    const description = typeof input.description === 'string' ? { description: input.description } : {};
    return [{ ...base, cwd: where, tool_name: 'Bash', tool_input: { command, ...description } }];
  }
  if (ask.permission === 'task') {
    // The ask's pattern is the subagent the task starts; only a task's input says which session it resumes.
    const [subagent] = ask.patterns;
    if (subagent === undefined || !subagents.includes(subagent)) return refuse(`the subagent ${subagent} did not pass the self-check`);
    // 1.19 resumes any session by its id, another chat's too.
    if (input === undefined) return refuse('the session it resumes is not known yet');
    const resumed = input.task_id;
    if (resumed !== undefined && !(typeof resumed === 'string' && ownSessions.has(resumed))) return refuse(`it resumes ${String(resumed)}, which this chat did not create`);
    return [{ ...base, tool_name: 'Task', tool_input: { subagent_type: subagent, ...(resumed === undefined ? {} : { task_id: resumed }) } }];
  }
  // idecore's tools are allowed by rule: one that asks is not CodeRay's.
  const name = toolName(ask.permission, {}, servers.filter((server) => server !== 'idecore'));
  if (name.startsWith('mcp__')) return [{ ...base, tool_name: name, tool_input: input ?? {} }];
  return refuse('CodeRay does not know this permission');
}

// The paths stay as 1.19 sends them, absolute: patchCalls refuses any other.
function fileChange(file: unknown): FileUpdateChange | null {
  if (!isRecord(file) || typeof file.filePath !== 'string' || typeof file.patch !== 'string') return null;
  const kind = file.type === 'move' && typeof file.movePath === 'string' ? { type: 'update' as const, move_path: file.movePath } : KINDS.get(file.type);
  return kind === undefined ? null : { path: file.filePath, kind, diff: file.patch };
}

/**
 * `once` when the gate allows every call; `reject` with the guard's reason on a guard denial; `reject` alone (which ends the turn) on a
 * final denial, a gate failure or no calls; null when the answer must not be sent (Stop came first). Never `always`.
 */
export async function judgeAsk(calls: GateCall[], decide: Decide | undefined, signal: AbortSignal): Promise<Reply | null> {
  if (!decide || calls.length === 0) return { reply: 'reject' };
  let answer: HookAnswer | null;
  try {
    answer = await decide(calls, signal);
  } catch (error) {
    if (signal.aborted) return null;
    console.warn(`opencode: rejected ${calls[0]!.tool_name} ${calls[0]!.tool_use_id}: the gate failed (${error instanceof Error ? error.message : String(error)})`);
    return { reply: 'reject' };
  }
  if (signal.aborted || answer === null) return null;
  if (answer.permissionDecision === 'allow') return { reply: 'once' };
  return answer.final || answer.permissionDecisionReason === '' ? { reply: 'reject' } : { reply: 'reject', message: answer.permissionDecisionReason };
}
