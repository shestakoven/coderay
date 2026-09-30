import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

describe('parseClientMessage', () => {
  it('parses a chat message with its text', () => {
    expect(parseClientMessage('{"type":"chat.send","text":"hi"}')).toEqual({ type: 'chat.send', text: 'hi' });
  });

  it('rejects a chat message without string text', () => {
    expect(parseClientMessage('{"type":"chat.send","text":1}')).toBeNull();
  });

  it('parses stop, restart and new-session requests', () => {
    expect(['chat.stop', 'session.restart', 'session.new'].map((type) => parseClientMessage(JSON.stringify({ type }))))
      .toEqual([{ type: 'chat.stop' }, { type: 'session.restart' }, { type: 'session.new' }]);
  });

  it('parses the answer to a prompt', () => {
    const message = { type: 'prompt.answer', requestId: 'req_1', answer: { kind: 'answers', answers: { 'Which color?': 'blue' } } };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it('rejects a prompt answer whose answers are not all text', () => {
    const message = { type: 'prompt.answer', requestId: 'req_1', answer: { kind: 'answers', answers: { 'Which color?': 1 } } };
    expect(parseClientMessage(JSON.stringify(message))).toBeNull();
  });

  it('rejects unknown types, non-objects and invalid JSON', () => {
    expect(['{"type":"nope"}', '[1]', 'nope'].map(parseClientMessage)).toEqual([null, null, null]);
  });

  it('parses Settings requests with their request ids and the hashes the user saw', () => {
    const entry = { type: 'http', url: 'https://docs.example/mcp' };
    const messages = [
      { type: 'settings.get' },
      { type: 'mcp.save', requestId: 'r1', level: 'ide', name: 'docs', entry, previousName: null },
      { type: 'mcp.remove', requestId: 'r2', level: 'project', name: 'docs' },
      { type: 'mcp.approve', requestId: 'r3', name: 'docs', entryHash: 'abc' },
      { type: 'mcp.confirm-external-edits', requestId: 'r4', fileHashes: { ideServers: 'a', trust: 'b' } },
    ];
    expect(messages.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual(messages);
  });

  it('rejects malformed Settings requests', () => {
    const bad = [
      { type: 'mcp.remove', level: 'ide', name: 'docs' },
      { type: 'mcp.approve', requestId: 'r1', name: 'docs' },
      { type: 'mcp.save', requestId: 'r2', level: 'machine', name: 'docs', entry: {}, previousName: null },
    ];
    expect(bad.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual([null, null, null]);
  });

  it('parses a policy save for a level with the policy object, leaving validation to PolicyStore', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'policy.save', requestId: 'r1', level: 'project', policy: { mode: 'A' } })))
      .toEqual({ type: 'policy.save', requestId: 'r1', level: 'project', policy: { mode: 'A' } });
    expect(parseClientMessage(JSON.stringify({ type: 'policy.save', requestId: 'r1', level: 'team', policy: {} }))).toBeNull();
  });

  it('parses a confirmation of outside policy edits with both hashes', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'policy.confirm-external-edits', requestId: 'r2', hashes: { ide: 'a', project: 'b' } })))
      .toEqual({ type: 'policy.confirm-external-edits', requestId: 'r2', hashes: { ide: 'a', project: 'b' } });
    expect(parseClientMessage(JSON.stringify({ type: 'policy.confirm-external-edits', requestId: 'r2', hashes: { ide: 'a' } }))).toBeNull();
  });

  it('parses a plan answer with its plan id, version and answer', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'plan.answer', planId: 'p', version: 2, answer: { kind: 'changes', feedback: 'less' } })))
      .toEqual({ type: 'plan.answer', planId: 'p', version: 2, answer: { kind: 'changes', feedback: 'less' } });
    expect(parseClientMessage(JSON.stringify({ type: 'plan.answer', planId: 'p', version: 2, answer: { kind: 'approve' } })))
      .toEqual({ type: 'plan.answer', planId: 'p', version: 2, answer: { kind: 'approve' } });
    expect(parseClientMessage(JSON.stringify({ type: 'plan.answer', planId: 'p', version: 1.5, answer: { kind: 'approve' } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'plan.answer', planId: 'p', version: 1, answer: { kind: 'reject' } }))).toBeNull();
  });

  it('parses a gate answer and refuses an unknown one', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'gate.answer', promptId: 'g', answer: 'expand-plan' })))
      .toEqual({ type: 'gate.answer', promptId: 'g', answer: 'expand-plan' });
    expect(parseClientMessage(JSON.stringify({ type: 'gate.answer', promptId: 'g', answer: 'always' }))).toBeNull();
  });

  it('refuses a plan answer without a string plan id or with a version below 1', () => {
    const bad = [
      { type: 'plan.answer', version: 1, answer: { kind: 'approve' } },
      { type: 'plan.answer', planId: 7, version: 1, answer: { kind: 'approve' } },
      { type: 'plan.answer', planId: 'p', version: 0, answer: { kind: 'approve' } },
      { type: 'plan.answer', planId: 'p', version: -1, answer: { kind: 'approve' } },
    ];
    expect(bad.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual([null, null, null, null]);
  });

  it('refuses a gate answer without a string prompt id', () => {
    const bad = [
      { type: 'gate.answer', answer: 'deny' },
      { type: 'gate.answer', promptId: 7, answer: 'deny' },
    ];
    expect(bad.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual([null, null]);
  });
});
