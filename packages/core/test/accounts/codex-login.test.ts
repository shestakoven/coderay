import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { AccountLoginView } from '@ide/protocol';
import { AccountLogin } from '../../src/accounts/account-login';
import { AccountStore } from '../../src/accounts/account-store';
import { codexLogin, codexLogout } from '../../src/accounts/codex-login';
import { isAlive } from '../../src/os-process';
import { codexRecords, fakeCodex, sent } from '../fake-codex/fake';
import { tempDir, waitFor } from '../helpers';

function setup(env: Record<string, string> = {}) {
  const home = tempDir('ide-codex-login-');
  const record = join(home, 'record.jsonl');
  const codex = fakeCodex(null, record, env);
  const store = new AccountStore({ home, engine: 'codex', logout: codexLogout(() => codex) });
  const views: AccountLoginView[] = [];
  const pidDir = join(home, 'run');
  const login = new AccountLogin({ engines: { codex: { store, flow: codexLogin(() => codex, pidDir) } }, now: () => 5, onChange: () => views.push(login.view()) });
  onTestFinished(() => login.cancel());
  return { home, record, store, views, login, pidDir, records: () => codexRecords(record) };
}

describe('Codex sign-in', () => {
  it.each([
    ['browser', 'browser', null, {}, { type: 'chatgpt' }, 'https://auth.example.test/oauth/authorize?state=FAKESTATE', null, { email: 'new@example.com', plan: 'Plus' }],
    ['device-code', 'device-code', null, {}, { type: 'chatgptDeviceCode' }, 'https://auth.example.test/codex/device', 'ABCD-1234', { email: 'new@example.com', plan: 'Plus' }],
    ['api-key', 'api-key', 'sk-test-key-123', {}, { type: 'apiKey', apiKey: 'sk-test-key-123' }, null, null, { email: 'API key' }],
    ['api-key that codex stores without saying so', 'api-key', 'sk-test-key-123', { FAKE_CODEX_LOGIN: 'silent' }, { type: 'apiKey', apiKey: 'sk-test-key-123' }, null, null, { email: 'API key' }],
  ] as const)('signs a new account in with %s, in its own home and file store, and names it from codex', async (_, method, key, env, params, url, userCode, named) => {
    const { store, views, login, records } = setup(env);
    login.start('codex', method, key);
    await waitFor(() => store.list().accounts.length === 1, 'the account saved');
    const account = store.list().accounts[0]!;
    const started = records().find((entry) => entry.argv !== undefined)!;
    expect([
      sent(records(), 'account/login/start'), views.find((view) => view.url !== null)?.url ?? null, views.find((view) => view.userCode !== null)?.userCode ?? null,
      { email: account.email, ...(account.plan ? { plan: account.plan } : {}) }, started.codexHome, started.argv?.slice(1), login.view().state, isAlive(started.pid!),
    ]).toEqual([[params], url, userCode, named, store.homeDir(account.id), ['-c', 'cli_auth_credentials_store="file"', '-c', 'features.hooks=false', '-c', 'notify=[]'], 'idle', false]);
  });

  it.each([
    ['codex did not complete it', 'browser', null, { FAKE_CODEX_LOGIN_ERROR: 'Login was not completed.' }, 'Login was not completed.'],
    ["codex's words repeat the key", 'api-key', 'sk-test-key-123', { FAKE_CODEX_LOGIN_ERROR: 'Key sk-test-key-123 (sk-test************0123, Bearer abc.def=) refused, see https://auth.example.test/help?key=sk-test-key-123#top' },
      'Key … ([key hidden], [key hidden]) refused, see https://auth.example.test/help'],
    ['another sign-in took over', 'browser', null, { FAKE_CODEX_LOGIN_ERROR: 'Login server error: Login cancelled' }, 'Another Codex sign-in on this computer took over; start again.'],
    ['its page is no web address', 'browser', null, { FAKE_CODEX_AUTH_URL: 'file:///etc/passwd' }, 'Codex started a sign-in CodeRay cannot show.'],
  ] as const)("says why a sign-in failed (%s) without the key or a URL's query, keeps no account and leaves no directory", async (_, method, key, env, shown) => {
    const { home, store, login } = setup({ FAKE_CODEX_LOGIN: 'fail', ...env });
    login.start('codex', method, key);
    const failed = await waitFor(() => login.view().state === 'error' && login.view(), 'the sign-in failed');
    expect([failed.error, store.list().accounts, readdirSync(join(home, 'codex-accounts'))]).toEqual([shown, [], []]);
  });

  it('cancels a waiting sign-in through codex, stops its app-server and its pid file, and removes what codex wrote into the home meanwhile', async () => {
    const { home, pidDir, login, records } = setup({ FAKE_CODEX_LOGIN: 'hang' });
    login.start('codex', 'browser');
    await waitFor(() => login.view().url !== null, 'the sign-in page');
    const pid = records().find((entry) => entry.pid !== undefined)!.pid!;
    const recorded = readdirSync(pidDir);
    login.cancel();
    await waitFor(() => !isAlive(pid) && readdirSync(join(home, 'codex-accounts')).length === 0, 'the app-server stopped and its home gone');
    expect([sent(records(), 'account/login/cancel'), recorded, readdirSync(pidDir)]).toEqual([[{ loginId: 'login-1' }], [`codex-${pid}.pid.json`], []]);
  });

  it('signs a Codex account out through codex before its directory goes', async () => {
    const { store, login, records } = setup();
    login.start('codex', 'device-code');
    await waitFor(() => store.list().accounts.length === 1, 'the account saved');
    const id = store.list().accounts[0]!.id;
    const dir = store.homeDir(id)!;
    await store.remove(id);
    const logouts = records().filter((entry) => entry.in?.method === 'account/logout');
    expect([logouts.length, existsSync(dir), store.list().accounts]).toEqual([1, false, []]);
  });
});
