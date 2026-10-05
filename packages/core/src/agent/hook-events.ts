import { isRecord } from '../json';

export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'subagent';
}

export interface TaskNotice {
  taskId: string;
  toolUseId: string | null;
  status: string;
}

// What an agent running in a terminal reports through its hooks, in the agent's own words.
export type AgentEvent =
  | { type: 'prompt'; text: string; task: TaskNotice | null }
  | { type: 'tool-start'; toolUseId: string; tool: string; input: unknown; agentId: string | null }
  | { type: 'tool-end'; toolUseId: string; status: 'ok' | 'error'; agentId: string | null; launched: BackgroundTask | null }
  | { type: 'turn-end'; lastMessage: string | null; failed: boolean; runningTaskIds: string[] | null }
  | { type: 'subagent-start'; agentId: string }
  | { type: 'subagent-stop'; agentId: string; lastMessage: string | null }
  | { type: 'conversation'; claudeSessionId: string; source: string }
  | { type: 'interrupted' }
  | { type: 'assistant-text'; text: string };

export interface HookEventInfo {
  name: string;
  transcriptPath: string | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);

export function hookEventInfo(raw: unknown): HookEventInfo | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.hook_event_name);
  return name === null ? null : { name, transcriptPath: str(raw.transcript_path) };
}

// Internal agents (title, summary, prompt suggestion) report SubagentStart/Stop without a type; they are not the user's work.
export function parseHookEvent(raw: unknown): AgentEvent | null {
  if (!isRecord(raw)) return null;
  const agentId = str(raw.agent_id);
  switch (raw.hook_event_name) {
    case 'UserPromptSubmit': {
      // Codex reports the prompt a subagent gets; only the main thread's prompts are the user's.
      if (agentId) return null;
      const text = str(raw.prompt) ?? '';
      return { type: 'prompt', text, task: taskNotice(text) };
    }
    case 'PreToolUse': {
      const toolUseId = str(raw.tool_use_id);
      const tool = str(raw.tool_name);
      return toolUseId && tool ? { type: 'tool-start', toolUseId, tool, input: raw.tool_input, agentId } : null;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolUseId = str(raw.tool_use_id);
      if (!toolUseId) return null;
      const failed = raw.hook_event_name === 'PostToolUseFailure';
      return { type: 'tool-end', toolUseId, status: failed ? 'error' : 'ok', agentId, launched: failed ? null : launched(raw.tool_response) };
    }
    case 'Stop':
    case 'StopFailure':
      return {
        type: 'turn-end', lastMessage: str(raw.last_assistant_message), failed: raw.hook_event_name === 'StopFailure',
        runningTaskIds: Array.isArray(raw.background_tasks) ? raw.background_tasks.filter(isRecord).flatMap((task) => str(task.id) ?? []) : null,
      };
    case 'SubagentStart':
      return agentId && str(raw.agent_type) ? { type: 'subagent-start', agentId } : null;
    case 'SubagentStop':
      return agentId && str(raw.agent_type) ? { type: 'subagent-stop', agentId, lastMessage: str(raw.last_assistant_message) } : null;
    case 'Interrupt':
      return { type: 'interrupted' };
    case 'SessionStart': {
      const claudeSessionId = str(raw.session_id);
      return claudeSessionId ? { type: 'conversation', claudeSessionId, source: str(raw.source) ?? 'unknown' } : null;
    }
    default:
      return null;
  }
}

// claude: a background Bash or Agent call; Codex: spawn_agent, whose output is a JSON string with the new agent's id.
function launched(raw: unknown): BackgroundTask | null {
  const response = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!isRecord(response)) return null;
  const shell = str(response.backgroundTaskId);
  if (shell) return { id: shell, kind: 'shell' };
  const agent = str(response.agentId);
  if (agent && response.isAsync === true) return { id: agent, kind: 'subagent' };
  const spawned = typeof raw === 'string' ? str(response.agent_id) : null;
  return spawned ? { id: spawned, kind: 'subagent' } : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// claude reports a finished background task as a prompt of its own, which starts an agent-initiated turn.
function taskNotice(prompt: string): TaskNotice | null {
  if (!prompt.trimStart().startsWith('<task-notification>')) return null;
  const taskId = TAG('task-id').exec(prompt)?.[1]?.trim();
  if (!taskId) return null;
  return { taskId, toolUseId: TAG('tool-use-id').exec(prompt)?.[1]?.trim() ?? null, status: TAG('status').exec(prompt)?.[1]?.trim() ?? 'completed' };
}

// The transcript is claude's own file: hooks do not report a turn stopped with Esc, nor the text between tool calls.
export function parseTranscriptLine(line: string): AgentEvent[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(entry) || entry.isSidechain === true || !isRecord(entry.message)) return [];
  const content = entry.message.content;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (entry.type === 'user') {
    const interrupted = blocks.some((block) => (str(block.text) ?? str(block.content) ?? '').startsWith('[Request interrupted by user'));
    return interrupted ? [{ type: 'interrupted' }] : [];
  }
  if (entry.type !== 'assistant') return [];
  return blocks.flatMap((block) => {
    const text = block.type === 'text' ? str(block.text) : null;
    return text && text.trim() !== '' ? [{ type: 'assistant-text', text } as const] : [];
  });
}
