import {
  API_KEY_PATTERN, API_KEY_RULE, ENGINE_NAMES, LOGIN_METHODS, PROFILE_NAME_PATTERN, PROFILE_NAME_RULE,
  type AccountsView, type EngineAccountsView, type EngineId, type LoginMethod, type ProviderView,
} from '@ide/protocol';
import type { BlockId } from './categories';

/** The Settings block of each engine's accounts. */
export const ACCOUNT_BLOCKS: Partial<Record<BlockId, EngineId>> = { accounts: 'claude', 'accounts-codex': 'codex', 'accounts-opencode': 'opencode' };

/** Each engine's accounts; a core from before engine-scoped accounts sends Claude's alone, at the top level. */
export function engineAccounts(view: AccountsView): EngineAccountsView[] {
  if (Array.isArray(view.engines)) return view.engines;
  return [{ engine: 'claude', accounts: view.accounts ?? [], activeId: view.activeId ?? null }];
}

export function methodLabel(engine: EngineId, method: LoginMethod): string {
  if (method === 'profile') return 'Add profile';
  if (LOGIN_METHODS[engine].length === 1) return 'Add account';
  if (method === 'browser') return engine === 'codex' ? 'Sign in with ChatGPT' : `Sign in to ${ENGINE_NAMES[engine]}`;
  return method === 'device-code' ? 'Use a device code' : 'Use an API key';
}

export const SYSTEM_NOTE: Record<EngineId, string> = {
  claude: "claude's default sign-in",
  codex: "codex's own sign-in (codex login)",
  opencode: "opencode's own providers and keys",
};

/** Why the core would refuse this profile name, or null when it takes it. */
export const profileNameProblem = (name: string): string | null => (PROFILE_NAME_PATTERN.test(name.trim()) ? null : PROFILE_NAME_RULE);

/** Why the core would refuse this provider key, or null when it takes it. */
export const providerKeyProblem = (key: string): string | null => (API_KEY_PATTERN.test(key) ? null : API_KEY_RULE);

/** A profile's providers as the last `settings.providers` gave them; `loading` while a request for them runs. */
export interface ProviderList {
  loading: boolean;
  providers: ProviderView[];
  loginCommand: string;
  error: string | null;
}
