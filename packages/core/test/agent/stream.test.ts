import { describe, expect, it } from 'vitest';
import { parseStreamLine } from '../../src/agent/stream';

const line = (event: object) => JSON.stringify(event);

describe('parseStreamLine', () => {
  it('reads the session id, model, CLI version, permission mode and MCP server statuses from init', () => {
    const event = line({
      type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5-20251001', claude_code_version: '2.1.281',
      permissionMode: 'bypassPermissions', tools: ['Bash'], mcp_servers: [{ name: 'docs', status: 'connected', source: 'dynamic' }],
      skills: ['wiki', 'superpowers:brainstorming'],
    });
    expect(parseStreamLine(event)).toEqual({
      type: 'init', sessionId: 's1', model: 'claude-haiku-4-5-20251001', cliVersion: '2.1.281', permissionMode: 'bypassPermissions',
      mcpServers: [{ name: 'docs', status: 'connected' }], skills: ['wiki', 'superpowers:brainstorming'],
    });
  });

  describe('init skills', () => {
    const init = (extra: object) => line({ type: 'system', subtype: 'init', session_id: 's1', ...extra });
    const skillsOf = (extra: object) => {
      const event = parseStreamLine(init(extra));
      return event?.type === 'init' ? event.skills : null;
    };

    it('lists the skill names in the order claude reports them', () => {
      expect(skillsOf({ skills: ['zeta', 'plugin:alpha', 'beta'] })).toEqual(['zeta', 'plugin:alpha', 'beta']);
    });

    it('lists no skills when init has no skills field', () => {
      expect(skillsOf({})).toEqual([]);
    });

    it('lists no skills when the skills field is not an array', () => {
      expect(['wiki', null, 7, true, { wiki: true }].map((skills) => skillsOf({ skills }))).toEqual([[], [], [], [], []]);
    });

    it('drops the entries that are not strings', () => {
      expect(skillsOf({ skills: ['wiki', 3, null, { name: 'x' }, ['y'], false, 'plugin:one'] })).toEqual(['wiki', 'plugin:one']);
    });

    it('lists no skills for an empty array', () => {
      expect(skillsOf({ skills: [] })).toEqual([]);
    });
  });

  it('reads a permission mode change from a status event', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' })))
      .toEqual({ type: 'mode', permissionMode: 'plan' });
  });

  it('reads the text and tool_use blocks of an assistant message with its parent tool use id', () => {
    const event = line({
      type: 'assistant', parent_tool_use_id: 'toolu_agent',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/p/a.ts' } },
      ] },
    });
    expect(parseStreamLine(event)).toEqual({
      type: 'assistant', parentToolUseId: 'toolu_agent',
      blocks: [{ kind: 'text', text: 'hi' }, { kind: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/p/a.ts' } }],
    });
  });

  it('reads tool results from string and text-block content with their error flag', () => {
    const event = line({
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'done' },
        { type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'boom' }] },
      ] },
    });
    expect(parseStreamLine(event)).toEqual({
      type: 'user', parentToolUseId: null,
      toolResults: [{ toolUseId: 'a', isError: false, text: 'done' }, { toolUseId: 'b', isError: true, text: 'boom' }],
    });
  });

  it('reads a result with its subtype and the kind of its origin', () => {
    expect(parseStreamLine(line({ type: 'result', subtype: 'success', is_error: false, origin: { kind: 'task-notification' } })))
      .toEqual({ type: 'result', subtype: 'success', origin: 'task-notification' });
    expect(parseStreamLine(line({ type: 'result', subtype: 'error_during_execution', is_error: true })))
      .toEqual({ type: 'result', subtype: 'error_during_execution', origin: null });
  });

  it('reads task_started with the tool use that started the task and whether it runs in the background', () => {
    const started = (isBackgrounded: boolean) => line({
      type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_a', task_type: 'local_bash',
      is_backgrounded: isBackgrounded, description: 'Wait 25 s',
    });
    expect([parseStreamLine(started(true)), parseStreamLine(started(false))]).toEqual([
      { type: 'task_started', taskId: 't1', toolUseId: 'toolu_a', backgrounded: true, description: 'Wait 25 s' },
      { type: 'task_started', taskId: 't1', toolUseId: 'toolu_a', backgrounded: false, description: 'Wait 25 s' },
    ]);
  });

  it('reads task_notification with its status', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_a', status: 'completed', summary: 'ok' })))
      .toEqual({ type: 'task_notification', taskId: 't1', toolUseId: 'toolu_a', status: 'completed' });
  });

  it('reads the status a task_updated event patches in', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'killed', end_time: 5 } })))
      .toEqual({ type: 'task_updated', taskId: 't1', status: 'killed' });
  });

  it('reads a control request with the tool it asks about and its input', () => {
    const event = line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 'toolu_x' } });
    expect(parseStreamLine(event)).toEqual({ type: 'control_request', requestId: 'r1', subtype: 'can_use_tool', toolName: 'ExitPlanMode', input: { plan: 'p' } });
  });

  it('reads a control request that claude cancels', () => {
    expect(parseStreamLine(line({ type: 'control_cancel_request', request_id: 'r1' }))).toEqual({ type: 'control_cancel', requestId: 'r1' });
  });

  it('ignores hook, token, status, rate-limit, progress and control response events', () => {
    const noise = [
      { type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'thinking_tokens' }, { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'rate_limit_event' }, { type: 'system', subtype: 'task_progress' }, { type: 'system', subtype: 'background_tasks_changed' },
      { type: 'system', subtype: 'commands_changed' },
      { type: 'control_response', response: { subtype: 'success', request_id: 'i1', response: { still_queued: [] } } },
    ];
    expect(noise.map((event) => parseStreamLine(line(event)))).toEqual(noise.map(() => ({ type: 'ignored' })));
  });

  describe('streamed text', () => {
    const delta = (text: unknown, parent: string | null = null, deltaType = 'text_delta') =>
      line({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: deltaType, text } } });

    it('reads a text delta of the main agent with a null parent tool use id', () => {
      expect(parseStreamLine(delta('Hel'))).toEqual({ type: 'text_delta', parentToolUseId: null, text: 'Hel' });
    });

    it('reads a text delta of a subagent with the id of the Agent call that started it', () => {
      expect(parseStreamLine(delta('lo', 'toolu_agent'))).toEqual({ type: 'text_delta', parentToolUseId: 'toolu_agent', text: 'lo' });
    });

    it('ignores a text delta with empty text', () => {
      expect(parseStreamLine(delta(''))).toEqual({ type: 'ignored' });
    });

    it('ignores a text delta without text', () => {
      expect(parseStreamLine(line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta' } } }))).toEqual({ type: 'ignored' });
    });

    it('ignores thinking and tool input deltas', () => {
      const thinking = line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
      const input = line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } } });
      expect([parseStreamLine(thinking), parseStreamLine(input)]).toEqual([{ type: 'ignored' }, { type: 'ignored' }]);
    });

    it('ignores a delta that carries text but is not a content_block_delta', () => {
      const event = line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', delta: { type: 'text_delta', text: 'x' } } });
      expect(parseStreamLine(event)).toEqual({ type: 'ignored' });
    });

    it('ignores message_start and a stream event without an inner event', () => {
      const start = line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } });
      expect([parseStreamLine(start), parseStreamLine(line({ type: 'stream_event' }))]).toEqual([{ type: 'ignored' }, { type: 'ignored' }]);
    });
  });

  it('ignores tool_progress heartbeats of a long MCP call', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'tool_progress', tool_use_id: 'toolu_1', heartbeat: true }))).toEqual({ type: 'ignored' });
  });

  it('labels an unknown event or invalid JSON as unknown instead of throwing', () => {
    expect(parseStreamLine(line({ type: 'brand_new' }))).toEqual({ type: 'unknown', label: 'brand_new' });
    expect(parseStreamLine(line({ type: 'system', subtype: 'brand_new' }))).toEqual({ type: 'unknown', label: 'system/brand_new' });
    expect(parseStreamLine('{not json')).toEqual({ type: 'unknown', label: 'invalid JSON' });
  });

  it('skips blank lines', () => {
    expect(parseStreamLine('   ')).toBeNull();
  });
});
