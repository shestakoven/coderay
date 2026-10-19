import type { McpEntry } from '@ide/protocol';
import { expandVariables } from '../../mcp/config';

// propose_plan blocks until the user answers.
const IDECORE_TIMEOUT_MS = 86_400_000;
const KEEP_ALIVE = 'keepAlive=1';
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// opencode names a server's tools `<server>_<tool>`, and idecore's rule allows `idecore_*` (case-blind on Windows).
const IDECORE_TOOLS = /^idecore_/i;

export interface OpencodeMcp {
  /** `mcp` of the inline config. */
  config: Record<string, unknown>;
  /** The servers CodeRay defines. */
  names: string[];
}

/** The IDE's MCP list in opencode's dialect: remote servers with their headers, local ones with their command, idecore with a day's timeout and the keep-alive query. */
export function opencodeMcp(servers: Record<string, McpEntry>, env: NodeJS.ProcessEnv = process.env): OpencodeMcp {
  const config: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name) || IDECORE_TOOLS.test(name)) throw new Error(`MCP server name "${name}" cannot be rendered for opencode`);
    const idecore = name === 'idecore';
    const timeout = idecore ? IDECORE_TIMEOUT_MS : entry.timeout;
    if (entry.type === 'stdio') {
      config[name] = { type: 'local', command: [entry.command ?? '', ...(entry.args ?? [])], ...(entry.env ? { environment: entry.env } : {}), enabled: true, ...(timeout === undefined ? {} : { timeout }) };
    } else {
      const url = expandVariables(entry.url ?? '', env);
      const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([header, value]) => [header, expandVariables(value, env)]));
      config[name] = { type: 'remote', url: idecore ? `${url}${url.includes('?') ? '&' : '?'}${KEEP_ALIVE}` : url, headers, enabled: true, ...(timeout === undefined ? {} : { timeout }) };
    }
  }
  return { config, names: Object.keys(servers) };
}
