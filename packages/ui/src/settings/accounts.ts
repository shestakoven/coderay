import { ENGINE_NAMES, LOGIN_METHODS, type AccountsView, type EngineAccountsView, type EngineId, type LoginMethod } from '@ide/protocol';
import type { BlockId } from './categories';

/** The Settings block of each engine's accounts. */
export const ACCOUNT_BLOCKS: Partial<Record<BlockId, EngineId>> = { accounts: 'claude', 'accounts-codex': 'codex' };

/** Each engine's accounts; a core from before engine-scoped accounts sends Claude's alone, at the top level. */
export function engineAccounts(view: AccountsView): EngineAccountsView[] {
  if (Array.isArray(view.engines)) return view.engines;
  return [{ engine: 'claude', accounts: view.accounts ?? [], activeId: view.activeId ?? null }];
}

export function methodLabel(engine: EngineId, method: LoginMethod): string {
  if (LOGIN_METHODS[engine].length === 1) return 'Add account';
  if (method === 'browser') return engine === 'codex' ? 'Sign in with ChatGPT' : `Sign in to ${ENGINE_NAMES[engine]}`;
  return method === 'device-code' ? 'Use a device code' : 'Use an API key';
}

export const SYSTEM_NOTE: Record<EngineId, string> = {
  claude: "claude's default sign-in",
  codex: "codex's own sign-in (codex login)",
  opencode: "opencode's own providers",
};
