import { describe, expect, it } from 'vitest';
import type { McpServerStatus } from '@ide/protocol';
import { MASK, describeEntry, hasReference, levelName, liveBadge, looksSecret, serverBadge } from '../src/settings/mcp-view';

const LIVE = [undefined, 'connected', 'failed', 'pending', 'needs-auth', 'disabled'];

describe('serverBadge', () => {
  it.each([
    [undefined, { tone: 'ok', label: 'Ready' }],
    ['connected', { tone: 'ok', label: 'Connected' }],
    ['failed', { tone: 'error', label: 'Failed' }],
    ['pending', { tone: 'warn', label: 'Connecting' }],
    ['needs-auth', { tone: 'warn', label: 'Needs sign-in' }],
    ['disabled', { tone: 'muted', label: 'disabled' }],
    ['Connected', { tone: 'muted', label: 'Connected' }],
  ])('shows a ready server the session reports as %j as %j', (live, badge) => {
    expect(serverBadge('ready', live)).toEqual(badge);
  });

  it.each(LIVE.flatMap((live) => [
    ['unapproved', live, { tone: 'warn', label: 'Needs approval' }],
    ['missing-env', live, { tone: 'error', label: 'Missing variable' }],
    ['shadowed', live, { tone: 'muted', label: 'Shadowed' }],
  ] as const))('lets the %s configuration win over the session status %j', (status, live, badge) => {
    expect(serverBadge(status as McpServerStatus, live)).toEqual(badge);
  });
});

describe('liveBadge', () => {
  it('shows nothing for a server the session did not report', () => {
    expect(liveBadge(undefined)).toBeNull();
  });

  it.each([
    ['connected', { tone: 'ok', label: 'Connected' }],
    ['failed', { tone: 'error', label: 'Failed' }],
    ['pending', { tone: 'warn', label: 'Connecting' }],
    ['needs-auth', { tone: 'warn', label: 'Needs sign-in' }],
    ['something-new', { tone: 'muted', label: 'something-new' }],
  ])('shows %j as %j', (status, badge) => {
    expect(liveBadge(status)).toEqual(badge);
  });
});

describe('hasReference', () => {
  it.each(['${A}', 'Bearer ${TOKEN}', '${A:-x}', '${_A1}', 'a${B}c', '${A:-}'])('sees a variable reference in %j', (value) => {
    expect(hasReference(value)).toBe(true);
  });

  it.each(['plain', '$A', '${1A}', '${}', '', '{A}', '${A'])('sees no variable reference in %j', (value) => {
    expect(hasReference(value)).toBe(false);
  });
});

describe('looksSecret', () => {
  it.each(['MY_KEY', 'GitHubToken', 'client_secret', 'Password', 'DB_PASSWD', 'Authorization', 'Credential', 'COOKIE', 'Session-Id', 'apikey'])(
    'masks a literal value under %j',
    (name) => {
      expect(looksSecret(name, 'abc123')).toBe(true);
    },
  );

  it.each(['PATH', 'HOME', 'DEBUG', 'URL', 'X-Request-Id', 'NODE_ENV'])('shows the value under the ordinary name %j', (name) => {
    expect(looksSecret(name, 'abc123')).toBe(false);
  });

  it('shows an empty value even under a secret name', () => {
    expect(looksSecret('TOKEN', '')).toBe(false);
  });

  it.each(['${TOKEN}', 'Bearer ${TOKEN}', '${TOKEN:-dev}'])('shows %j because a reference holds no secret', (value) => {
    expect(looksSecret('Authorization', value)).toBe(false);
  });

  it('masks a value that only looks like a reference', () => {
    expect(looksSecret('TOKEN', '$TOKEN')).toBe(true);
  });

  it('masks with bullets', () => {
    expect(MASK).toMatch(/^•+$/);
  });
});

describe('describeEntry', () => {
  it('heads a stdio entry with the command and its arguments', () => {
    expect(describeEntry({ type: 'stdio', command: 'npx', args: ['-y', '@scope/server', '--port', '3000'] })).toEqual({
      transport: 'stdio', headline: 'npx -y @scope/server --port 3000', command: 'npx', args: ['-y', '@scope/server', '--port', '3000'],
      url: null, env: [], headers: [], timeout: null,
    });
  });

  it('heads a stdio entry without arguments with the bare command', () => {
    expect(describeEntry({ type: 'stdio', command: 'node' })).toMatchObject({ headline: 'node', command: 'node', args: [] });
  });

  it('heads an http entry with its URL', () => {
    expect(describeEntry({ type: 'http', url: 'https://docs.example/mcp', timeout: 5000 })).toEqual({
      transport: 'http', headline: 'https://docs.example/mcp', command: null, args: [], url: 'https://docs.example/mcp', env: [], headers: [], timeout: 5000,
    });
  });

  it('lists environment variables in their order, masking literal secrets', () => {
    const { env } = describeEntry({ type: 'stdio', command: 'x', env: { B: '2', API_KEY: 'abc', TOKEN: '${TOKEN}', A: '1' } });
    expect(env).toEqual([
      { name: 'B', value: '2', secret: false },
      { name: 'API_KEY', value: 'abc', secret: true },
      { name: 'TOKEN', value: '${TOKEN}', secret: false },
      { name: 'A', value: '1', secret: false },
    ]);
  });

  it('lists headers in their order, masking literal secrets', () => {
    const { headers } = describeEntry({ type: 'http', url: 'https://x', headers: { 'X-Trace': '1', Authorization: 'Bearer abc' } });
    expect(headers).toEqual([
      { name: 'X-Trace', value: '1', secret: false },
      { name: 'Authorization', value: 'Bearer abc', secret: true },
    ]);
  });

  it('keeps a zero timeout as a number', () => {
    expect(describeEntry({ type: 'http', url: 'https://x', timeout: 0 }).timeout).toBe(0);
  });
});

describe('levelName', () => {
  it('names both levels', () => {
    expect(levelName('ide')).toBe('All projects');
    expect(levelName('project')).toBe('This project');
  });
});
