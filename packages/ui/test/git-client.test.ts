import { describe, expect, it } from 'vitest';
import type { ClientMessage } from '@ide/protocol';
import { GitClient } from '../src/git/git-client';

describe('GitClient', () => {
  it('resolves a request when the result with its id arrives, and ignores other ids', async () => {
    const sent: ClientMessage[] = [];
    const client = new GitClient((message) => { sent.push(message); return true; });
    const pending = client.request((requestId) => ({ type: 'git.commit', requestId, message: 'm' }));
    const requestId = (sent[0] as { requestId: string }).requestId;
    client.handle({ type: 'git.result', requestId: 'other', error: 'no' });
    client.handle({ type: 'git.result', requestId, error: null });
    await expect(pending).resolves.toEqual({ type: 'git.result', requestId, error: null });
  });

  it('resolves with an error when the message cannot be sent', async () => {
    const client = new GitClient(() => false);
    expect((await client.request((requestId) => ({ type: 'git.init', requestId }))).error).toBe('Not connected to the IDE core.');
  });

  it('settles everything pending with an error when the connection drops', async () => {
    const client = new GitClient(() => true);
    const pending = client.request((requestId) => ({ type: 'git.branches', requestId }));
    client.dropAll();
    expect((await pending).error).toBe('The connection to the IDE core was lost.');
  });
});
