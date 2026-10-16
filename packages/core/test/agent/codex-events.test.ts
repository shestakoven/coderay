import { describe, expect, it } from 'vitest';
import { CodexEvents } from '../../src/agent/codex/events';

const command = { type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'ls -la'", cwd: '/p', status: 'inProgress', commandActions: [{ type: 'listFiles', command: 'ls -la' }], aggregatedOutput: null, exitCode: null };
const created = { type: 'fileChange', id: 'w', changes: [{ path: '/p/new.ts', kind: { type: 'add' }, diff: 'x\n' }], status: 'inProgress' };
const edited = { type: 'fileChange', id: 'e', changes: [{ path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '' }, { path: '/p/b.ts', kind: { type: 'add' }, diff: '' }], status: 'inProgress' };
const piped = { ...command, id: 'p', command: "/bin/zsh -lc 'cd src && grep -c '\\''a b'\\'' x.ts | head'", commandActions: [{ type: 'unknown', command: 'cd src' }, { type: 'search', command: "grep -c 'a b' x.ts" }] };
const mcp = { type: 'mcpToolCall', id: 'm', server: 'idecore', tool: 'step', status: 'inProgress', arguments: { key: 'a', phase: 'start' }, result: null, error: null };

function codex(): CodexEvents {
  const events = new CodexEvents();
  events.thread('thread-1', 'gpt-6-luna', '0.160.0');
  return events;
}

describe('CodexEvents', () => {
  it("opens a turn on the thread as the chat's conversation, with codex's servers and skills, and streams and completes the reply", () => {
    const events = codex();
    events.setSkills(['probe-skill']);
    events.handle('mcpServer/startupStatus/updated', { name: 'idecore', status: 'ready' });
    events.handle('mcpServer/startupStatus/updated', { name: 'docs', status: 'starting' });
    expect([
      ...events.handle('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }),
      ...events.handle('item/started', { item: { type: 'agentMessage', id: 'm1', text: '' } }),
      ...events.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'O' }),
      ...events.handle('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'OK' } }),
      ...events.handle('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } }),
    ]).toEqual([
      { type: 'init', sessionId: 'thread-1', model: 'gpt-6-luna', cliVersion: '0.160.0', permissionMode: null, mcpServers: [{ name: 'idecore', status: 'connected' }, { name: 'docs', status: 'pending' }], skills: ['probe-skill'] },
      { type: 'text_delta', parentToolUseId: null, text: 'O' },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: 'OK' }] },
      { type: 'result', subtype: 'success', origin: null },
    ]);
  });

  it('names the tools as Claude does — a command Bash, a new file Write, any other patch Edit, an MCP call mcp__server__tool — and ends each with its result', () => {
    const events = codex();
    const uses = [command, created, edited, mcp, piped].flatMap((item) => events.handle('item/started', { item })).flatMap((event) => (event.type === 'assistant' ? event.blocks : []));
    const results = [
      { ...command, status: 'completed', aggregatedOutput: 'a\nb', exitCode: 0 },
      { ...created, status: 'declined' },
      { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } },
      { ...piped, status: 'declined' },
    ].flatMap((item) => events.handle('item/completed', { item })).flatMap((event) => (event.type === 'user' ? event.toolResults : []));
    expect([uses.map((block) => (block.kind === 'tool_use' ? [block.name, block.input] : block.kind)), results]).toEqual([
      [
        ['Bash', { command: 'ls -la' }], ['Write', { file_path: '/p/new.ts' }], ['Edit', { file_path: '/p/a.ts', files: ['/p/a.ts', '/p/b.ts'] }],
        ['mcp__idecore__step', { key: 'a', phase: 'start' }], ['Bash', { command: "cd src && grep -c 'a b' x.ts | head" }],
      ],
      [
        { toolUseId: 'c', isError: false, rejected: false, text: 'a\nb', images: [] },
        { toolUseId: 'w', isError: true, rejected: true, text: 'declined', images: [] },
        { toolUseId: 'm', isError: false, rejected: false, text: 'ok', images: [] },
        { toolUseId: 'p', isError: true, rejected: true, text: '', images: [] },
      ],
    ]);
  });

  it("forgets the calls still open when the turn ends, and says why a failed turn failed", () => {
    const events = codex();
    events.handle('item/started', { item: command });
    expect([
      ...events.handle('turn/completed', { turn: { id: 't', status: 'failed', error: { message: 'unexpected status 401' } } }),
      ...events.handle('item/completed', { item: { ...command, status: 'completed', exitCode: 0, aggregatedOutput: '' } }),
      events.item('c') ?? 'closed',
    ]).toEqual([{ type: 'notice', text: 'Codex: unexpected status 401' }, { type: 'result', subtype: 'failed', origin: null }, 'closed']);
  });

  it("keeps an open patch's latest changes for the gate, and hears only its own thread", () => {
    const events = codex();
    events.handle('item/started', { item: edited });
    const grown = [...edited.changes, { path: '/p/c.ts', kind: { type: 'delete' }, diff: '' }];
    events.handle('item/fileChange/patchUpdated', { threadId: 'thread-1', itemId: 'e', changes: grown });
    expect([
      ...events.handle('item/started', { threadId: 'sub-agent', item: command }),
      ...events.handle('item/agentMessage/delta', { threadId: 'sub-agent', itemId: 'x', delta: 'hi' }),
      events.item('e'),
      events.item('c') ?? 'not ours',
    ]).toEqual([{ ...edited, changes: grown }, 'not ours']);
  });

  it('reads what a partial notification still says, and never shows a missing message', () => {
    const events = codex();
    events.handle('item/started', { item: { ...mcp, id: 'n' } });
    expect([
      ...events.handle('item/started', { item: { type: 'commandExecution', id: 'x' } }),
      ...events.handle('item/completed', { item: { type: 'commandExecution', id: 'x', status: 'completed' } }),
      ...events.handle('item/started', { item: { type: 'fileChange', id: 'f', status: 'inProgress' } }),
      ...events.handle('item/completed', { item: { ...mcp, id: 'n', status: 'completed', result: { content: [null, { type: 'text', text: 'ok' }] } } }),
      ...events.handle('item/completed', { item: { type: 'agentMessage', id: 'a' } }),
      ...events.handle('thread/tokenUsage/updated', { tokenUsage: { total: {}, modelContextWindow: 258400 } }),
      ...events.handle('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 3, windowDurationMins: '300', resetsAt: 1 }, secondary: { usedPercent: 3, windowDurationMins: 300 } } }),
      ...events.handle('turn/completed', { turn: { id: 't', status: 'failed', error: {} } }),
    ]).toEqual([
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'x', name: 'Bash', input: { command: '' } }] },
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'x', isError: false, rejected: false, text: '', images: [] }] },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'f', name: 'Edit', input: { file_path: '' } }] },
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'n', isError: false, rejected: false, text: 'ok', images: [] }] },
      { type: 'usage', update: { contextWindow: 258400 } },
      { type: 'result', subtype: 'failed', origin: null },
    ]);
  });

  it("reads the context from the last request's tokens, and the account's limits as windows labelled by their length", () => {
    const events = codex();
    const last = { totalTokens: 18222, inputTokens: 18217, cachedInputTokens: 11008, outputTokens: 5, reasoningOutputTokens: 0 };
    expect([
      ...events.handle('thread/tokenUsage/updated', { tokenUsage: { total: { ...last, totalTokens: 54672 }, last, modelContextWindow: 258400 } }),
      ...events.handle('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 4102444800 }, secondary: { usedPercent: 41.5, windowDurationMins: 300, resetsAt: 4102444000 } } }),
      ...events.handle('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 3, windowDurationMins: null, resetsAt: null }, secondary: null } }),
    ]).toEqual([
      { type: 'usage', update: { contextTokens: 18222, contextWindow: 258400 } },
      { type: 'usage', update: { limits: [
        { label: '30d', name: 'thirty-day', minutes: 43200, utilization: 0.03, resetsAt: 4102444800 },
        { label: '5h', name: 'five-hour', minutes: 300, utilization: 0.415, resetsAt: 4102444000 },
      ] } },
    ]);
  });

  it('leaves retried errors to codex, tells the user once about one it gave up on, ignores what CodeRay does not show, and names what it does not know', () => {
    const events = codex();
    expect([
      ...events.handle('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true }),
      ...events.handle('error', { error: { message: 'stream disconnected' }, willRetry: false }),
      ...events.handle('turn/completed', { turn: { id: 't', status: 'failed', error: { message: 'stream disconnected' } } }),
      ...events.handle('turn/diff/updated', { diff: '' }),
      ...events.handle('item/plan/delta', { delta: 'x' }),
      ...events.handle('item/started', { item: { type: 'webSearch', id: 'ws' } }),
    ]).toEqual([
      { type: 'notice', text: 'Codex: stream disconnected' },
      { type: 'result', subtype: 'failed', origin: null },
      { type: 'unknown', label: 'item/plan/delta' },
      { type: 'unknown', label: 'item/webSearch' },
    ]);
  });
});
