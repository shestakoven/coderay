import { describe, expect, it } from 'vitest';
import { hookEventInfo, parseHookEvent, parseTranscriptLine } from '../../src/agent/hook-events';

const base = { session_id: 'claude-1', transcript_path: '/home/u/.claude/projects/p/claude-1.jsonl', cwd: '/p', permission_mode: 'default' };
const hook = (name: string, fields: object = {}) => ({ ...base, hook_event_name: name, ...fields });

const taskNotification = (tags: string) => `<task-notification>\n${tags}\n<summary>Background command "sleep 5" completed</summary>\n</task-notification>`;

describe('hookEventInfo', () => {
  it('names the event and where claude keeps its transcript', () => {
    expect(hookEventInfo(hook('Stop'))).toEqual({ name: 'Stop', transcriptPath: base.transcript_path });
  });

  it('has no transcript path when the payload carries none', () => {
    expect(hookEventInfo({ hook_event_name: 'Stop' })).toEqual({ name: 'Stop', transcriptPath: null });
  });

  it.each([[null], ['Stop'], [42], [{}], [{ hook_event_name: 7 }]])('is null for %j, which is not a hook payload', (raw) => {
    expect(hookEventInfo(raw)).toBeNull();
  });
});

describe('parseHookEvent', () => {
  describe('UserPromptSubmit', () => {
    it('reads what the user typed', () => {
      expect(parseHookEvent(hook('UserPromptSubmit', { prompt: 'fix the login' }))).toEqual({ type: 'prompt', text: 'fix the login', task: null });
    });

    it('reads a finished background task from a task notification, not as typed by the user', () => {
      const prompt = taskNotification('<task-id>bg1</task-id>\n<tool-use-id>toolu_sh</tool-use-id>\n<status>completed</status>');
      expect(parseHookEvent(hook('UserPromptSubmit', { prompt }))).toMatchObject({
        type: 'prompt', task: { taskId: 'bg1', toolUseId: 'toolu_sh', status: 'completed' },
      });
    });

    it('keeps the status a task notification reports', () => {
      const prompt = taskNotification('<task-id>bg1</task-id>\n<tool-use-id>toolu_sh</tool-use-id>\n<status>failed</status>');
      expect(parseHookEvent(hook('UserPromptSubmit', { prompt }))).toMatchObject({ task: { status: 'failed' } });
    });

    it('still names the task when the notification has no tool-use id', () => {
      const prompt = taskNotification('<task-id>bg1</task-id>\n<status>completed</status>');
      expect(parseHookEvent(hook('UserPromptSubmit', { prompt }))).toMatchObject({ task: { taskId: 'bg1', toolUseId: null } });
    });

    it('takes a prompt that only mentions the tags in the middle of its text for the user', () => {
      const prompt = 'why does <task-notification><task-id>bg1</task-id></task-notification> show up in my chat?';
      expect(parseHookEvent(hook('UserPromptSubmit', { prompt }))).toMatchObject({ type: 'prompt', task: null });
    });
  });

  describe('PreToolUse, PostToolUse and PostToolUseFailure', () => {
    const call = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' };

    it('reads the start of a call by the agent itself', () => {
      expect(parseHookEvent(hook('PreToolUse', call))).toEqual({ type: 'tool-start', toolUseId: 'toolu_1', tool: 'Bash', input: { command: 'ls' }, agentId: null });
    });

    it('reads which subagent made the call', () => {
      expect(parseHookEvent(hook('PreToolUse', { ...call, agent_id: 'ag1', agent_type: 'general-purpose' }))).toMatchObject({ type: 'tool-start', agentId: 'ag1' });
    });

    it('reads a call that worked as ok', () => {
      expect(parseHookEvent(hook('PostToolUse', { ...call, tool_response: { stdout: 'a' } }))).toEqual({
        type: 'tool-end', toolUseId: 'toolu_1', status: 'ok', agentId: null, launched: null,
      });
    });

    it('reads a call that failed as an error', () => {
      expect(parseHookEvent(hook('PostToolUseFailure', { ...call, error: 'exit 1' }))).toMatchObject({ type: 'tool-end', toolUseId: 'toolu_1', status: 'error', launched: null });
    });

    it('reads the subagent of the call that ended', () => {
      expect(parseHookEvent(hook('PostToolUse', { ...call, agent_id: 'ag1', tool_response: {} }))).toMatchObject({ agentId: 'ag1' });
    });

    it('reads a background Bash as a shell task started by the call', () => {
      const event = parseHookEvent(hook('PostToolUse', { ...call, tool_input: { command: 'sleep 5', run_in_background: true }, tool_response: { backgroundTaskId: 'bg1' } }));
      expect(event).toMatchObject({ type: 'tool-end', launched: { id: 'bg1', kind: 'shell' } });
    });

    it('reads a background Agent as a subagent task started by the call', () => {
      const event = parseHookEvent(hook('PostToolUse', {
        tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', run_in_background: true }, tool_use_id: 'toolu_a',
        tool_response: { isAsync: true, agentId: 'ag7' },
      }));
      expect(event).toMatchObject({ type: 'tool-end', toolUseId: 'toolu_a', launched: { id: 'ag7', kind: 'subagent' } });
    });

    it('does not take a foreground Agent for a background task', () => {
      const event = parseHookEvent(hook('PostToolUse', { tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_a', tool_response: { agentId: 'ag7', content: [] } }));
      expect(event).toMatchObject({ type: 'tool-end', launched: null });
    });

    it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('is null for a %s without a tool use id', (name) => {
      expect(parseHookEvent(hook(name, { tool_name: 'Bash', tool_input: {} }))).toBeNull();
    });
  });

  describe('Stop and StopFailure', () => {
    it('reads the end of a turn with the last thing the agent said', () => {
      expect(parseHookEvent(hook('Stop', { last_assistant_message: 'Done.', stop_hook_active: false, background_tasks: [] }))).toEqual({
        type: 'turn-end', lastMessage: 'Done.', failed: false, runningTaskIds: [],
      });
    });

    it('reads the end of a turn that failed', () => {
      expect(parseHookEvent(hook('StopFailure', { last_assistant_message: 'API error', background_tasks: [] }))).toMatchObject({ type: 'turn-end', failed: true });
    });

    it('lists the background tasks that still run, shell and subagent alike', () => {
      const background_tasks = [{ id: 'bg1', type: 'local_bash', status: 'running' }, { id: 'ag2', type: 'local_agent', status: 'running' }];
      expect(parseHookEvent(hook('Stop', { last_assistant_message: 'x', background_tasks }))).toMatchObject({ runningTaskIds: ['bg1', 'ag2'] });
    });

    it('knows nothing of the running tasks when the payload does not list them', () => {
      expect(parseHookEvent(hook('Stop', { last_assistant_message: 'x' }))).toMatchObject({ runningTaskIds: null });
    });

    it('has no last message when the agent said nothing', () => {
      expect(parseHookEvent(hook('Stop', { background_tasks: [] }))).toMatchObject({ type: 'turn-end', lastMessage: null });
    });
  });

  describe('SubagentStart and SubagentStop', () => {
    it('reads the start of a subagent', () => {
      expect(parseHookEvent(hook('SubagentStart', { agent_id: 'ag1', agent_type: 'general-purpose' }))).toEqual({ type: 'subagent-start', agentId: 'ag1' });
    });

    it('reads the end of a subagent with its last message', () => {
      expect(parseHookEvent(hook('SubagentStop', { agent_id: 'ag1', agent_type: 'general-purpose', last_assistant_message: 'found it' }))).toEqual({
        type: 'subagent-stop', agentId: 'ag1', lastMessage: 'found it',
      });
    });

    it('has no last message for a subagent that said nothing', () => {
      expect(parseHookEvent(hook('SubagentStop', { agent_id: 'ag1', agent_type: 'Explore' }))).toMatchObject({ lastMessage: null });
    });

    it.each(['SubagentStart', 'SubagentStop'])('ignores an internal agent that reports %s without a type', (name) => {
      expect(parseHookEvent(hook(name, { agent_id: 'internal-title', agent_type: '' }))).toBeNull();
    });

    it.each(['SubagentStart', 'SubagentStop'])('ignores a %s without a type field at all', (name) => {
      expect(parseHookEvent(hook(name, { agent_id: 'internal-title' }))).toBeNull();
    });
  });

  describe('SessionStart', () => {
    it.each(['startup', 'resume', 'clear', 'compact'])('reads the conversation claude starts on after %s', (source) => {
      expect(parseHookEvent(hook('SessionStart', { session_id: 'claude-2', source }))).toEqual({ type: 'conversation', claudeSessionId: 'claude-2', source });
    });
  });

  it.each([[null], ['Stop'], [{}], [hook('Notification', { message: 'x' })], [hook('PreCompact')], [{ hook_event_name: 5 }]])('is null for %j, which the IDE does not follow', (raw) => {
    expect(parseHookEvent(raw)).toBeNull();
  });
});

describe('parseTranscriptLine', () => {
  const line = (value: object) => JSON.stringify(value);
  const user = (content: unknown, extra: object = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (content: unknown[], extra: object = {}) => line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

  it('reads Esc, which no hook reports, as an interruption', () => {
    expect(parseTranscriptLine(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toEqual([{ type: 'interrupted' }]);
  });

  it('reads Esc during a tool call as an interruption', () => {
    expect(parseTranscriptLine(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toEqual([{ type: 'interrupted' }]);
  });

  it('reads an interruption whose content is a plain string', () => {
    expect(parseTranscriptLine(user('[Request interrupted by user]'))).toEqual([{ type: 'interrupted' }]);
  });

  it('does not take a message that merely quotes the marker for Esc', () => {
    expect(parseTranscriptLine(user([{ type: 'text', text: 'the log said [Request interrupted by user] again' }]))).toEqual([]);
  });

  it('reads the text the agent wrote between tool calls', () => {
    const content = [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'Let me look at it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }];
    expect(parseTranscriptLine(assistant(content))).toEqual([{ type: 'assistant-text', text: 'Let me look at it.' }]);
  });

  it('has no text to report for an assistant line that only calls a tool', () => {
    expect(parseTranscriptLine(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]))).toEqual([]);
  });

  it('ignores the lines of a subagent, a sidechain of the conversation', () => {
    expect(parseTranscriptLine(assistant([{ type: 'text', text: 'inside the subagent' }], { isSidechain: true }))).toEqual([]);
    expect(parseTranscriptLine(user([{ type: 'text', text: '[Request interrupted by user]' }], { isSidechain: true }))).toEqual([]);
  });

  it('ignores what the user typed and the results of tools', () => {
    expect(parseTranscriptLine(user('fix the login'))).toEqual([]);
    expect(parseTranscriptLine(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]))).toEqual([]);
  });

  it.each([[''], ['   '], ['{not json'], ['null'], ['42'], ['[]'], [line({ type: 'summary', summary: 'x' })]])('reports nothing for %j', (raw) => {
    expect(parseTranscriptLine(raw)).toEqual([]);
  });
});
