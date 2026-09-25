import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryHash, parseEntry, prepareEntry, readMcpFile } from '../../src/mcp/config';
import { tempDir } from '../helpers';

function mcpFile(content: unknown): string {
  const path = join(tempDir('ide-mcp-'), 'mcp.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('readMcpFile', () => {
  it('reads stdio and http servers in the mcpServers format', () => {
    const path = mcpFile({ mcpServers: {
      local: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${TOKEN}' } },
      docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeout: 60000 },
    } });
    expect(readMcpFile(path)).toEqual({
      servers: new Map([
        ['local', { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${TOKEN}' } }],
        ['docs', { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeout: 60000 }],
      ]),
      problems: [],
    });
  });

  it('reports an invalid entry and keeps the valid ones', () => {
    const { servers, problems } = readMcpFile(mcpFile({ mcpServers: { broken: { type: 'sse', url: 'x' }, ok: { command: 'run' } } }));
    expect([...servers.keys()]).toEqual(['ok']);
    expect(problems).toEqual(['broken: "type" must be "stdio" or "http"']);
  });

  it('reports a file that is not valid JSON', () => {
    const path = mcpFile('{ nope');
    expect(readMcpFile(path)).toEqual({ servers: new Map(), problems: [`${path} is not valid JSON`] });
  });

  it('treats a missing file as no servers', () => {
    expect(readMcpFile(join(tempDir('ide-mcp-'), 'absent.json'))).toEqual({ servers: new Map(), problems: [] });
  });

  it('reports a server named __proto__ instead of changing the prototype of the server list', () => {
    const { servers, problems } = readMcpFile(mcpFile('{"mcpServers":{"__proto__":{"command":"x"},"ok":{"command":"run"}}}'));
    expect([[...servers.keys()], problems]).toEqual([['ok'], ['__proto__: "__proto__" cannot be a server name']]);
  });
});

describe('parseEntry', () => {
  it('rejects the reserved names ide and idecore', () => {
    expect([parseEntry('ide', { command: 'x' }), parseEntry('idecore', { command: 'x' })]).toEqual([
      'ide: "ide" is reserved by Claude Code',
      'idecore: "idecore" is reserved for the IDE\'s own server',
    ]);
  });

  it('accepts names that are also properties every object inherits', () => {
    expect([parseEntry('constructor', { command: 'x' }), parseEntry('toString', { command: 'x' })])
      .toEqual([{ type: 'stdio', command: 'x' }, { type: 'stdio', command: 'x' }]);
  });

  it('rejects names with characters other than letters, digits, "_" and "-"', () => {
    expect(parseEntry('plugin:x', { command: 'x' })).toBe('plugin:x: names may contain only letters, digits, "_" and "-" (at most 64)');
  });

  it('requires a command for stdio and an http(s) url for http', () => {
    expect([parseEntry('a', { type: 'stdio' }), parseEntry('b', { type: 'http', url: 'ftp://x' })]).toEqual([
      'a: a stdio server needs a "command"',
      'b: an http server needs an http(s) "url"',
    ]);
  });
});

describe('prepareEntry', () => {
  it('expands ${VAR} in the command, args and env of a stdio server', () => {
    const stdio = { type: 'stdio' as const, command: '${BIN}', args: ['--token', '${TOKEN}'], env: { KEY: 'k-${TOKEN}' } };
    expect(prepareEntry(stdio, { TOKEN: 't1', BIN: '/usr/bin/server' })).toEqual({
      entry: { type: 'stdio', command: '/usr/bin/server', args: ['--token', 't1'], env: { KEY: 'k-t1' } },
      missing: [],
    });
  });

  it('leaves the forms claude expands itself: ${VAR} and ${VAR:-default} in the url, ${VAR} in headers', () => {
    const http = { type: 'http' as const, url: 'https://${HOST}:${PORT:-443}/mcp', headers: { A: 'Bearer ${TOKEN}', B: '${MODE:-fast}' } };
    expect(prepareEntry(http, { TOKEN: 't1', HOST: 'docs.example' })).toEqual({
      entry: { type: 'http', url: 'https://${HOST}:${PORT:-443}/mcp', headers: { A: 'Bearer ${TOKEN}', B: 'fast' } },
      missing: [],
    });
  });

  it('uses the default of ${VAR:-default} in a stdio field when VAR is undefined or empty', () => {
    const entry = { type: 'stdio' as const, command: 'run', args: ['--port', '${PORT:-4398}', '${EMPTY:-none}'] };
    expect(prepareEntry(entry, { EMPTY: '' }).entry).toEqual({ type: 'stdio', command: 'run', args: ['--port', '4398', 'none'] });
  });

  it('lists every undefined variable without a default once, from every field', () => {
    const http = { type: 'http' as const, url: 'https://${HOST:-x}/mcp', headers: { A: '${ONE}', B: '${TWO}-${ONE}' } };
    const stdio = { type: 'stdio' as const, command: 'run', args: ['${THREE}'], env: { K: '${ONE}' } };
    expect([prepareEntry(http, {}).missing, prepareEntry(stdio, {}).missing]).toEqual([['ONE', 'TWO'], ['ONE', 'THREE']]);
  });
});

describe('entryHash', () => {
  it('does not depend on key order', () => {
    expect(entryHash('docs', { type: 'http', url: 'https://x/mcp', headers: { A: '1', B: '2' } }))
      .toBe(entryHash('docs', { headers: { B: '2', A: '1' }, url: 'https://x/mcp', type: 'http' }));
  });
});
