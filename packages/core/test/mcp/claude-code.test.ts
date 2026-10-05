import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeCodeServers } from '../../src/mcp/claude-code';
import { tempDir } from '../helpers';

const http = { type: 'http', url: 'https://docs.example/mcp' };
const stdio = { command: 'npx', args: ['-y', 'server'] };

function setup() {
  const home = tempDir('ide-claude-home-');
  const root = tempDir('ide-claude-root-');
  const claudeJsonPath = join(home, '.claude.json');
  const writeClaudeJson = (value: unknown) => writeFileSync(claudeJsonPath, typeof value === 'string' ? value : JSON.stringify(value));
  const writeMcpJson = (value: unknown) => writeFileSync(join(root, '.mcp.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const read = () => readClaudeCodeServers({ claudeJsonPath, root });
  const sorted = () => [...read()].sort((a, b) => a.name.localeCompare(b.name));
  return { home, root, claudeJsonPath, writeClaudeJson, writeMcpJson, read, sorted };
}

describe('readClaudeCodeServers', () => {
  it('lists the top-level mcpServers of ~/.claude.json as user servers', () => {
    const { writeClaudeJson, read } = setup();
    writeClaudeJson({ mcpServers: { linear: http } });
    expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
  });

  it('lists the mcpServers of this project in ~/.claude.json as local servers, ignoring other projects', () => {
    const { root, writeClaudeJson, read } = setup();
    writeClaudeJson({ projects: { '/some/other/project': { mcpServers: { elsewhere: http } }, [root]: { mcpServers: { figma: http } } } });
    expect(read()).toEqual([{ name: 'figma', source: 'local', type: 'http' }]);
  });

  it('lists the mcpServers of <root>/.mcp.json as project servers', () => {
    const { writeMcpJson, read } = setup();
    writeMcpJson({ mcpServers: { playwright: stdio } });
    expect(read()).toEqual([{ name: 'playwright', source: 'project', type: 'stdio' }]);
  });

  it('lists servers from all three sources together', () => {
    const { root, writeClaudeJson, writeMcpJson, sorted } = setup();
    writeClaudeJson({ mcpServers: { linear: http }, projects: { [root]: { mcpServers: { figma: http } } } });
    writeMcpJson({ mcpServers: { playwright: stdio } });
    expect(sorted()).toEqual([
      { name: 'figma', source: 'local', type: 'http' },
      { name: 'linear', source: 'user', type: 'http' },
      { name: 'playwright', source: 'project', type: 'stdio' },
    ]);
  });

  it('returns nothing when neither file exists', () => {
    const { read } = setup();
    expect(read()).toEqual([]);
  });

  describe('precedence of one name in several sources', () => {
    it('lists a name defined in all three sources once, as the local definition', () => {
      const { root, writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ mcpServers: { docs: { type: 'sse', url: 'https://u.example' } }, projects: { [root]: { mcpServers: { docs: http } } } });
      writeMcpJson({ mcpServers: { docs: stdio } });
      expect(read()).toEqual([{ name: 'docs', source: 'local', type: 'http' }]);
    });

    it('prefers the project definition over the user one', () => {
      const { writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ mcpServers: { docs: http } });
      writeMcpJson({ mcpServers: { docs: stdio } });
      expect(read()).toEqual([{ name: 'docs', source: 'project', type: 'stdio' }]);
    });

    it('prefers the local definition over the user one', () => {
      const { root, writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { docs: http }, projects: { [root]: { mcpServers: { docs: stdio } } } });
      expect(read()).toEqual([{ name: 'docs', source: 'local', type: 'stdio' }]);
    });

    it('prefers the local definition over the project one', () => {
      const { root, writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ projects: { [root]: { mcpServers: { docs: { type: 'sse', url: 'https://l.example' } } } } });
      writeMcpJson({ mcpServers: { docs: http } });
      expect(read()).toEqual([{ name: 'docs', source: 'local', type: 'sse' }]);
    });
  });

  describe('transport type', () => {
    it.each(['stdio', 'http', 'sse'])('reports an explicit type %s as given', (type) => {
      const { writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { s: { type, command: 'x', url: 'https://x.example' } } });
      expect(read()).toEqual([{ name: 's', source: 'user', type }]);
    });

    it('reports stdio for an entry without a type that has a command', () => {
      const { writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { s: stdio } });
      expect(read()).toEqual([{ name: 's', source: 'user', type: 'stdio' }]);
    });

    it('lets an explicit type win over a command', () => {
      const { writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { s: { type: 'http', url: 'https://x.example', command: 'npx' } } });
      expect(read()).toEqual([{ name: 's', source: 'user', type: 'http' }]);
    });

    it('reports unknown for a type value it does not recognise', () => {
      const { writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { s: { type: 'websocket', url: 'wss://x.example', command: 'npx' } } });
      expect(read()).toEqual([{ name: 's', source: 'user', type: 'unknown' }]);
    });
  });

  it('never returns command, args, env, url or header values from any source', () => {
    const { root, writeClaudeJson, writeMcpJson, sorted } = setup();
    const secretStdio = (tag: string) => ({
      command: `SENTINEL-command-${tag}`,
      args: [`SENTINEL-arg-${tag}`],
      env: { TOKEN: `SENTINEL-env-${tag}` },
    });
    const secretHttp = (tag: string) => ({
      type: 'http',
      url: `https://SENTINEL-url-${tag}.example/mcp`,
      headers: { Authorization: `Bearer SENTINEL-header-${tag}` },
    });
    writeClaudeJson({
      mcpServers: { userStdio: secretStdio('user'), userHttp: secretHttp('user') },
      projects: { [root]: { mcpServers: { localStdio: secretStdio('local'), localHttp: secretHttp('local') } } },
    });
    writeMcpJson({ mcpServers: { projectStdio: secretStdio('project'), projectHttp: secretHttp('project') } });
    const result = sorted();
    expect(result).toEqual([
      { name: 'localHttp', source: 'local', type: 'http' },
      { name: 'localStdio', source: 'local', type: 'stdio' },
      { name: 'projectHttp', source: 'project', type: 'http' },
      { name: 'projectStdio', source: 'project', type: 'stdio' },
      { name: 'userHttp', source: 'user', type: 'http' },
      { name: 'userStdio', source: 'user', type: 'stdio' },
    ]);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  describe('unreadable or malformed sources', () => {
    it('still lists project servers when ~/.claude.json is missing', () => {
      const { writeMcpJson, read } = setup();
      writeMcpJson({ mcpServers: { playwright: stdio } });
      expect(read()).toEqual([{ name: 'playwright', source: 'project', type: 'stdio' }]);
    });

    it('skips ~/.claude.json that is not valid JSON and still lists project servers', () => {
      const { writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson('{ "mcpServers": { "linear": ');
      writeMcpJson({ mcpServers: { playwright: stdio } });
      expect(read()).toEqual([{ name: 'playwright', source: 'project', type: 'stdio' }]);
    });

    it('skips a .mcp.json that is not valid JSON and still lists user servers', () => {
      const { writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ mcpServers: { linear: http } });
      writeMcpJson('not json');
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });

    it.each([
      ['an array', [{ command: 'npx' }]],
      ['a string', 'linear'],
    ])('skips user servers when mcpServers is %s and still lists the other sources', (_label, mcpServers) => {
      const { root, writeClaudeJson, writeMcpJson, sorted } = setup();
      writeClaudeJson({ mcpServers, projects: { [root]: { mcpServers: { figma: http } } } });
      writeMcpJson({ mcpServers: { playwright: stdio } });
      expect(sorted()).toEqual([
        { name: 'figma', source: 'local', type: 'http' },
        { name: 'playwright', source: 'project', type: 'stdio' },
      ]);
    });

    it.each([
      ['an array', [{ command: 'npx' }]],
      ['a string', 'playwright'],
    ])('skips project servers when .mcp.json mcpServers is %s and still lists user servers', (_label, mcpServers) => {
      const { writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ mcpServers: { linear: http } });
      writeMcpJson({ mcpServers });
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });

    it('skips local servers when projects is null and still lists user and project servers', () => {
      const { writeClaudeJson, writeMcpJson, sorted } = setup();
      writeClaudeJson({ mcpServers: { linear: http }, projects: null });
      writeMcpJson({ mcpServers: { playwright: stdio } });
      expect(sorted()).toEqual([
        { name: 'linear', source: 'user', type: 'http' },
        { name: 'playwright', source: 'project', type: 'stdio' },
      ]);
    });

    it('skips local servers when this project entry is not an object', () => {
      const { root, writeClaudeJson, read } = setup();
      writeClaudeJson({ mcpServers: { linear: http }, projects: { [root]: 'oops' } });
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });

    it.each([null, 'npx server', 42, ['npx']])('does not list an entry that is %j instead of an object, and keeps other sources', (entry) => {
      const { root, writeClaudeJson, writeMcpJson, read } = setup();
      writeClaudeJson({ mcpServers: { broken: entry }, projects: { [root]: { mcpServers: { figma: http } } } });
      writeMcpJson({ mcpServers: { playwright: stdio } });
      const names = read().map((server) => server.name).sort();
      expect(names).toEqual(['figma', 'playwright']);
    });

    it.each([['null', 'null'], ['an array', '[]'], ['a string', '"x"'], ['a number', '7']])(
      'skips ~/.claude.json whose top level is %s and still lists project servers',
      (_label, text) => {
        const { writeClaudeJson, writeMcpJson, read } = setup();
        writeClaudeJson(text);
        writeMcpJson({ mcpServers: { playwright: stdio } });
        expect(read()).toEqual([{ name: 'playwright', source: 'project', type: 'stdio' }]);
      },
    );

    it.each([['null', 'null'], ['an array', '[]'], ['a string', '"x"']])(
      'skips a .mcp.json whose top level is %s and still lists user servers',
      (_label, text) => {
        const { writeClaudeJson, writeMcpJson, read } = setup();
        writeClaudeJson({ mcpServers: { linear: http } });
        writeMcpJson(text);
        expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
      },
    );
  });

  describe('<root>/.mcp.json that is not a regular file', () => {
    it('does not read a .mcp.json that is a symbolic link to a valid file, and still lists user servers', () => {
      const { root, writeClaudeJson, read } = setup();
      const elsewhere = tempDir('ide-claude-elsewhere-');
      const target = join(elsewhere, 'mcp.json');
      writeFileSync(target, JSON.stringify({ mcpServers: { planted: stdio } }));
      symlinkSync(target, join(root, '.mcp.json'));
      writeClaudeJson({ mcpServers: { linear: http } });
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });

    it('does not throw on a dangling symbolic link at .mcp.json', () => {
      const { root, writeClaudeJson, read } = setup();
      symlinkSync(join(tempDir('ide-claude-elsewhere-'), 'missing.json'), join(root, '.mcp.json'));
      writeClaudeJson({ mcpServers: { linear: http } });
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });

    it('skips a .mcp.json that is a directory without throwing, and still lists user servers', () => {
      const { root, writeClaudeJson, read } = setup();
      mkdirSync(join(root, '.mcp.json'));
      writeClaudeJson({ mcpServers: { linear: http } });
      expect(read()).toEqual([{ name: 'linear', source: 'user', type: 'http' }]);
    });
  });
});
