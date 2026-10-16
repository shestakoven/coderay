import type { McpEntry } from '@ide/protocol';
import { expandVariables } from '../../mcp/config';
import type { JsonValue } from './protocol';

export const IDECORE_TOKEN_ENV = 'CODERAY_IDECORE_TOKEN';

// propose_plan waits for the user; Codex's own limit for a tool call is 300 s.
const IDECORE_TIMEOUT_S = 86_400;
const READ_ONLY_HINTS = 'readOnlyHints=1';
const BEARER = /^Bearer (.+)$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface CodexMcp {
  /** Thread config keys: the IDE's servers in Codex's dialect. */
  config: Record<string, JsonValue>;
  /** The secrets the config names by variable, for the app-server's environment. */
  env: Record<string, string>;
  /** The servers CodeRay defines. */
  names: string[];
}

/** The IDE's MCP list (idecore and the user's servers) as Codex thread config, with every header value kept out of it. */
export function codexMcp(servers: Record<string, McpEntry>, env: NodeJS.ProcessEnv = process.env): CodexMcp {
  const config: Record<string, JsonValue> = {};
  const secrets: Record<string, string> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) throw new Error(`MCP server name "${name}" cannot be rendered for Codex`);
    let variables = 0;
    const secret = (value: string, fixed?: string): string => {
      const variable = fixed ?? `CODERAY_MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${(variables += 1)}`;
      if (Object.hasOwn(secrets, variable)) throw new Error(`MCP server "${name}" renders to a variable another server uses`);
      secrets[variable] = value;
      return variable;
    };
    const key = (field: string): string => `mcp_servers.${name}.${field}`;
    const idecore = name === 'idecore';
    if (entry.type === 'stdio') {
      config[key('command')] = entry.command ?? '';
      if (entry.args) config[key('args')] = entry.args;
      if (entry.env) config[key('env')] = entry.env;
    } else {
      const url = expandVariables(entry.url ?? '', env);
      config[key('url')] = idecore ? `${url}${url.includes('?') ? '&' : '?'}${READ_ONLY_HINTS}` : url;
      const headers: Record<string, string> = {};
      for (const [header, raw] of Object.entries(entry.headers ?? {})) {
        const value = expandVariables(raw, env);
        const bearer = header.toLowerCase() === 'authorization' ? BEARER.exec(value) : null;
        if (!bearer) headers[header] = secret(value);
        else if (!(key('bearer_token_env_var') in config)) config[key('bearer_token_env_var')] = secret(bearer[1]!, idecore ? IDECORE_TOKEN_ENV : undefined);
      }
      if (Object.keys(headers).length > 0) config[key('env_http_headers')] = headers;
    }
    const timeout = idecore ? IDECORE_TIMEOUT_S : entry.timeout === undefined ? undefined : Math.ceil(entry.timeout / 1000);
    if (timeout !== undefined) config[key('tool_timeout_sec')] = timeout;
  }
  return { config, env: secrets, names: Object.keys(servers) };
}
