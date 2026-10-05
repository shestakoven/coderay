import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { eventRoute, type EventAnswer } from '../../src/gate/event-route';
import { startServer } from '../../src/server/server';

async function events(handle: (sessionId: string, event: unknown) => EventAnswer) {
  const calls: { sessionId: string; event: unknown }[] = [];
  const route = eventRoute({
    secret: 's3cret',
    handle: (sessionId, event) => {
      calls.push({ sessionId, event });
      return handle(sessionId, event);
    },
  });
  const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [route] });
  onTestFinished(() => server.close());
  const post = (body: string, authorization: string | null = 'Bearer s3cret', method = 'POST') =>
    fetch(`http://127.0.0.1:${server.port}/hook/event`, {
      method, headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) }, ...(method === 'POST' ? { body } : {}),
    });
  return { calls, post };
}

const body = (sessionId: unknown, event: unknown) => JSON.stringify({ sessionId, event });

describe('eventRoute', () => {
  it('hands the session id and the event of the hook to the session', async () => {
    const { calls, post } = await events(() => null);
    const event = { hook_event_name: 'Stop', session_id: 'claude-1', last_assistant_message: 'Done.' };
    await post(body('s1', event));
    expect(calls).toEqual([{ sessionId: 's1', event }]);
  });

  it('answers 204 when the session has nothing to add', async () => {
    const { post } = await events(() => null);
    const res = await post(body('s1', {}));
    expect([res.status, await res.text()]).toEqual([204, '']);
  });

  it('answers the hook with the JSON the session gives, for claude to read', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'заметка' } };
    const { post } = await events(() => answer);
    const res = await post(body('s1', {}));
    expect([res.status, res.headers.get('content-type'), await res.json()]).toEqual([200, 'application/json', answer]);
  });

  it('answers 401 without the secret, with a wrong one, and to a request that is not a POST, and tells the session nothing', async () => {
    const { calls, post } = await events(() => null);
    const statuses = [
      (await post(body('s1', {}), null)).status,
      (await post(body('s1', {}), 'Bearer nope')).status,
      (await post(body('s1', {}), 'Basic s3cret')).status,
      (await post('', 'Bearer s3cret', 'GET')).status,
    ];
    expect([statuses, calls]).toEqual([[401, 401, 401, 401], []]);
  });

  it.each([['not json'], ['{"event":{}}'], ['{"sessionId":7,"event":{}}'], ['[]'], ['42']])('answers 400 to the body %s and tells the session nothing', async (raw) => {
    const { calls, post } = await events(() => null);
    expect([(await post(raw)).status, calls]).toEqual([400, []]);
  });

  it('accepts an event of several megabytes', async () => {
    const { calls, post } = await events(() => null);
    const res = await post(body('s1', { prompt: 'x'.repeat(3 * 1024 * 1024) }));
    expect([res.status, calls.length]).toEqual([204, 1]);
  });

  it('answers 204, not an error, when the session fails to handle an event', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const { post } = await events(() => {
      throw new Error('boom');
    });
    const res = await post(body('s1', {}));
    expect([res.status, errors.mock.calls.length]).toEqual([204, 1]);
  });

  it('refuses to be built without a secret', () => {
    expect(() => eventRoute({ secret: '', handle: () => null })).toThrow(/secret/);
  });
});
