import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatItem } from '@ide/protocol';
import { AccountStore } from '../../src/accounts/account-store';
import { AgentSession, SessionError } from '../../src/agent/agent-session';
import { projectDir } from '../../src/home';
import { isAlive } from '../../src/os-process';
import { openStore, type Store } from '../../src/store/store';
import { accountsDir, fakeCli, seedAccounts, withEnv, type SeededAccount } from '../accounts/fake-cli';
import { argValue, fakeClaude, hasArg, readRecords } from '../fake-claude/fake';
import { SONNET, tempDir, waitFor } from '../helpers';

interface Harness {
  session: AgentSession;
  store: Store;
  accounts: AccountStore;
  close: () => Promise<void>;
  spawns: () => { argv: string[]; configDir: string | null; pid: number; credentials: string[] | null }[];
}

interface World {
  home: string;
  root: string;
  seeded: SeededAccount[];
  accounts: AccountStore;
  dirOf: (account: SeededAccount) => string;
}

function world(active: number | null): World {
  withEnv('CLAUDE_CONFIG_DIR', undefined);
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const seeded = seedAccounts(home, ['a@example.com', 'b@example.com'], active);
  const accounts = new AccountStore({ home, claude: fakeCli().command });
  return { home, root, seeded, accounts, dirOf: (account) => join(accountsDir(home), account.id) };
}

async function harness(w: World, scenario = 'multi-turn'): Promise<Harness> {
  const store = openStore(projectDir(w.home, w.root));
  const recordFile = join(w.home, `record-${randomUUID()}.jsonl`);
  const session = new AgentSession({ root: w.root, home: w.home, store, claude: fakeClaude(scenario, recordFile), accounts: w.accounts, defaultModel: SONNET });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.close();
    store.close();
  };
  onTestFinished(close);
  await session.start();
  return {
    session, store, accounts: w.accounts, close,
    spawns: () => readRecords(recordFile).flatMap((r) => (r.argv ? [{ argv: r.argv, configDir: r.configDir ?? null, pid: r.pid ?? -1, credentials: r.credentials ?? null }] : [])),
  };
}

const flag = argValue;
const closedTurns = (h: Harness) => h.session.state().turns.filter((turn) => turn.closedAt !== null).length;
const itemTexts = (items: ChatItem[]) => items.flatMap((item) => (item.kind === 'tool' || item.kind === 'prompt' ? [] : [item.text]));
const switchNotices = (h: Harness) => itemTexts(h.session.state().items).filter((text) => text.includes('Switched to account'));

async function firstTurn(h: Harness): Promise<{ argv: string[]; configDir: string | null; pid: number; credentials: string[] | null }> {
  h.session.send('Remember the number 42. Reply with only: OK');
  await waitFor(() => closedTurns(h) === 1, 'first turn closed');
  return h.spawns()[0]!;
}

async function nextSpawn(h: Harness): Promise<{ argv: string[]; configDir: string | null; pid: number; credentials: string[] | null }> {
  const count = h.spawns().length;
  h.session.send('What number did I ask you to remember?');
  const spawns = await waitFor(() => h.spawns().length === count + 1 && h.spawns(), 'claude spawned again');
  return spawns.at(-1)!;
}

