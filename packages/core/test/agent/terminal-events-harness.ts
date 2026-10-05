import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatItem, MessageItem, SessionServerMessage, ToolItem } from '@ide/protocol';
import type { ToolEndInfo } from '../../src/agent/tracker';
import { tempDir } from '../helpers';
import { terminalHarness } from './terminal-harness';

export const interrupted = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
export const said = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

// A claude whose turn stays open until it is stopped.
export function turnThatStaysOpen(): string {
  const file = join(tempDir('ide-scenario-'), 'open-turn.jsonl');
  const init = { type: 'system', subtype: 'init', cwd: '/fake/project', session_id: '$SESSION', mcp_servers: [], model: 'claude-haiku-4-5-20251001', permissionMode: 'bypassPermissions', claude_code_version: '2.1.281' };
  const steps = [{ fake: 'await-user' }, init, { fake: 'sleep', ms: 60_000 }, { fake: 'await-user' }];
  writeFileSync(file, steps.map((step) => JSON.stringify(step)).join('\n'));
  return file;
}

export const isTool = (item: ChatItem): item is ToolItem => item.kind === 'tool';
export const isMessage = (item: ChatItem): item is MessageItem => item.kind === 'message';

// A terminal that is open on a chat whose hooks run, and the hook payloads of claude 2.1.289 fed to it.
export async function openTerminal(scenario?: string) {
  const h = await terminalHarness({ hooks: 'on', canaryMs: 5000, ...(scenario ? { scenario } : {}) });
  const launch = await h.session.terminalLaunch();
  if (launch === null) throw new Error('the terminal did not open');
  const ideId = h.session.sessionId() as string;
  const claudeId = h.session.state().session?.claudeSessionId as string;
  const transcript = join(h.transcriptsDir, 'followed.jsonl');
  writeFileSync(transcript, '');

  const heard = { userMessages: 0, turnsClosed: 0, interrupts: 0, taskEnds: [] as string[], toolResults: [] as ToolEndInfo[], broadcasts: [] as SessionServerMessage[] };
  h.session.onUserMessage(() => {
    heard.userMessages += 1;
  });
  h.session.onTurnClosed(() => {
    heard.turnsClosed += 1;
  });
  h.session.onInterrupt(() => {
    heard.interrupts += 1;
  });
  h.session.onTaskEnd((toolUseId) => heard.taskEnds.push(toolUseId));
  h.session.onToolResult((info) => heard.toolResults.push(info));
  h.session.onMessage((message) => heard.broadcasts.push(message));

  const raw = (name: string, fields: object = {}) => ({
    hook_event_name: name, session_id: claudeId, transcript_path: transcript, cwd: h.root, permission_mode: 'default', ...fields,
  });
  const send = (name: string, fields: object = {}) => h.session.hookEvent(ideId, raw(name, fields));
  const call = (toolUseId: string, tool = 'Bash', input: object = {}, extra: object = {}) =>
    h.session.toolCalled(raw('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: toolUseId, ...extra }));
  const result = (toolUseId: string, tool = 'Bash', response: object = {}, extra: object = {}, name = 'PostToolUse') =>
    send(name, { tool_name: tool, tool_input: {}, tool_use_id: toolUseId, tool_response: response, ...extra });
  const t = {
    h, ideId, claudeId, transcript, heard, raw, send, call, result,
    prompt: (text: string) => send('UserPromptSubmit', { prompt: text }),
    stop: (fields: object = {}) => send('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [], ...fields }),
    startShell: (toolUseId: string, taskId: string) => {
      call(toolUseId, 'Bash', { command: 'sleep 5', run_in_background: true });
      result(toolUseId, 'Bash', { backgroundTaskId: taskId });
    },
    startAgent: (toolUseId: string, agentId: string) => {
      call(toolUseId, 'Agent', { description: 'd', prompt: 'p', run_in_background: true });
      result(toolUseId, 'Agent', { isAsync: true, agentId });
    },
    appendTranscript: (...lines: string[]) => appendFileSync(transcript, lines.map((line) => `${line}\n`).join('')),
    state: () => h.session.state(),
    items: () => h.session.state().items,
    tool: (id: string) => h.session.state().items.filter(isTool).find((item) => item.id === id),
    messages: () => h.session.state().items.filter(isMessage),
    turns: () => h.session.state().turns,
    tasks: () => h.session.state().tasks,
    notices: () => h.session.state().items.flatMap((item) => (item.kind === 'notice' ? [item.text] : [])),
  };
  return t;
}

export type Terminal = Awaited<ReturnType<typeof openTerminal>>;
export const snapshot = (t: Terminal) => JSON.stringify([t.turns(), t.items(), t.tasks()]);

