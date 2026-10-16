import { describe, expect, it } from 'vitest';
import { codexMcp } from '../../src/agent/codex/mcp';

describe('codexMcp', () => {
  it("renders idecore with its token in a variable, read-only hints and a day's timeout, an http server's headers from variables, and a stdio server as given", () => {
    const rendered = codexMcp({
      docs: { type: 'http', url: 'https://mcp.example.test/${REGION:-eu}/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'core', authorization: 'Bearer second' }, timeout: 90_400 },
      git: { type: 'stdio', command: 'git-mcp', args: ['--repo', '.'], env: { GIT_TOKEN: 'from-env' } },
      idecore: { type: 'http', url: 'http://127.0.0.1:4319/mcp', headers: { Authorization: 'Bearer core-secret' }, timeout: 3_600_000 },
    }, { DOCS_TOKEN: 'docs-secret' });
    expect(rendered).toEqual({
      config: {
        'mcp_servers.docs.url': 'https://mcp.example.test/eu/mcp',
        'mcp_servers.docs.bearer_token_env_var': 'CODERAY_MCP_DOCS_1',
        'mcp_servers.docs.env_http_headers': { 'X-Team': 'CODERAY_MCP_DOCS_2' },
        'mcp_servers.docs.tool_timeout_sec': 91,
        'mcp_servers.git.command': 'git-mcp',
        'mcp_servers.git.args': ['--repo', '.'],
        'mcp_servers.git.env': { GIT_TOKEN: 'from-env' },
        'mcp_servers.idecore.url': 'http://127.0.0.1:4319/mcp?readOnlyHints=1',
        'mcp_servers.idecore.bearer_token_env_var': 'CODERAY_IDECORE_TOKEN',
        'mcp_servers.idecore.tool_timeout_sec': 86_400,
      },
      env: { CODERAY_MCP_DOCS_1: 'docs-secret', CODERAY_MCP_DOCS_2: 'core', CODERAY_IDECORE_TOKEN: 'core-secret' },
      names: ['docs', 'git', 'idecore'],
    });
  });
});
