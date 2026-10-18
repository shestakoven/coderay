import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SettingsClientMessage, SettingsServerMessage } from '@ide/protocol';
import { accountHome, opencodeLoginCommand, type SignedHome } from '../../src/accounts/account-homes';
import { AccountStore } from '../../src/accounts/account-store';
import { answerProviders, opencodeLogin, opencodeProviders, removeProviderKey, setProviderKey, type ProviderRequest } from '../../src/accounts/opencode-login';
import { fakeOpencode, opencodeRecords, requests } from '../fake-opencode/fake';
import { tempDir, waitFor } from '../helpers';

const NAME_RULE = 'A profile name is 1 to 40 characters without control characters.';

// A profile as the store makes it; the fake's record and the run directory sit outside it.
function profile(env: Record<string, string> = {}) {
  const base = tempDir('oc-profile-');
  const store = new AccountStore({ home: join(base, 'home'), engine: 'opencode', logout: async () => {} });
  const id = randomUUID();
  store.add({ id, email: 'Work', createdAt: 1 });
  const home = store.home(id) as SignedHome;
  store.createDir(id);
  const record = join(base, 'rec.jsonl');
  const runner = { command: fakeOpencode(null, record, env), runDir: join(base, 'run') };
  return { id, store, home, record, runner, records: () => opencodeRecords(record) };
}

describe('opencodeLogin', () => {
  it('names the profile from the name given, at once, and refuses an empty, control- or format-character name', () => {
    const updates: unknown[] = [];
    const run = opencodeLogin().start(profile().home, 'profile', '  Work  ', (update) => updates.push(update));
    expect([updates, typeof run.cancel]).toEqual([[{ kind: 'done', email: 'Work', plan: null }], 'function']);
    for (const name of ['a\u0007b', 'a\u202eb', '   ', 'x'.repeat(41), null]) expect(() => opencodeLogin().start(profile().home, 'profile', name, () => {})).toThrow(NAME_RULE);
  });

  it("builds the terminal command for an OAuth provider with the profile's XDG directories shell-quoted", () => {
    expect(opencodeLoginCommand(accountHome('opencode', "/h/it's"))).toBe(
      "XDG_DATA_HOME='/h/it'\\''s/data' XDG_CONFIG_HOME='/h/it'\\''s/config' XDG_STATE_HOME='/h/it'\\''s/state' XDG_CACHE_HOME='/h/it'\\''s/cache' opencode auth login",
    );
  });
});

describe('provider keys', () => {
  it("lists the providers with their methods under the profile's XDG home, sets a key through PUT /auth, removes it, and leaves only the XDG homes behind", async () => {
    const { home, runner, record, records } = profile({ OPENAI_API_KEY: 'sk-of-the-core', GITHUB_TOKEN: 'gh-of-the-core' });
    const view = (list: Awaited<ReturnType<typeof opencodeProviders>>) => list.map((p) => [p.name, p.connected, p.methods, p.env]);
    const before = view(await opencodeProviders(runner, home));
    const set = view(await setProviderKey(runner, home, 'openai', 'sk-test'));
    const removed = view(await removeProviderKey(runner, home, 'openai'));
    // A server slow to stop keeps its pid file in the run directory meanwhile: a core killed then leaves the reaper an orphan to find.
    const pidFile = () => (existsSync(runner.runDir) ? readdirSync(runner.runDir).find((name) => /^opencode-\d+\.pid\.json$/.test(name)) : undefined);
    const slow = opencodeProviders({ ...runner, command: fakeOpencode(null, record, { FAKE_OPENCODE_DISPOSE: 'hang' }) }, home);
    await waitFor(pidFile, 'the pid file of a running server');
    await slow;
    expect([
      before, set[1], removed[1], requests(records(), 'PUT', '/auth/openai').map((r) => r.body), requests(records(), 'DELETE', '/auth/openai').length,
      [...new Set(records().flatMap((r) => (r.pid === undefined ? [] : [r.xdg?.XDG_CONFIG_HOME])))], records().flatMap((r) => r.credentials ?? []),
      readdirSync(home.dir).sort(), readFileSync(join(home.dir, 'data/opencode/auth.json'), 'utf8'), readdirSync(runner.runDir),
    ]).toEqual([
      [['OpenCode Zen', true, ['api'], ['OPENCODE_API_KEY']], ['OpenAI', false, ['api'], ['OPENAI_API_KEY']], ['Anthropic', false, ['oauth', 'api'], ['ANTHROPIC_API_KEY']]],
      ['OpenAI', true, ['api'], ['OPENAI_API_KEY']], ['OpenAI', false, ['api'], ['OPENAI_API_KEY']], [{ type: 'api', key: 'sk-test' }], 1,
      [join(home.dir, 'config')], [], ['cache', 'config', 'data', 'state'], '{}', ['opencode-shell'],
    ]);
  });

  it('takes back a key opencode does not list afterwards, and never puts a key in an error', async () => {
    const { home, runner, records } = profile();
    const failure = (error: Error) => error.message;
    const unlisted = await setProviderKey(runner, home, 'nosuch', 'sk-very-secret').then(() => '', failure);
    const failing = profile({ FAKE_OPENCODE_AUTH: 'fail' });
    const echoed = await setProviderKey(failing.runner, failing.home, 'openai', 'sk-very\\secret').then(() => '', failure);
    expect([unlisted, requests(records(), 'DELETE', '/auth/nosuch').length, echoed.startsWith('opencode answered 400 to PUT /auth/openai'), /very|secret/.test(echoed)]).toEqual([
      'opencode did not list nosuch as connected after the key was set.', 1, true, false,
    ]);
  });
});

