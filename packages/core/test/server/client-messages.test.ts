import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/client-messages';

describe('parseClientMessage', () => {
  it('parses a chat message with its text', () => {
    expect(parseClientMessage('{"type":"chat.send","text":"hi"}')).toEqual({ type: 'chat.send', text: 'hi' });
  });

  it('rejects a chat message without string text', () => {
    expect(parseClientMessage('{"type":"chat.send","text":1}')).toBeNull();
  });

  describe('chat.send with images', () => {
    const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const send = (fields: object) => parseClientMessage(JSON.stringify({ type: 'chat.send', text: 'look', ...fields }));

    it('keeps valid images next to the text', () => {
      const jpeg = { mediaType: 'image/jpeg', data: 'AAEC' };
      expect(send({ images: [png, jpeg] })).toEqual({ type: 'chat.send', text: 'look', images: [png, jpeg] });
    });

    it('parses a message without images as text only', () => {
      expect(send({})).toStrictEqual({ type: 'chat.send', text: 'look' });
    });

    it('rejects an empty image list', () => {
      expect(send({ images: [] })).toBeNull();
    });

    it('accepts exactly twenty images', () => {
      expect(send({ images: Array(20).fill(png) })).toMatchObject({ images: Array(20).fill(png) });
    });

    it('rejects twenty-one images', () => {
      expect(send({ images: Array(21).fill(png) })).toBeNull();
    });

    it.each(['image/svg+xml', 'image/bmp', 'text/plain', ''])('rejects the media type "%s"', (mediaType) => {
      expect(send({ images: [{ mediaType, data: 'AAEC' }] })).toBeNull();
    });

    it('rejects an image without a media type', () => {
      expect(send({ images: [{ data: 'AAEC' }] })).toBeNull();
    });

    it.each(['not base64!', 'AA EC', 'data:image/png;base64,AAEC', '', 'AAEC===', '=AAEC'])('rejects the data "%s"', (data) => {
      expect(send({ images: [{ mediaType: 'image/png', data }] })).toBeNull();
    });

    it('rejects non-string data', () => {
      expect(send({ images: [{ mediaType: 'image/png', data: 12 }] })).toBeNull();
    });

    it('rejects one bad image among valid ones', () => {
      expect(send({ images: [png, { mediaType: 'image/png', data: '***' }] })).toBeNull();
    });

    it.each([['"x"'], ['{"0":{}}'], ['5'], ['null'], ['["x"]']])('rejects images that are not a list of image objects (%s)', (images) => {
      expect(parseClientMessage(`{"type":"chat.send","text":"look","images":${images}}`)).toBeNull();
    });
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

  it('parses the six history messages', () => {
    const messages = [
      { type: 'watchdog.answer', eventId: 'e', answer: { kind: 'files', files: { 'a.ts': 'revert', 'b.ts': 'mine' } } },
      { type: 'watchdog.answer', eventId: 'e', answer: { kind: 'all', answer: 'expand-plan' } },
      { type: 'watchdog.answer', eventId: 'e', answer: { kind: 'all', answer: 'keep' } },
      { type: 'watchdog.stop-agent', eventId: 'e' },
      { type: 'history.diff', requestId: 'r', path: 'a.ts', before: 'h1', after: null },
      { type: 'revert.undo', requestId: 'r', revertId: 'v' },
      { type: 'step.rollback-preview', requestId: 'r', planId: 'p', stepKey: 'k' },
      { type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 'k', confirm: ['a.ts'] },
    ];
    expect(messages.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual(messages);
  });

  it('rejects malformed watchdog answers', () => {
    const answers = [
      { kind: 'all', answer: 'burn' },
      { kind: 'all', answer: 'mine-please' },
      { kind: 'files', files: { 'a.ts': 'expand-plan' } },
      { kind: 'files', files: { 'a.ts': 3 } },
      { kind: 'files', files: 'a.ts' },
      { kind: 'some' },
      'keep',
    ];
    for (const answer of answers) expect(parseClientMessage(JSON.stringify({ type: 'watchdog.answer', eventId: 'e', answer }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'watchdog.answer', answer: { kind: 'all', answer: 'keep' } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'watchdog.stop-agent' }))).toBeNull();
  });

  it('rejects malformed history requests', () => {
    const bad = [
      { type: 'history.diff', requestId: 'r', path: 'a.ts', before: 1, after: null },
      { type: 'history.diff', requestId: 'r', path: 'a.ts', before: null },
      { type: 'history.diff', requestId: 'r', before: null, after: null },
      { type: 'history.diff', path: 'a.ts', before: null, after: null },
      { type: 'revert.undo', requestId: 'r' },
      { type: 'step.rollback-preview', requestId: 'r', planId: 'p' },
      { type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 'k' },
      { type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 'k', confirm: ['a.ts', 2] },
      { type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 'k', confirm: 'a.ts' },
    ];
    expect(bad.map((message) => parseClientMessage(JSON.stringify(message)))).toEqual(bad.map(() => null));
  });

  it('caps the rollback confirmation list at 5,000 files', () => {
    const rollback = (count: number) => ({ type: 'step.rollback', requestId: 'r', planId: 'p', stepKey: 'k', confirm: Array.from({ length: count }, (_, i) => `f${i}`) });
    expect(parseClientMessage(JSON.stringify(rollback(5000)))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify(rollback(5001)))).toBeNull();
  });
});
