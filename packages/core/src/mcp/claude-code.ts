import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeServerView } from '@ide/protocol';
import { isRecord, parseJson } from '../json';

// claude keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set, and in the home directory otherwise.
export const claudeJsonPath = (configDir: string | null): string => join(configDir ?? (process.env.CLAUDE_CONFIG_DIR || homedir()), '.claude.json');

// The repo's .mcp.json is lstat-ed so a hostile checkout cannot redirect the read through a link; regular files only, so a FIFO cannot block it.
function readJsonFile(path: string, followLinks: boolean): unknown {
  try {
    if (!(followLinks ? statSync(path) : lstatSync(path)).isFile()) return undefined;
    return parseJson(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function transport(entry: Record<string, unknown>): ClaudeCodeServerView['type'] {
  if (entry.type === 'stdio' || entry.type === 'http' || entry.type === 'sse') return entry.type;
  return entry.type === undefined && typeof entry.command === 'string' ? 'stdio' : 'unknown';
}

export function readClaudeCodeServers({ claudeJsonPath, root }: { claudeJsonPath: string; root: string }): ClaudeCodeServerView[] {
  const config = readJsonFile(claudeJsonPath, true);
  const projects = isRecord(config) && isRecord(config.projects) ? config.projects : {};
  const local = Object.hasOwn(projects, root) ? projects[root] : undefined;
  const project = readJsonFile(join(root, '.mcp.json'), false);
  // Later sources win, matching Claude Code's scope precedence: local > project > user.
  const sources: [ClaudeCodeServerView['source'], unknown][] = [
    ['user', isRecord(config) ? config.mcpServers : undefined],
    ['project', isRecord(project) ? project.mcpServers : undefined],
    ['local', isRecord(local) ? local.mcpServers : undefined],
  ];
  const servers = new Map<string, ClaudeCodeServerView>();
  for (const [source, value] of sources) {
    if (!isRecord(value)) continue;
    for (const [name, entry] of Object.entries(value)) {
      if (isRecord(entry)) servers.set(name, { name, source, type: transport(entry) });
    }
  }
  return [...servers.values()];
}
