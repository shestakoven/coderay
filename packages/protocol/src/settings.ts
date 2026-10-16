import { type EngineId } from './engines';

export type McpLevel = 'ide' | 'project';
export type McpTransport = 'stdio' | 'http';

export interface McpEntry {
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export type McpServerStatus = 'ready' | 'unapproved' | 'missing-env' | 'shadowed';

export interface McpServerView {
  name: string;
  level: McpLevel;
  entry: McpEntry;
  entryHash: string;
  status: McpServerStatus;
  reason: string | null;
}

export interface FileHashes {
  ideServers: string;
  trust: string;
}

export interface ClaudeCodeServerView {
  name: string;
  source: 'user' | 'local' | 'project';
  type: 'stdio' | 'http' | 'sse' | 'unknown';
}

export interface McpSettingsView {
  servers: McpServerView[];
  claudeCodeServers: ClaudeCodeServerView[];
  problems: string[];
  fileHashes: FileHashes;
  externalEdits: { ideServers: boolean; trust: boolean; trustApproves: string[] };
}

export type ControlMode = 'A' | 'B' | 'C';

export interface Policy {
  mode: ControlMode;
  guarded: string[];
  harness: string[];
  outsideAllowed: string[];
  autoApproveMaxFiles: number;
}

export type PolicyLevel = 'ide' | 'project';

export interface PolicyHashes {
  ide: string;
  project: string;
}

export interface PolicyView {
  ide: Policy;
  project: Partial<Policy>;
  effective: Policy;
  hashes: PolicyHashes;
  externalEdits: { ide: boolean; project: boolean };
  edited: { ide: string | null; project: string | null };
  problems: string[];
}

export interface AccountView {
  id: string;
  /** The account's name: its e-mail, or "API key". */
  email: string;
  /** The plan the engine reports, such as "Plus"; absent when it reports none. */
  plan?: string;
  createdAt: number;
}

export type LoginMethod = 'browser' | 'device-code' | 'api-key';

/** The ways each engine signs an account in, in the order they are offered. */
export const LOGIN_METHODS: Record<EngineId, readonly LoginMethod[]> = {
  claude: ['browser'],
  codex: ['browser', 'device-code', 'api-key'],
  opencode: [],
};

/** An API key CodeRay accepts: 1–512 printable ASCII characters, no spaces. The core and the sign-in form both check it. */
export const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

export type AccountLoginState = 'idle' | 'waiting' | 'checking' | 'error';

export interface AccountLoginView {
  state: AccountLoginState;
  /** The engine whose sign-in runs or last failed; null while idle. */
  engine: EngineId | null;
  method: LoginMethod | null;
  url: string | null;
  /** The one-time code a device-code sign-in asks the user to enter. */
  userCode: string | null;
  error: string | null;
}

export interface EngineAccountsView {
  engine: EngineId;
  accounts: AccountView[];
  activeId: string | null;
}

export interface AccountsView {
  /** Claude's accounts and active id again, for a window from before engine-scoped accounts; this UI reads `engines`. */
  accounts?: AccountView[];
  activeId?: string | null;
  /** One entry per engine the core runs, in the registry's order. */
  engines: EngineAccountsView[];
  login: AccountLoginView;
}

export interface SettingsView extends McpSettingsView {
  policy: PolicyView;
  accounts: AccountsView;
}

export type SettingsServerMessage =
  | { type: 'settings.snapshot'; settings: SettingsView }
  | { type: 'settings.result'; requestId: string; error: string | null };

export type SettingsClientMessage =
  | { type: 'settings.get' }
  | { type: 'mcp.save'; requestId: string; level: McpLevel; name: string; entry: McpEntry; previousName: string | null }
  | { type: 'mcp.remove'; requestId: string; level: McpLevel; name: string }
  | { type: 'mcp.approve'; requestId: string; name: string; entryHash: string }
  | { type: 'mcp.confirm-external-edits'; requestId: string; fileHashes: FileHashes }
  | { type: 'policy.save'; requestId: string; level: PolicyLevel; policy: Partial<Policy> }
  | { type: 'policy.confirm-external-edits'; requestId: string; hashes: PolicyHashes }
  // Without `engine` a request is Claude's, as a window from before engine-scoped accounts sends it.
  | { type: 'account.login.start'; requestId: string; engine?: EngineId; method?: LoginMethod; apiKey?: string }
  | { type: 'account.login.code'; requestId: string; code: string }
  | { type: 'account.login.cancel'; requestId: string }
  | { type: 'account.select'; requestId: string; engine?: EngineId; id: string | null }
  | { type: 'account.remove'; requestId: string; engine?: EngineId; id: string };
