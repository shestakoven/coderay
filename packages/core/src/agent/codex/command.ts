import type { AccountHome } from '../../accounts/account-homes';

export interface CodexCommand {
  command: string;
  /** Before the subcommand: the script a Node runs. */
  args: string[];
  /** After `app-server`: an account's flags. */
  flags?: string[];
  env?: Record<string, string>;
  unset?: string[];
}

// A script runs with the core's Node, as the agent SDK runs a claude script: tests and the e2e pass the fake's path.
const SCRIPT = /\.(?:js|mjs|ts)$/;

export function codexCommand(path: string): CodexCommand {
  return SCRIPT.test(path) ? { command: process.execPath, args: [path] } : { command: path, args: [] };
}

/** codex under an account: its home and file credential store, without the keys that would sign it in instead. */
export function codexUnder(base: CodexCommand, home: AccountHome): CodexCommand {
  if (home.dir === null) return base;
  return { ...base, flags: [...(base.flags ?? []), ...home.args], env: { ...base.env, ...home.env }, unset: [...(base.unset ?? []), ...home.unset] };
}

export function codexEnv(command: CodexCommand, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...command.env, ...extra };
  for (const name of command.unset ?? []) delete env[name];
  return env;
}