describe('answerProviders', () => {
  const ask = async (request: ProviderRequest, setup: { opencode?: boolean; active?: boolean; env?: Record<string, string> } = {}) => {
    const p = profile(setup.env);
    if (setup.active) p.store.setActive(p.id);
    let refreshes = 0;
    const replies: SettingsServerMessage[] = [];
    const profiles = setup.opencode === false ? null : { ...p.runner, store: p.store, refreshEngines: () => { refreshes += 1; } };
    await answerProviders({ ...request, id: request.id === 'PROFILE' ? p.id : request.id } as ProviderRequest, profiles, (message) => replies.push(message));
    return { replies, refreshes, started: p.records().filter((r) => r.pid !== undefined).length, home: p.home };
  };
  const result = (error: string | null): SettingsServerMessage => ({ type: 'settings.result', requestId: 'r', error });
  const other = randomUUID();

  it.each<[string, SettingsClientMessage, { opencode?: boolean }, SettingsServerMessage]>([
    ['a key with a space', { type: 'account.provider.set', requestId: 'r', id: 'PROFILE', providerID: 'openai', apiKey: 'has space' }, {}, result('A key is 1 to 512 characters without spaces.')],
    ['a key for an id that is no profile', { type: 'account.provider.set', requestId: 'r', id: other, providerID: 'openai', apiKey: 'sk-x' }, {}, result('That profile no longer exists.')],
    ['a removal for an id that is no profile', { type: 'account.provider.remove', requestId: 'r', id: other, providerID: 'openai' }, {}, result('That profile no longer exists.')],
    ['the providers of an id that is no profile', { type: 'account.providers', requestId: 'r', id: other }, {},
      { type: 'settings.providers', requestId: 'r', id: other, providers: [], loginCommand: '', error: 'That profile no longer exists.' }],
    ['a key without opencode', { type: 'account.provider.set', requestId: 'r', id: 'PROFILE', providerID: 'openai', apiKey: 'sk-x' }, { opencode: false }, result('opencode is not available in this CodeRay.')],
    ['a removal without opencode', { type: 'account.provider.remove', requestId: 'r', id: 'PROFILE', providerID: 'openai' }, { opencode: false }, result('opencode is not available in this CodeRay.')],
    ['the providers without opencode', { type: 'account.providers', requestId: 'r', id: other }, { opencode: false },
      { type: 'settings.providers', requestId: 'r', id: other, providers: [], loginCommand: '', error: 'opencode is not available in this CodeRay.' }],
  ])('refuses %s without starting opencode', async (_, request, setup, answer) => {
    const { replies, refreshes, started } = await ask(request as ProviderRequest, setup);
    expect([replies, refreshes, started]).toEqual([[answer], 0, 0]);
  });

  it("answers a change with the profile's new list, then its result, and refreshes the engines only for the active profile", async () => {
    const set = await ask({ type: 'account.provider.set', requestId: 'r', id: 'PROFILE', providerID: 'openai', apiKey: 'sk-test' }, { active: true });
    const removed = await ask({ type: 'account.provider.remove', requestId: 'r', id: 'PROFILE', providerID: 'openai' });
    const listed = await ask({ type: 'account.providers', requestId: 'r', id: 'PROFILE' });
    const broken = await ask({ type: 'account.providers', requestId: 'r', id: 'PROFILE' }, { env: { FAKE_OPENCODE_HEALTH: 'down' } });
    const shape =(replies: SettingsServerMessage[]) => replies.map((m) => (m.type === 'settings.providers' ? [m.type, m.providers.find((p) => p.id === 'openai')?.connected, m.loginCommand, m.error] : [m.type, 'error' in m && m.error]));
    expect([shape(set.replies), set.refreshes, shape(removed.replies), removed.refreshes, shape(listed.replies), (listed.replies[0] as { id: string }).id, shape(broken.replies)]).toEqual([
      [['settings.providers', true, opencodeLoginCommand(set.home), null], ['settings.result', null]], 1,
      [['settings.providers', false, opencodeLoginCommand(removed.home), null], ['settings.result', null]], 0,
      [['settings.providers', false, opencodeLoginCommand(listed.home), null]], listed.home.dir.split('/').at(-1),
      [['settings.providers', undefined, opencodeLoginCommand(broken.home), "opencode's health check failed (503)"]],
    ]);
  });
});
