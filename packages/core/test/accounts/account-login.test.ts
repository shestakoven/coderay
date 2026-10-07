import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AccountLoginView } from '@ide/protocol';
import { AccountLogin } from '../../src/accounts/account-login';
import { AccountStore } from '../../src/accounts/account-store';
import { isAlive } from '../../src/os-process';
import { tempDir, waitFor } from '../helpers';
import { accountsDir, accountsFile, fakeCli, filesUnder, mode, withEnv, type FakeCliConfig } from './fake-cli';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = 'new.person@example.com';

type CodeOutcome = 'ok' | 'signed-out' | 'invalid';

function setup(config: FakeCliConfig = {}, { timeoutMs, outcome = 'ok' }: { timeoutMs?: number; outcome?: CodeOutcome } = {}) {
  const home = tempDir('ide-login-home-');
  const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=URLSENTINEL${randomUUID().slice(0, 8)}`;
  const code = `CODESENTINEL-${randomUUID()}`;
  const cli = fakeCli({ url, email: EMAIL, codes: outcome === 'invalid' ? {} : { [code]: outcome }, ...config });
  const accounts = new AccountStore({ home, claude: cli.command });
  const views: AccountLoginView[] = [];
  const login = new AccountLogin({
    accounts, claude: cli.command, now: () => 4242, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    onChange: () => views.push(login.view()),
  });
  onTestFinished(() => {
    if (login.view().state !== 'idle') login.cancel();
  });
  const loginRecord = () => cli.invocations('auth login')[0];
  const helperPid = () => cli.records().find((entry) => entry.helperPid !== undefined)?.helperPid;
  const waiting = () => waitFor(() => login.view().url !== null && login.view(), 'sign-in URL shown');
  const settled = (state: AccountLoginView['state']) => waitFor(() => login.view().state === state && login.view(), `login ${state}`);
  return { home, url, code, cli, accounts, views, login, loginRecord, helperPid, waiting, settled };
}

const pendingDirs = (home: string): string[] => (existsSync(accountsDir(home)) ? readdirSync(accountsDir(home)) : []);

describe('AccountLogin.start', () => {
  it('waits for a code with the sign-in URL stripped of its terminal hyperlink and colour sequences', async () => {
    const { login, url, waiting } = setup();
    login.start();
    expect(await waiting()).toStrictEqual({ state: 'waiting', url, error: null });
  });

  it('is waiting before claude has printed the URL', () => {
    const { login } = setup();
    login.start();
    expect(login.view()).toStrictEqual({ state: 'waiting', url: null, error: null });
  });

  it.each(['target', 'text'] as const)('never exposes half of a URL split across two output chunks inside the link %s', async (splitAt) => {
    const { login, url, views } = setup({ splitAt });
    const seen = new Set<string | null>();
    login.start();
    await waitFor(() => {
      seen.add(login.view().url);
      return login.view().url === url;
    }, 'whole URL shown');
    for (const view of views) seen.add(view.url);
    expect([...seen].filter((shown) => shown !== null)).toStrictEqual([url]);
  });

  it('runs claude auth login with CLAUDE_CONFIG_DIR of a new uuid directory under claude-accounts', async () => {
    const { home, login, loginRecord, waiting } = setup();
    login.start();
    await waiting();
    const configDir = loginRecord()?.configDir ?? '';
    expect([dirname(configDir), UUID.test(basename(configDir)), existsSync(configDir), mode(configDir)]).toStrictEqual([accountsDir(home), true, true, 0o700]);
  });

  it('removes CLAUDECODE from the environment of claude', async () => {
    withEnv('CLAUDECODE', '1');
    const { login, loginRecord, waiting } = setup();
    login.start();
    await waiting();
    expect(loginRecord()?.claudecode).toBeNull();
  });

  it('refuses a second start while one sign-in is running and keeps the first', async () => {
    const { login, url, cli, waiting } = setup();
    login.start();
    await waiting();
    expect(() => login.start()).toThrow();
    expect([login.view(), cli.invocations('auth login').length]).toStrictEqual([{ state: 'waiting', url, error: null }, 1]);
  });
});

describe('AccountLogin.submitCode', () => {
  it('writes the code and a newline to the stdin of claude', async () => {
    const { login, code, cli, waiting } = setup({}, { outcome: 'invalid' });
    login.start();
    await waiting();
    login.submitCode(code);
    const bytes = await waitFor(() => cli.stdin(), 'code written to claude');
    expect(bytes.toString('utf8')).toBe(`${code}\n`);
  });

  it('registers the signed-in account by the email claude reports, under the directory it signed in to, and returns to idle', async () => {
    const { login, code, accounts, loginRecord, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    const id = basename(loginRecord()?.configDir ?? '');
    expect([accounts.list().accounts, accounts.configDir(id), login.view()]).toStrictEqual([
      [{ id, email: EMAIL, createdAt: 4242 }], loginRecord()?.configDir, { state: 'idle', url: null, error: null },
    ]);
  });

  it('passes through checking while claude auth status runs in the new directory', async () => {
    const { login, code, cli, views, loginRecord, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    const status = cli.invocations('auth status');
    expect([views.map((view) => view.state).filter((state, at, all) => state !== all[at - 1]), status.map((entry) => entry.configDir), status[0]?.args]).toStrictEqual([
      ['waiting', 'checking', 'idle'], [loginRecord()?.configDir], ['auth', 'status', '--json'],
    ]);
  });

  it('does not make the new account active', async () => {
    const { login, code, accounts, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    expect([accounts.activeId(), accounts.claudeEnv()]).toStrictEqual([null, {}]);
  });

  it('keeps the account dir at mode 0700 after it is registered', async () => {
    const { login, code, accounts, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    expect(mode(accounts.configDir(accounts.list().accounts[0]!.id) ?? '')).toBe(0o700);
  });
});

describe('AccountLogin failures', () => {
  const expectFailed = (home: string, accounts: AccountStore, view: AccountLoginView) => {
    expect([view.state, view.url, typeof view.error === 'string' && view.error.trim().length > 0 && view.error.length <= 200]).toStrictEqual(['error', null, true]);
    expect([accounts.list(), pendingDirs(home), existsSync(accountsFile(home))]).toStrictEqual([{ accounts: [], activeId: null }, [], false]);
  };

  it('discards the attempt when claude exits 0 but auth status says it is not signed in', async () => {
    const { home, login, code, cli, accounts, waiting, settled } = setup({}, { outcome: 'signed-out' });
    login.start();
    await waiting();
    login.submitCode(code);
    expectFailed(home, accounts, await settled('error'));
    expect(cli.invocations('auth status')).toHaveLength(1);
  });

  it('discards the attempt when claude auth login exits non-zero for a wrong code', async () => {
    const { home, login, accounts, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode('wrong-code');
    expectFailed(home, accounts, await settled('error'));
  });

  it('discards the attempt when claude auth login exits non-zero even if auth status reports a signed-in account', async () => {
    const { home, login, accounts, waiting, settled } = setup({ statusEmail: 'system.user@example.com' });
    login.start();
    await waiting();
    login.submitCode('wrong-code');
    expectFailed(home, accounts, await settled('error'));
  });

  it('discards the attempt when claude auth login exits before printing a URL', async () => {
    const { home, login, accounts, settled } = setup({ exitAtStart: 1 });
    login.start();
    expectFailed(home, accounts, await settled('error'));
  });

  it('gives up after the timeout, stops claude and discards the attempt', async () => {
    const { home, login, accounts, loginRecord, helperPid, waiting, settled } = setup({}, { timeoutMs: 800 });
    login.start();
    await waiting();
    expectFailed(home, accounts, await settled('error'));
    const pids = [loginRecord()?.pid ?? -1, helperPid() ?? -1];
    await waitFor(() => pids.every((pid) => !isAlive(pid)), 'claude and its helper stopped');
  });

  it('leaves an existing accounts.json untouched when the attempt fails', async () => {
    const { home, login, accounts, waiting, settled } = setup();
    accounts.add({ id: randomUUID(), email: 'old@example.com', createdAt: 1 });
    const before = readFileSync(accountsFile(home), 'utf8');
    login.start();
    await waiting();
    login.submitCode('wrong-code');
    await settled('error');
    expect([readFileSync(accountsFile(home), 'utf8'), pendingDirs(home)]).toStrictEqual([before, []]);
  });
});

describe('AccountLogin.cancel', () => {
  it('stops claude and everything in its process group', async () => {
    const { login, loginRecord, helperPid, waiting } = setup();
    login.start();
    await waiting();
    const pids = [loginRecord()?.pid ?? -1, helperPid() ?? -1];
    expect(pids.map(isAlive)).toStrictEqual([true, true]);
    login.cancel();
    await waitFor(() => pids.every((pid) => !isAlive(pid)), 'claude and its helper stopped');
  });

  it('removes the pending directory, returns to idle and writes no accounts.json', async () => {
    const { home, login, waiting } = setup();
    login.start();
    await waiting();
    login.cancel();
    expect([login.view(), pendingDirs(home), existsSync(accountsFile(home))]).toStrictEqual([{ state: 'idle', url: null, error: null }, [], false]);
  });

  it('refuses a code after cancel and registers nothing', async () => {
    const { home, login, code, accounts, loginRecord, waiting } = setup();
    login.start();
    await waiting();
    const pid = loginRecord()?.pid ?? -1;
    login.cancel();
    expect(() => login.submitCode(code)).toThrow();
    await waitFor(() => !isAlive(pid), 'claude stopped');
    expect([accounts.list().accounts, pendingDirs(home)]).toStrictEqual([[], []]);
  });

  it('leaves an existing accounts.json unchanged', async () => {
    const { home, login, accounts, waiting } = setup();
    accounts.add({ id: randomUUID(), email: 'old@example.com', createdAt: 1 });
    const before = readFileSync(accountsFile(home), 'utf8');
    login.start();
    await waiting();
    login.cancel();
    expect(readFileSync(accountsFile(home), 'utf8')).toBe(before);
  });
});

describe('AccountLogin keeps the sign-in secrets off disk and out of logs', () => {
  function captureConsole(): () => string {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
      onTestFinished(() => spy.mockRestore());
    }
    return () => lines.join('\n');
  }

  const onDisk = (home: string): string => filesUnder(home).map((file) => readFileSync(file, 'utf8')).join('\n');

  it('writes neither the URL nor the code anywhere under CodeRay home after a successful sign-in, and logs neither', async () => {
    const logged = captureConsole();
    const { home, url, code, login, waiting, settled } = setup();
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    const both = `${onDisk(home)}\n${logged()}`;
    expect([both.includes(url), both.includes('URLSENTINEL'), both.includes(code)]).toStrictEqual([false, false, false]);
  });

  it('writes neither the URL nor the code to disk or logs when the sign-in fails', async () => {
    const logged = captureConsole();
    const { home, url, code, login, accounts, waiting, settled } = setup({}, { outcome: 'invalid' });
    accounts.add({ id: randomUUID(), email: 'old@example.com', createdAt: 1 });
    login.start();
    await waiting();
    login.submitCode(code);
    const failed = await settled('error');
    const all = `${onDisk(home)}\n${logged()}\n${failed.error}`;
    expect([all.includes(url), all.includes('URLSENTINEL'), all.includes(code)]).toStrictEqual([false, false, false]);
  });

  it('keeps an accounts.json written during the sign-in free of the URL and code', async () => {
    const { home, url, code, login, waiting, settled } = setup();
    writeFileSync(accountsFile(home), JSON.stringify({ accounts: [], activeId: null }));
    login.start();
    await waiting();
    login.submitCode(code);
    await settled('idle');
    const saved = readFileSync(accountsFile(home), 'utf8');
    expect([saved.includes(url), saved.includes(code), JSON.parse(saved).accounts[0].email]).toStrictEqual([false, false, EMAIL]);
  });
});
