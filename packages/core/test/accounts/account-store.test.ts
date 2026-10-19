import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SignedHome } from '../../src/accounts/account-homes';
import { AccountError, AccountStore, claudeAccounts } from '../../src/accounts/account-store';
import { tempDir } from '../helpers';
import { accountsDir, accountsFile, fakeCli, mode, seedAccounts } from './fake-cli';

function setup(emails: string[] = [], active: number | null = null) {
  const home = tempDir('ide-accounts-home-');
  const cli = fakeCli();
  const seeded = emails.length > 0 ? seedAccounts(home, emails, active) : [];
  const store = () => claudeAccounts(home, cli.command);
  return { home, cli, seeded, store, dirOf: (id: string) => join(accountsDir(home), id) };
}

function victim(home: string): string {
  const dir = join(home, 'victim');
  mkdirSync(dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep');
  return dir;
}

const BAD_IDS: [string, (home: string) => string][] = [
  ['a parent-relative id', () => '../victim'],
  ['an absolute path', (home) => join(home, 'victim')],
  ['an empty string', () => ''],
  ['a uuid followed by ../', () => `${randomUUID()}/../../victim`],
  ['a non-uuid name', () => 'victim'],
  ['the accounts directory itself', () => '.'],
];

describe('AccountStore without accounts.json', () => {
  it('lists no accounts with System active', () => {
    const { store } = setup();
    expect(store().list()).toStrictEqual({ accounts: [], activeId: null });
  });

  it('gives claude no environment for System', () => {
    const { store } = setup();
    expect(store().activeEnv()).toStrictEqual({});
  });

  it('does not create accounts.json just by reading', () => {
    const { home, store } = setup();
    store().list();
    store().activeEnv();
    expect(existsSync(accountsFile(home))).toBe(false);
  });
});

describe('AccountStore with a corrupt accounts.json', () => {
  it.each([
    ['invalid JSON', '{"accounts": ['],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['accounts that are not a list', '{"accounts":"x","activeId":null}'],
    ['an empty file', ''],
  ])('reads %s as no accounts with System active, without throwing', (_, content) => {
    const { home, store } = setup();
    writeFileSync(accountsFile(home), content);
    expect([store().list(), store().activeEnv()]).toStrictEqual([{ accounts: [], activeId: null }, {}]);
  });

  it('never lists an entry whose id is a path instead of a uuid', () => {
    const { home, store } = setup();
    const good = { id: randomUUID(), email: 'good@example.com', createdAt: 1 };
    writeFileSync(accountsFile(home), JSON.stringify({ accounts: [good, { id: '../victim', email: 'evil@example.com', createdAt: 2 }], activeId: null }));
    expect(store().list().accounts.map((account) => account.id)).not.toContain('../victim');
  });
});

describe('AccountStore listing and the active account', () => {
  it('lists the accounts of accounts.json with their emails and creation times', () => {
    const { store, seeded } = setup(['a@example.com', 'b@example.com'], 1);
    expect(store().list()).toStrictEqual({
      accounts: [
        { id: seeded[0]!.id, email: 'a@example.com', createdAt: 1000 },
        { id: seeded[1]!.id, email: 'b@example.com', createdAt: 1001 },
      ],
      activeId: seeded[1]!.id,
    });
  });

  it('gives claude CLAUDE_CONFIG_DIR of the active account directory', () => {
    const { store, seeded, dirOf } = setup(['a@example.com', 'b@example.com'], 1);
    expect(store().activeEnv()).toStrictEqual({ CLAUDE_CONFIG_DIR: dirOf(seeded[1]!.id) });
  });

  it('names the config dir of an account inside <home>/claude-accounts and none for System', () => {
    const { store, seeded, dirOf } = setup(['a@example.com']);
    expect([store().homeDir(seeded[0]!.id), store().homeDir(null)]).toStrictEqual([dirOf(seeded[0]!.id), null]);
  });

  it('labels an account by its email and System as System', () => {
    const { store, seeded } = setup(['a@example.com']);
    expect([store().label(seeded[0]!.id), store().label(null)]).toStrictEqual(['a@example.com', 'System']);
  });

  it('switches to an account and back to System, persisting the choice for the next store', () => {
    const { store, seeded, dirOf } = setup(['a@example.com', 'b@example.com']);
    store().setActive(seeded[0]!.id);
    expect([store().activeId(), store().activeEnv()]).toStrictEqual([seeded[0]!.id, { CLAUDE_CONFIG_DIR: dirOf(seeded[0]!.id) }]);
    store().setActive(null);
    expect([store().activeId(), store().activeEnv()]).toStrictEqual([null, {}]);
  });

  it('writes accounts.json with mode 0600', () => {
    const { home, store, seeded } = setup(['a@example.com']);
    chmodSync(accountsFile(home), 0o644);
    store().setActive(seeded[0]!.id);
    expect(mode(accountsFile(home))).toBe(0o600);
  });

  it('creates accounts.json with mode 0600 when the first account is added', () => {
    const { home, store } = setup();
    const id = randomUUID();
    store().add({ id, email: 'new@example.com', createdAt: 5 });
    expect([mode(accountsFile(home)), store().list()]).toStrictEqual([0o600, { accounts: [{ id, email: 'new@example.com', createdAt: 5 }], activeId: null }]);
  });

  it('creates an account directory with mode 0700 inside <home>/claude-accounts', () => {
    const { store, dirOf } = setup();
    const id = randomUUID();
    const dir = store().createDir(id);
    expect([dir, mode(dir)]).toStrictEqual([dirOf(id), 0o700]);
  });

  it('refuses to activate an id that is not a known account and keeps the active one', () => {
    const { home, store, seeded } = setup(['a@example.com'], 0);
    const before = readFileSync(accountsFile(home), 'utf8');
    expect(() => store().setActive(randomUUID())).toThrow();
    expect([store().activeId(), readFileSync(accountsFile(home), 'utf8')]).toStrictEqual([seeded[0]!.id, before]);
  });
});

describe('AccountStore.remove', () => {
  it('removes only that account directory and entry, keeping the others', async () => {
    const { store, seeded, dirOf } = setup(['a@example.com', 'b@example.com'], 1);
    await store().remove(seeded[0]!.id);
    expect([existsSync(dirOf(seeded[0]!.id)), existsSync(join(dirOf(seeded[1]!.id), 'fake-credentials.json'))]).toStrictEqual([false, true]);
    expect(store().list()).toStrictEqual({ accounts: [{ id: seeded[1]!.id, email: 'b@example.com', createdAt: 1001 }], activeId: seeded[1]!.id });
  });

  it('falls back to System when the removed account was active, also in accounts.json', async () => {
    const { home, store, seeded } = setup(['a@example.com', 'b@example.com'], 0);
    await store().remove(seeded[0]!.id);
    expect([store().activeId(), store().activeEnv(), JSON.parse(readFileSync(accountsFile(home), 'utf8')).activeId]).toStrictEqual([null, {}, null]);
  });

  it('signs that account out of claude with its own CLAUDE_CONFIG_DIR', async () => {
    const { cli, store, seeded, dirOf } = setup(['a@example.com', 'b@example.com']);
    await store().remove(seeded[1]!.id);
    expect(cli.invocations('auth logout').map((entry) => entry.configDir)).toStrictEqual([dirOf(seeded[1]!.id)]);
  });

  it('rejects an unknown uuid and changes nothing', async () => {
    const { home, cli, store, seeded, dirOf } = setup(['a@example.com'], 0);
    const before = readFileSync(accountsFile(home), 'utf8');
    await expect(store().remove(randomUUID())).rejects.toThrow();
    expect([readFileSync(accountsFile(home), 'utf8'), existsSync(dirOf(seeded[0]!.id)), cli.invocations('auth logout')]).toStrictEqual([before, true, []]);
  });

  it('rejects a path-shaped id listed in a hand-edited accounts.json and deletes nothing outside claude-accounts', async () => {
    const { home, store } = setup();
    const target = victim(home);
    writeFileSync(accountsFile(home), JSON.stringify({ accounts: [{ id: '../victim', email: 'evil@example.com', createdAt: 1 }], activeId: null }));
    await expect(store().remove('../victim')).rejects.toThrow();
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('AccountStore refuses ids that are not uuids', () => {
  it.each(BAD_IDS)('remove rejects %s and deletes nothing', async (_, idFor) => {
    const { home, cli, store, seeded, dirOf } = setup(['a@example.com'], 0);
    const target = victim(home);
    const before = readFileSync(accountsFile(home), 'utf8');
    await expect(store().remove(idFor(home))).rejects.toThrow();
    expect([
      readFileSync(join(target, 'keep.txt'), 'utf8'),
      existsSync(join(dirOf(seeded[0]!.id), 'fake-credentials.json')),
      readFileSync(accountsFile(home), 'utf8'),
      cli.invocations('auth logout'),
    ]).toStrictEqual(['keep', true, before, []]);
  });

  it.each(BAD_IDS)('setActive rejects %s and keeps the active account', (_, idFor) => {
    const { home, store, seeded } = setup(['a@example.com'], 0);
    expect(() => store().setActive(idFor(home))).toThrow();
    expect(store().activeId()).toBe(seeded[0]!.id);
  });

  it.each(BAD_IDS)('configDir rejects %s', (_, idFor) => {
    const { home, store } = setup();
    expect(() => store().homeDir(idFor(home))).toThrow();
  });

  it.each(BAD_IDS)('createDir rejects %s and creates no directory', (_, idFor) => {
    const { home, store } = setup();
    expect(() => store().createDir(idFor(home))).toThrow();
    const created = existsSync(accountsDir(home)) ? readdirSync(accountsDir(home)) : [];
    expect([readdirSync(home).filter((name) => name !== 'claude-accounts'), created]).toStrictEqual([[], []]);
  });

  it.each(BAD_IDS)('discardDir rejects %s and deletes nothing', (_, idFor) => {
    const { home, store, seeded, dirOf } = setup(['a@example.com']);
    const target = victim(home);
    expect(() => store().discardDir(idFor(home))).toThrow();
    expect([readFileSync(join(target, 'keep.txt'), 'utf8'), existsSync(join(dirOf(seeded[0]!.id), 'fake-credentials.json'))]).toStrictEqual(['keep', true]);
  });
});

const codexStore = (home: string, logout: (account: SignedHome) => void = () => {}) =>
  new AccountStore({ home, engine: 'codex', logout: async (account) => logout(account) });
const PLUS = (id: string) => ({ id, email: 'work@example.com', plan: 'Plus', createdAt: 7 });

describe('AccountStore per engine', () => {
  it("keeps Claude's accounts at the top level and every other engine's beside them, whichever engine writes, and keeps keys it does not know", () => {
    const { home, seeded, store } = setup(['a@example.com'], null);
    const file = () => JSON.parse(readFileSync(accountsFile(home), 'utf8')) as Record<string, unknown>;
    const claude = { id: seeded[0]!.id, email: 'a@example.com', createdAt: 1000, label: 'a later CodeRay' };
    writeFileSync(accountsFile(home), JSON.stringify({ accounts: [claude], activeId: null, opencode: { accounts: [], activeId: null, later: true } }));
    const codexId = randomUUID();
    codexStore(home).add(PLUS(codexId));
    codexStore(home).setActive(codexId);
    store().setActive(seeded[0]!.id);
    expect(file()).toStrictEqual({
      accounts: [claude], activeId: seeded[0]!.id,
      opencode: { accounts: [], activeId: null, later: true },
      codex: { accounts: [PLUS(codexId)], activeId: codexId },
    });
  });

  it('gives each engine its own directory, the variables that point it there and the credentials it must not see, and System none of them', () => {
    const { home, seeded, store } = setup(['a@example.com'], 0);
    const id = seeded[0]!.id;
    expect([store().home(id), codexStore(home).home(id), store().home(null)]).toStrictEqual([
      { dir: join(home, 'claude-accounts', id), env: { CLAUDE_CONFIG_DIR: join(home, 'claude-accounts', id) }, unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], args: [] },
      { dir: join(home, 'codex-accounts', id), env: { CODEX_HOME: join(home, 'codex-accounts', id) }, unset: ['OPENAI_API_KEY', 'CODEX_API_KEY'], args: ['-c', 'cli_auth_credentials_store="file"'] },
      { dir: null, env: {}, unset: [], args: [] },
    ]);
  });

  it("names the active account for the engine's header only once the engine has an account, with its plan", () => {
    const home = tempDir('ide-accounts-home-');
    const codex = codexStore(home);
    const id = randomUUID();
    const none = codex.activeLabel();
    codex.add(PLUS(id));
    const system = codex.activeLabel();
    codex.setActive(id);
    expect([none, system, codex.activeLabel(), codex.label(id), codex.label(randomUUID())]).toStrictEqual([
      null, 'System', 'work@example.com · Plus', 'work@example.com · Plus', 'a removed account',
    ]);
  });

  it("removes an account through its own engine's sign-out and leaves the other engine's accounts alone", async () => {
    const { home, seeded, store } = setup(['a@example.com'], 0);
    const signedOut: SignedHome['env'][] = [];
    const codex = codexStore(home, (account) => signedOut.push(account.env));
    const id = randomUUID();
    codex.add(PLUS(id));
    codex.createDir(id);
    await codex.remove(id);
    expect([signedOut, existsSync(join(home, 'codex-accounts', id)), codex.list(), store().list().accounts.map((account) => account.id)]).toStrictEqual([
      [{ CODEX_HOME: join(home, 'codex-accounts', id) }], false, { accounts: [], activeId: null }, [seeded[0]!.id],
    ]);
  });

  it('replaces accounts.json whole, so another core reading it during a write reads the old file entire, and leaves nothing beside it', () => {
    const { home, seeded, store } = setup(['a@example.com'], null);
    const before = readFileSync(accountsFile(home), 'utf8');
    const reader = openSync(accountsFile(home), 'r');
    let seen: string;
    try {
      store().setActive(seeded[0]!.id);
      codexStore(home).add(PLUS(randomUUID()));
      seen = readFileSync(reader, 'utf8');
    } finally {
      closeSync(reader);
    }
    expect([seen, readdirSync(home).sort()]).toStrictEqual([before, ['accounts.json', 'claude-accounts']]);
  });

  it('never writes over an accounts.json it cannot read, and leaves nothing beside it when a write fails', () => {
    const { home, seeded, store } = setup(['a@example.com'], null);
    const path = accountsFile(home);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), codex: { accounts: [PLUS(randomUUID())], activeId: null }, later: true }));
    const before = readFileSync(path, 'utf8');
    chmodSync(path, 0o000);
    expect(store().list()).toStrictEqual({ accounts: [], activeId: null });
    expect(() => store().setActive(null)).toThrow(AccountError);
    chmodSync(path, 0o600);
    const unreadable = readFileSync(path, 'utf8');
    unlinkSync(path);
    symlinkSync(join(home, 'gone.json'), path);
    expect(() => codexStore(home).add(PLUS(randomUUID()))).toThrow(AccountError);
    const dangling = lstatSync(path).isSymbolicLink();
    unlinkSync(path);
    writeFileSync(path, before);
    symlinkSync(join(home, 'gone.tmp'), `${path}.${process.pid}.tmp`);
    expect(() => store().setActive(seeded[0]!.id)).toThrow(/symbolic link/);
    const left = readdirSync(home).sort();
    mkdirSync(`${path}.${process.pid}.tmp`);
    let blocked: unknown;
    try {
      store().setActive(seeded[0]!.id);
    } catch (error) {
      blocked = error;
    } finally {
      rmdirSync(`${path}.${process.pid}.tmp`);
    }
    chmodSync(home, 0o500);
    let denied: unknown;
    try {
      store().setActive(seeded[0]!.id);
    } catch (error) {
      denied = error;
    } finally {
      chmodSync(home, 0o700);
    }
    const failure = (error: unknown) => [(error as NodeJS.ErrnoException | undefined)?.code, (error as NodeJS.ErrnoException | undefined)?.syscall];
    expect([unreadable, dangling, readFileSync(path, 'utf8'), left, failure(blocked), failure(denied)]).toStrictEqual([
      before, true, before, ['accounts.json', 'claude-accounts'], ['EISDIR', 'open'], ['EACCES', 'open'],
    ]);
  });

  it("gives an opencode profile its four XDG homes (0700) and its own cloud credential files, all inside it, and none of the core's credentials", () => {
    const home = tempDir('ide-accounts-home-');
    const store = new AccountStore({ home, engine: 'opencode', logout: async () => {} });
    const id = randomUUID();
    const dir = store.createDir(id);
    const { env, unset } = store.home(id);
    expect([
      dir, readdirSync(dir).sort().map((name) => [name, mode(join(dir, name))]), env,
      ['OPENAI_API_KEY', 'OPENCODE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_TOKEN', 'GH_TOKEN'].filter((name) => !unset.includes(name)),
    ]).toStrictEqual([
      join(home, 'opencode-accounts', id), [['cache', 0o700], ['config', 0o700], ['data', 0o700], ['state', 0o700]],
      {
        XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'),
        AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws/credentials'), AWS_CONFIG_FILE: join(dir, 'aws/config'), CLOUDSDK_CONFIG: join(dir, 'gcloud'),
      },
      [],
    ]);
  });
});
