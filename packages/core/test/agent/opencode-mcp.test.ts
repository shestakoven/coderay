import { describe, expect, it } from 'vitest';
import { opencodeMcp } from '../../src/agent/opencode/mcp';

describe('opencodeMcp', () => {
  it("renders an http server as remote with its url and headers expanded, a stdio server as local with its command, gives idecore a day's timeout and the keep-alive, and refuses a name opencode cannot render or idecore's allow rule would match in any case", () => {
    const { config, names } = opencodeMcp({
      idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp?chat=1', headers: { Authorization: 'Bearer ${TOKEN}' } },
      files: { type: 'stdio', command: 'node', args: ['srv.js'], env: { A: '1' }, timeout: 7_000 },
      api: { type: 'http', url: 'https://${API_HOST}/mcp?v=2', timeout: 5_000 },
    }, { TOKEN: 'secret', API_HOST: 'x' });
    // opencode on Windows matches a server's tools to idecore's rule without case.
    const refused = ['bad name', 'idecore_extra', 'IDECORE_extra'].map((name) => {
      try {
        return opencodeMcp({ [name]: { type: 'http', url: 'http://x' } }) && null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect([config, names, refused]).toEqual([{
      idecore: { type: 'remote', url: 'http://127.0.0.1:9/mcp?chat=1&keepAlive=1', headers: { Authorization: 'Bearer secret' }, enabled: true, timeout: 86_400_000 },
      files: { type: 'local', command: ['node', 'srv.js'], environment: { A: '1' }, enabled: true, timeout: 7_000 },
      api: { type: 'remote', url: 'https://x/mcp?v=2', headers: {}, enabled: true, timeout: 5_000 },
    }, ['idecore', 'files', 'api'], ['bad name', 'idecore_extra', 'IDECORE_extra'].map((name) => `MCP server name "${name}" cannot be rendered for opencode`)]);
  });
});