describe('AgentSession under a Claude account', () => {
  it('gives claude no CLAUDE_CONFIG_DIR and records System on a session started under System', async () => {
    const w = world(null);
    const h = await harness(w);
    const first = await firstTurn(h);
    expect([first.configDir, h.store.latestSession()?.accountId]).toStrictEqual([null, null]);
  });

  it('gives claude CLAUDE_CONFIG_DIR of the active account and records that account on the session', async () => {
    const w = world(1);
    const h = await harness(w);
    const first = await firstTurn(h);
    // The claude that lists the models runs under the account too.
    await h.session.engines.get('claude')?.listModels();
    expect([first.configDir, h.store.latestSession()?.accountId, typeof flag(first.argv, '--session-id'), h.spawns().at(-1)?.configDir]).toStrictEqual([
      w.dirOf(w.seeded[1]!), w.seeded[1]!.id, 'string', w.dirOf(w.seeded[1]!),
    ]);
  });

  it("takes the core's Anthropic credentials away from claude under an account and leaves them to a System session", async () => {
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    for (const name of names) vi.stubEnv(name, 'not-a-real-credential');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const w = world(0);
    const h = await harness(w);
    const first = await firstTurn(h);
    await h.session.restart();
    w.accounts.setActive(null);
    const second = await nextSpawn(h);
    expect([first.credentials, second.credentials]).toEqual([[], names]);
  });

  it('resumes the same claude session under the same account after a restart', async () => {
    const w = world(0);
    const h = await harness(w);
    const first = await firstTurn(h);
    await h.session.restart();
    const second = await nextSpawn(h);
    expect([flag(second.argv, '--resume'), hasArg(second.argv, '--session-id'), second.configDir, switchNotices(h)]).toStrictEqual([
      flag(first.argv, '--session-id'), false, w.dirOf(w.seeded[0]!), [],
    ]);
  });

  it('starts a fresh claude session under the new account when the active account changed since the session was created', async () => {
    const w = world(0);
    const h = await harness(w);
    const first = await firstTurn(h);
    await h.session.restart();
    w.accounts.setActive(w.seeded[1]!.id);
    const second = await nextSpawn(h);
    const fresh = flag(second.argv, '--session-id');
    expect([hasArg(second.argv, '--resume'), fresh === flag(first.argv, '--session-id'), second.configDir]).toStrictEqual([
      false, false, w.dirOf(w.seeded[1]!),
    ]);
    expect(h.store.latestSession()).toMatchObject({ engineSessionId: fresh, accountId: w.seeded[1]!.id });
  });

  it('tells the user it switched to the new account', async () => {
    const w = world(0);
    const h = await harness(w);
    await firstTurn(h);
    await h.session.restart();
    w.accounts.setActive(w.seeded[1]!.id);
    await nextSpawn(h);
    expect(switchNotices(h)).toHaveLength(1);
    expect(switchNotices(h)[0]).toContain('Switched to account b@example.com');
  });

  it('starts fresh under an account when the session was created under System', async () => {
    const w = world(null);
    const h = await harness(w);
    const first = await firstTurn(h);
    await h.session.restart();
    w.accounts.setActive(w.seeded[0]!.id);
    const second = await nextSpawn(h);
    expect([hasArg(second.argv, '--resume'), flag(second.argv, '--session-id') === flag(first.argv, '--session-id'), second.configDir]).toStrictEqual([
      false, false, w.dirOf(w.seeded[0]!),
    ]);
    expect(switchNotices(h)[0]).toContain('Switched to account a@example.com');
  });

  it('starts fresh under System with no CLAUDE_CONFIG_DIR when the account was switched back to System', async () => {
    const w = world(0);
    const h = await harness(w);
    await firstTurn(h);
    await h.session.restart();
    w.accounts.setActive(null);
    const second = await nextSpawn(h);
    expect([hasArg(second.argv, '--resume'), second.configDir, h.store.latestSession()?.accountId]).toStrictEqual([false, null, null]);
    expect(switchNotices(h)[0]).toContain('Switched to account System');
  });

  it('starts fresh after a core restart when the account changed while the core was down', async () => {
    const w = world(0);
    const before = await harness(w);
    const first = await firstTurn(before);
    await before.close();
    w.accounts.setActive(w.seeded[1]!.id);
    const after = await harness(w);
    const second = await nextSpawn(after);
    expect([hasArg(second.argv, '--resume'), flag(second.argv, '--session-id') === flag(first.argv, '--session-id'), second.configDir]).toStrictEqual([
      false, false, w.dirOf(w.seeded[1]!),
    ]);
  });

  it('resumes after a core restart when the account did not change', async () => {
    const w = world(1);
    const before = await harness(w);
    const first = await firstTurn(before);
    await before.close();
    const after = await harness(w);
    const second = await nextSpawn(after);
    expect([flag(second.argv, '--resume'), second.configDir]).toStrictEqual([flag(first.argv, '--session-id'), w.dirOf(w.seeded[1]!)]);
  });
});

describe('AgentSession.changeAccount', () => {
  async function busy(w: World): Promise<Harness> {
    const h = await harness(w, 'text-then-wait');
    h.session.send('look at it');
    await waitFor(() => itemTexts(h.session.state().items).includes('Looking at it.'), 'agent working');
    return h;
  }

  it('refuses to select an account while the agent is working, with busy-account, and changes nothing', async () => {
    const w = world(0);
    const h = await busy(w);
    const change = vi.fn(() => w.accounts.setActive(w.seeded[1]!.id));
    await expect(h.session.changeAccount(change)).rejects.toThrow(new SessionError('busy-account'));
    expect([change.mock.calls.length, w.accounts.activeId(), isAlive(h.spawns()[0]!.pid), h.session.isIdle()]).toStrictEqual([0, w.seeded[0]!.id, true, false]);
  });

  it('refuses to remove an account while the agent is working, and the account stays', async () => {
    const w = world(0);
    const h = await busy(w);
    await expect(h.session.changeAccount(() => w.accounts.remove(w.seeded[0]!.id))).rejects.toThrow(new SessionError('busy-account'));
    expect([w.accounts.list().accounts.map((account) => account.id), existsSync(w.dirOf(w.seeded[0]!))]).toStrictEqual([
      [w.seeded[0]!.id, w.seeded[1]!.id], true,
    ]);
  });

  it('applies the change while idle and stops the idle claude', async () => {
    const w = world(0);
    const h = await harness(w);
    const first = await firstTurn(h);
    expect(isAlive(first.pid)).toBe(true);
    await h.session.changeAccount(() => w.accounts.setActive(w.seeded[1]!.id));
    expect(w.accounts.activeId()).toBe(w.seeded[1]!.id);
    await waitFor(() => !isAlive(first.pid), 'idle claude stopped');
  });

  it('sends the next message to a fresh claude under the new account after a switch while idle', async () => {
    const w = world(0);
    const h = await harness(w);
    const first = await firstTurn(h);
    await h.session.changeAccount(() => w.accounts.setActive(w.seeded[1]!.id));
    const second = await nextSpawn(h);
    expect([hasArg(second.argv, '--resume'), flag(second.argv, '--session-id') === flag(first.argv, '--session-id'), second.configDir]).toStrictEqual([
      false, false, w.dirOf(w.seeded[1]!),
    ]);
  });

  it('applies a removal of the active account while idle, and the next claude runs under System', async () => {
    const w = world(0);
    const h = await harness(w);
    await firstTurn(h);
    await h.session.changeAccount(() => w.accounts.remove(w.seeded[0]!.id));
    const second = await nextSpawn(h);
    expect([w.accounts.activeId(), second.configDir, hasArg(second.argv, '--resume')]).toStrictEqual([null, null, false]);
  });
});
