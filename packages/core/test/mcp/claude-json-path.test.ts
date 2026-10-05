import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeJsonPath } from '../../src/mcp/claude-code';
import { McpRegistry } from '../../src/mcp/registry';
import { withEnv } from '../accounts/fake-cli';
import { tempDir } from '../helpers';

const http = { type: 'http', url: 'https://docs.example/mcp' };

function claudeJson(dir: string, servers: string[]): string {
  const path = join(dir, '.claude.json');
  writeFileSync(path, JSON.stringify({ mcpServers: Object.fromEntries(servers.map((name) => [name, http])) }));
  return path;
}

const listed = (registry: McpRegistry): string[] => registry.view().claudeCodeServers.map((server) => server.name).sort();

describe('McpRegistry claudeJsonPath given as a function', () => {
  it('reads the file the function names at every view, so switching accounts needs no new registry', () => {
    const work = claudeJson(tempDir('ide-work-'), ['linear']);
    const personal = claudeJson(tempDir('ide-personal-'), ['figma', 'notion']);
    let active = work;
    const registry = new McpRegistry({ home: tempDir('ide-home-'), root: tempDir('ide-root-'), env: {}, claudeJsonPath: () => active });
    const before = listed(registry);
    active = personal;
    const after = listed(registry);
    active = work;
    expect([before, after, listed(registry)]).toStrictEqual([['linear'], ['figma', 'notion'], ['linear']]);
  });

  it('defaults to .claude.json in CLAUDE_CONFIG_DIR of the process when the option is absent', () => {
    const configDir = tempDir('ide-config-dir-');
    claudeJson(configDir, ['sentry']);
    withEnv('CLAUDE_CONFIG_DIR', configDir);
    const registry = new McpRegistry({ home: tempDir('ide-home-'), root: tempDir('ide-root-'), env: {} });
    expect(listed(registry)).toStrictEqual(['sentry']);
  });
});

describe('claudeJsonPath', () => {
  it('names .claude.json inside a given config dir', () => {
    withEnv('CLAUDE_CONFIG_DIR', '/elsewhere');
    expect(claudeJsonPath('/accounts/a')).toBe(join('/accounts/a', '.claude.json'));
  });

  it('names .claude.json inside CLAUDE_CONFIG_DIR when no dir is given and the variable is set', () => {
    withEnv('CLAUDE_CONFIG_DIR', '/custom/claude');
    expect(claudeJsonPath(null)).toBe(join('/custom/claude', '.claude.json'));
  });

  it('names ~/.claude.json when no dir is given and CLAUDE_CONFIG_DIR is unset', () => {
    withEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(claudeJsonPath(null)).toBe(join(homedir(), '.claude.json'));
  });
});
