import type { EngineId } from '@ide/protocol';

/** The engines CodeRay keeps accounts for; opencode's profiles come with its transport. */
export type AccountEngine = Extract<EngineId, 'claude' | 'codex'>;

export const ACCOUNT_ENGINES: readonly AccountEngine[] = ['claude', 'codex'];

export const isAccountEngine = (engine: EngineId): engine is AccountEngine => (ACCOUNT_ENGINES as readonly EngineId[]).includes(engine);

/** How an engine runs under an account: its home, the variables that point it there, the credentials it must not see, and its flags. */
export interface AccountHome {
  readonly dir: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  readonly args: readonly string[];
}

export type SignedHome = AccountHome & { dir: string };

export const ACCOUNT_DIRS: Record<AccountEngine, string> = { claude: 'claude-accounts', codex: 'codex-accounts' };

/** System: the engine's own home, with the core's environment and its credentials. Frozen: every chat under System shares it. */
export const SYSTEM_HOME: AccountHome = Object.freeze({
  dir: null, env: Object.freeze<Record<string, string>>({}), unset: Object.freeze<string[]>([]), args: Object.freeze<string[]>([]),
});

// A credential in the core's environment would sign the engine in instead of the account.
export const CREDENTIAL_VARS: Record<AccountEngine, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
};

export function accountHome(engine: AccountEngine, dir: string): SignedHome {
  if (engine === 'claude') return { dir, env: { CLAUDE_CONFIG_DIR: dir }, unset: [...CREDENTIAL_VARS.claude], args: [] };
  // The file store keeps the credentials in the account's directory; the system keychain is one item for every home.
  return { dir, env: { CODEX_HOME: dir }, unset: [...CREDENTIAL_VARS.codex], args: ['-c', 'cli_auth_credentials_store="file"'] };
}
