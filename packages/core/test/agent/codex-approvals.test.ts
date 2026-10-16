import { describe, expect, it } from 'vitest';
import { approvalReply, commandCall, elicitationCall, elicitationReply, judge, NO_PERMISSIONS, patchCalls } from '../../src/agent/codex/approvals';
import type { FileUpdateChange, McpToolCallItem } from '../../src/agent/codex/protocol';
import type { GateCall } from '../../src/agent/transport';
import type { HookAnswer } from '../../src/gate/hook-gate';

describe('patchCalls', () => {
  it('judges each changed file: a new one as Write, an edit as Edit with its diff, a deletion and a move as the shell command that does them', () => {
    expect(patchCalls('p1', [
      { path: '/p/new.ts', kind: { type: 'add' }, diff: 'export {};\n' },
      { path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b\n' },
      { path: "/p/it's.ts", kind: { type: 'delete' }, diff: '' },
      { path: '/p/old.ts', kind: { type: 'update', move_path: '/p/new name.ts' }, diff: '' },
    ], '/p')).toEqual([
      { tool_name: 'Write', tool_input: { file_path: '/p/new.ts', content: 'export {};\n' }, tool_use_id: 'p1', cwd: '/p' },
      { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts', diff: '-a\n+b\n' }, tool_use_id: 'p1', cwd: '/p' },
      { tool_name: 'Bash', tool_input: { command: "rm -- '/p/it'\\''s.ts'" }, tool_use_id: 'p1', cwd: '/p' },
      { tool_name: 'Bash', tool_input: { command: "mv -- '/p/old.ts' '/p/new name.ts'" }, tool_use_id: 'p1', cwd: '/p' },
    ]);
    const unknown = { path: '/p/b.ts', kind: { type: 'rename', to: '/p/c.ts' }, diff: '' } as unknown as FileUpdateChange;
    expect(patchCalls('p2', [{ path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '' }, unknown], '/p')).toEqual([]);
  });
});

describe('commandCall', () => {
  it("asks about an escalated command as Bash in its own cwd or the chat's, and about nothing for a stdin write or a request without a command", () => {
    const ask = (extra: object) => commandCall({ kind: 'command', threadId: 't', turnId: 'u', itemId: 'c1', command: 'echo x > f', reason: 'May I?', ...extra }, '/p');
    const bash = (cwd: string) => ({ tool_name: 'Bash', tool_input: { command: 'echo x > f', description: 'May I?' }, tool_use_id: 'c1', cwd });
    expect([ask({}), ask({ cwd: '/q' }), ask({ kind: 'writeStdin' }), ask({ command: null })]).toEqual([bash('/p'), bash('/q'), null, null]);
    expect([ask({ cwd: '' }), ask({ cwd: 'sub' })]).toEqual([bash('/p'), bash('/p/sub')]);
  });
});

describe('elicitationCall', () => {
  it('links an elicitation to the latest open call of its server with the same arguments, and to nothing for another kind of request', () => {
    const call = (id: string, server: string, args: Record<string, string>): McpToolCallItem =>
      ({ type: 'mcpToolCall', id, server, tool: 'write_note', status: 'inProgress', arguments: args, result: null, error: null });
    const calls = [call('m1', 'notes', { text: 'hi' }), call('m2', 'other', { text: 'hi' }), call('m3', 'notes', { text: 'hi' }), call('m4', 'notes', { text: 'bye' })];
    const ask = (kind: string) => ({ threadId: 't', turnId: 'u', serverName: 'notes', message: '', _meta: { codex_approval_kind: kind, tool_params: { text: 'hi' } } });
    expect([elicitationCall(ask('mcp_tool_call'), calls, '/p'), elicitationCall(ask('other'), calls, '/p')]).toEqual([
      { tool_name: 'mcp__notes__write_note', tool_input: { text: 'hi' }, tool_use_id: 'm3', cwd: '/p' }, null,
    ]);
    const read = { ...call('m5', 'notes', { text: 'hi' }), tool: 'read_note' };
    expect([elicitationCall(ask('mcp_tool_call'), [...calls, read], '/p'), elicitationCall({ ...ask('mcp_tool_call'), mode: 'url' }, calls, '/p')]).toEqual([null, null]);
  });
});

describe('judge', () => {
  it('accepts only when every call is allowed; declines at the first denial, without a gate or without a call; and leaves a hold that ended unanswered', async () => {
    const answer = (decision: 'allow' | 'deny'): HookAnswer => ({ permissionDecision: decision, permissionDecisionReason: 'r' });
    const call = (id: string): GateCall => ({ tool_name: 'Bash', tool_input: { command: id }, tool_use_id: id, cwd: '/p' });
    const asked: string[] = [];
    const decide = (verdicts: Record<string, HookAnswer>) => async (gateCall: GateCall) => {
      asked.push(gateCall.tool_use_id);
      return verdicts[gateCall.tool_use_id] ?? null;
    };
    const signal = new AbortController().signal;
    expect([
      await judge([call('a'), call('b')], decide({ a: answer('allow'), b: answer('allow') }), signal),
      await judge([call('c'), call('d')], decide({ c: answer('deny'), d: answer('allow') }), signal),
      await judge([call('e')], undefined, signal),
      await judge([], decide({}), signal),
      await judge([call('f')], decide({}), signal),
      asked,
    ]).toEqual(['accept', 'decline', 'decline', 'decline', null, ['a', 'b', 'c', 'f']]);
    expect(await judge([call('g')], async () => Promise.reject(new Error('store closed')), signal)).toBe('decline');
  });
});

describe('replies', () => {
  it('answer only accept or decline, with no content in an elicitation, and grant no extra permissions', () => {
    expect([approvalReply('accept'), approvalReply('decline'), elicitationReply('accept'), elicitationReply('decline'), NO_PERMISSIONS]).toEqual([
      { decision: 'accept' }, { decision: 'decline' },
      { action: 'accept', content: null, _meta: null }, { action: 'decline', content: null, _meta: null },
      { permissions: {}, scope: 'turn' },
    ]);
  });
});
