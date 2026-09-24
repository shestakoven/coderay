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
});
