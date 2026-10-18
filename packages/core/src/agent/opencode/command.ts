import type { AccountHome } from '../../accounts/account-homes';

export interface OpencodeCommand {
  command: string;
  /** Before the subcommand: the script a Node runs. */
  args: string[];
  env?: Record<string, string>;
  unset?: string[];
}

// A script runs with the core's Node, as a codex script does: tests and the e2e pass the fake's path.
const SCRIPT = /\.(?:js|mjs|ts)$/;

export function opencodeCommand(path: string): OpencodeCommand {
  return SCRIPT.test(path) ? { command: process.execPath, args: [path] } : { command: path, args: [] };
}

/** opencode under a profile: its XDG home, without the credentials that would connect providers the profile did not. */
export function opencodeUnder(base: OpencodeCommand, home: AccountHome): OpencodeCommand {
  return home.dir === null ? base : { ...base, env: { ...base.env, ...home.env }, unset: [...(base.unset ?? []), ...home.unset] };
}

// The opencode (Zen) provider's credential, which a profile unsets by its own list.
const ZEN_KEY = 'OPENCODE_API_KEY';

/** No `OPENCODE_*` but `extra`'s and Zen's key: an inherited one adds config, agents or servers, or changes the server's credentials. */
export function opencodeEnv(command: OpencodeCommand, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...command.env };
  for (const name of Object.keys(env)) if (name.startsWith('OPENCODE_') && name !== ZEN_KEY) delete env[name];
  for (const name of command.unset ?? []) delete env[name];
  // Last, so a home's unset list cannot remove the hardening or the password.
  Object.assign(env, extra);
  return env;
}
