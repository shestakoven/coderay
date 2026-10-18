import { describe, expect, it } from 'vitest';
import { opencodeMcp } from '../../src/agent/opencode/mcp';

describe('opencodeMcp', () => {
  it("renders an http server as remote with its url and headers expanded, a stdio server as local with its command, and gives idecore a day's timeout and the keep-alive", () => {
    const { config, names } = opencodeMcp({
      idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp?chat=1', headers: { Authorization: 'Bearer ${TOKEN}' } },
      files: { type: 'stdio', command: 'node', args: ['srv.js'], env: { A: '1' }, timeout: 7_000 },
      api: { type: 'http', url: 'https://${API_HOST}/mcp?v=2', timeout: 5_000 },
    }, { TOKEN: 'secret', API_HOST: 'x' });
    expect([config, names]).toEqual([{
      idecore: { type: 'remote', url: 'http://127.0.0.1:9/mcp?chat=1&keepAlive=1', headers: { Authorization: 'Bearer secret' }, enabled: true, timeout: 86_400_000 },
      files: { type: 'local', command: ['node', 'srv.js'], environment: { A: '1' }, enabled: true, timeout: 7_000 },
      api: { type: 'remote', url: 'https://x/mcp?v=2', headers: {}, enabled: true, timeout: 5_000 },
    }, ['idecore', 'files', 'api']]);
  });

  it.each([
    ['a name opencode cannot render', 'bad name'],
    ["a name that would match idecore's allow rule", 'idecore_extra'],
    ["the same name in capitals, which opencode on Windows matches without case", 'IDECORE_extra'],
  ])('refuses %s', (_name, name) => {
    expect(() => opencodeMcp({ [name]: { type: 'http', url: 'http://x' } })).toThrow(`MCP server name "${name}" cannot be rendered for opencode`);
  });
});
