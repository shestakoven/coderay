import { describe, expect, it, onTestFinished } from 'vitest';
import { aliveRoute, Canary } from '../../src/gate/canary';
import { startServer } from '../../src/server/server';

describe('Canary', () => {
  it('resolves true for a ping that arrived before the wait', async () => {
    const canary = new Canary();
    canary.expect('s1');
    canary.ping('s1');
    expect(await canary.wait('s1', 50)).toBe(true);
  });

  it('resolves true for a ping that arrives during the wait', async () => {
    const canary = new Canary();
    canary.expect('s1');
    const waiting = canary.wait('s1', 5000);
    canary.ping('s1');
    expect(await waiting).toBe(true);
  });

  it('resolves false at the deadline and ignores pings of other sessions', async () => {
    const canary = new Canary();
    canary.expect('s1');
    canary.ping('s2');
    expect(await canary.wait('s1', 30)).toBe(false);
  });

  it('forgets an earlier ping when the session is expected again', async () => {
    const canary = new Canary();
    canary.ping('s1');
    canary.expect('s1');
    expect(await canary.wait('s1', 30)).toBe(false);
  });
});

describe('aliveRoute', () => {
  async function alive() {
    const canary = new Canary();
    const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [aliveRoute({ secret: 's3cret', canary })] });
    onTestFinished(() => server.close());
    const post = (body: string, authorization?: string) =>
      fetch(`http://127.0.0.1:${server.port}/hook/alive`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body,
      });
    return { canary, post };
  }

  it('answers 401 without the secret and pings nothing', async () => {
    const { canary, post } = await alive();
    canary.expect('s1');
    const statuses = [(await post('{"sessionId":"s1"}')).status, (await post('{"sessionId":"s1"}', 'Bearer nope')).status];
    expect([statuses, await canary.wait('s1', 30)]).toEqual([[401, 401], false]);
  });

  it('pings the session with the secret', async () => {
    const { canary, post } = await alive();
    canary.expect('s1');
    expect((await post('{"sessionId":"s1"}', 'Bearer s3cret')).status).toBe(204);
    expect(await canary.wait('s1', 1000)).toBe(true);
  });

  it('answers 400 to a body without a session id', async () => {
    const { post } = await alive();
    expect([(await post('{}', 'Bearer s3cret')).status, (await post('nope', 'Bearer s3cret')).status]).toEqual([400, 400]);
  });
});
