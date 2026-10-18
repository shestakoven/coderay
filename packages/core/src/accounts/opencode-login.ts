import { API_KEY_PATTERN, PROFILE_NAME_PATTERN, type ProviderView, type SettingsClientMessage, type SettingsServerMessage } from '@ide/protocol';
import type { OpencodeClient } from '../agent/opencode/api';
import { opencodeUnder, type OpencodeCommand } from '../agent/opencode/command';
import { inlineConfig } from '../agent/opencode/config';
import { shellWrapper, withServer } from '../agent/opencode/server';
import { isRecord } from '../json';
import { opencodeLoginCommand, type SignedHome } from './account-homes';
import type { LoginFlow } from './account-login';
import { AccountError, type AccountStore } from './account-store';

const NAME_RULE = 'A profile name is 1 to 40 characters without control characters.';
const KEY_RULE = 'A key is 1 to 512 characters without spaces.';
const NO_OPENCODE = 'opencode is not available in this CodeRay.';
const NO_PROFILE = 'That profile no longer exists.';

/** An opencode profile has no sign-in: its name is all it takes, so it is done at once. Its providers get their keys afterwards. */
export function opencodeLogin(): LoginFlow {
  return {
    start(_home, _method, secret, report) {
      const name = secret?.trim() ?? '';
      if (!PROFILE_NAME_PATTERN.test(name)) throw new AccountError(NAME_RULE);
      // AccountLogin hears a report made before `start` returns once the attempt is in place.
      report({ kind: 'done', email: name, plan: null });
      return { cancel() {} };
    },
  };
}

/** The opencode the core runs, and the run directory where its short-lived servers keep their pid files and shell wrapper. */
export interface OpencodeRunner {
  command: OpencodeCommand;
  runDir: string;
}

// A short-lived server under the profile: its XDG home, none of the core's credentials, and the config and hardening of every server CodeRay starts.
function underProfile<T>(runner: OpencodeRunner, home: SignedHome, ask: (client: OpencodeClient) => Promise<T>): Promise<T> {
  const configContent = inlineConfig({ config: {}, names: [] }, [], shellWrapper(runner.runDir));
  return withServer(opencodeUnder(runner.command, home), home.dir, ask, { configContent, pidDir: runner.runDir });
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const isWay = (value: unknown): value is ProviderView['methods'][number] => value === 'api' || value === 'oauth';

// The catalog (GET /provider: {all, default, connected}, Q3), the providers that take more than a key (GET /provider/auth), and the ones the
// instance loaded (GET /config/providers), whose models CodeRay lists: connected means those models show.
async function readProviders(client: OpencodeClient): Promise<ProviderView[]> {
  const [catalog, auth, loaded] = await Promise.all([client.get('/provider'), client.get('/provider/auth'), client.get('/config/providers')]);
  if (!isRecord(catalog) || !Array.isArray(catalog.all)) throw new Error('opencode did not list its providers.');
  const connected = new Set(isRecord(loaded) && Array.isArray(loaded.providers) ? loaded.providers.flatMap((p: unknown) => (isRecord(p) && typeof p.id === 'string' ? [p.id] : [])) : []);
  return catalog.all.flatMap((provider: unknown): ProviderView[] => {
    if (!isRecord(provider) || typeof provider.id !== 'string') return [];
    const ways = isRecord(auth) && Object.hasOwn(auth, provider.id) && Array.isArray(auth[provider.id]) ? (auth[provider.id] as unknown[]) : null;
    // opencode takes a key for any provider: one it names no ways for offers just that.
    const methods = ways === null ? ['api' as const] : [...new Set(ways.flatMap((way) => (isRecord(way) && isWay(way.type) ? [way.type] : [])))];
    const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id;
    return [{ id: provider.id, name, connected: connected.has(provider.id), methods, env: strings(provider.env) }];
  });
}

// Q1: /config/providers shows a key set or removed only once the instance is loaded again.
async function reloaded(client: OpencodeClient): Promise<ProviderView[]> {
  await client.post('/instance/dispose');
  return readProviders(client);
}

const authPath = (providerID: string): string => `/auth/${encodeURIComponent(providerID)}`;

// opencode's words can quote the key back, as typed or escaped in JSON.
const withoutKey = (text: string, key: string): string => [key, JSON.stringify(key).slice(1, -1)].reduce((out, form) => out.replaceAll(form, '…'), text);

export function opencodeProviders(runner: OpencodeRunner, home: SignedHome): Promise<ProviderView[]> {
  return underProfile(runner, home, readProviders);
}

/** Stores an API key in the profile and answers its providers; a provider opencode does not list as connected afterwards loses the key again. */
export async function setProviderKey(runner: OpencodeRunner, home: SignedHome, providerID: string, apiKey: string): Promise<ProviderView[]> {
  try {
    return await underProfile(runner, home, async (client) => {
      await client.put(authPath(providerID), { type: 'api', key: apiKey });
      const providers = await reloaded(client);
      if (providers.some((provider) => provider.id === providerID && provider.connected)) return providers;
      await client.del(authPath(providerID));
      throw new Error(`opencode did not list ${providerID} as connected after the key was set.`);
    });
  } catch (error) {
    throw new AccountError(withoutKey((error as Error).message, apiKey));
  }
}

export function removeProviderKey(runner: OpencodeRunner, home: SignedHome, providerID: string): Promise<ProviderView[]> {
  return underProfile(runner, home, async (client) => {
    await client.del(authPath(providerID));
    return reloaded(client);
  });
}

export type ProviderRequest = Extract<SettingsClientMessage, { type: 'account.providers' | 'account.provider.set' | 'account.provider.remove' }>;

export interface OpencodeProfiles extends OpencodeRunner {
  store: AccountStore;
  /** Sends the engines and the models again: a key changed in the active profile changes opencode's models. */
  refreshEngines: () => void;
}

/** A profile's providers go as `settings.providers`; a key set or removed answers its `settings.result` after the profile's new list. */
export async function answerProviders(request: ProviderRequest, profiles: OpencodeProfiles | null, reply: (message: SettingsServerMessage) => void): Promise<void> {
  const { requestId, id } = request;
  const list = (providers: ProviderView[], loginCommand: string, error: string | null): void =>
    reply({ type: 'settings.providers', requestId, id, providers, loginCommand, error });
  const refuse = (error: string): void => (request.type === 'account.providers' ? list([], '', error) : reply({ type: 'settings.result', requestId, error }));
  if (profiles === null) return refuse(NO_OPENCODE);
  if (!profiles.store.list().accounts.some((account) => account.id === id)) return refuse(NO_PROFILE);
  if (request.type === 'account.provider.set' && !API_KEY_PATTERN.test(request.apiKey)) return refuse(KEY_RULE);
  const home = profiles.store.home(id) as SignedHome;
  const loginCommand = opencodeLoginCommand(home);
  if (request.type === 'account.providers') {
    try {
      list(await opencodeProviders(profiles, home), loginCommand, null);
    } catch (error) {
      list([], loginCommand, (error as Error).message);
    }
    return;
  }
  let error: string | null = null;
  try {
    list(request.type === 'account.provider.set' ? await setProviderKey(profiles, home, request.providerID, request.apiKey) : await removeProviderKey(profiles, home, request.providerID), loginCommand, null);
    if (profiles.store.activeId() === id) profiles.refreshEngines();
  } catch (failure) {
    error = (failure as Error).message;
  }
  reply({ type: 'settings.result', requestId, error });
}
