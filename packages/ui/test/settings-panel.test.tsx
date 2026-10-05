import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { McpLevel, McpServerState, McpServerView, Policy, SettingsView } from '@ide/protocol';
import { SettingsPanel } from '../src/settings/SettingsPanel';

interface Element {
  tag: string;
  children: (Element | string)[];
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const HEADING = 'From Claude Code';
const BADGES = ['user', 'local', 'project', 'plugin'];
const CONTROLS = ['button', 'input', 'select', 'textarea'];

const decode = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function parse(html: string): Element {
  const root: Element = { tag: '#root', children: [] };
  const stack = [root];
  for (const [, closing, tag, selfClosing, text] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (text !== undefined) top.children.push(decode(text));
    else if (closing) stack.pop();
    else {
      const element: Element = { tag: tag!.toLowerCase(), children: [] };
      top.children.push(element);
      if (!selfClosing && !VOID_TAGS.has(element.tag)) stack.push(element);
    }
  }
  return root;
}

const textOf = (node: Element | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(' '));
const tagsOf = (node: Element): string[] => node.children.flatMap((child) => (typeof child === 'string' ? [] : [child.tag, ...tagsOf(child)]));
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`).test(text);

function pathTo(node: Element, match: (element: Element) => boolean): Element[] | null {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const below = pathTo(child, match);
    if (below) return [node, ...below];
  }
  return match(node) ? [node] : null;
}

function claudeSection(html: string, names: string[]): Element {
  const path = pathTo(parse(html), (element) => element.children.some((child) => typeof child === 'string' && child.includes(HEADING)));
  if (!path) throw new Error(`no "${HEADING}" heading in the panel`);
  const section = [...path].reverse().find((element) => names.every((name) => hasWord(textOf(element), name)));
  if (!section) throw new Error(`the "${HEADING}" section does not list ${names.join(', ')}`);
  expect(textOf(section)).not.toContain('IDE level — every project');
  return section;
}

function rowsNamed(node: Element, name: string, names: string[]): Element[] {
  return node.children.flatMap((child) => {
    if (typeof child === 'string' || !hasWord(textOf(child), name)) return [];
    return names.some((other) => other !== name && hasWord(textOf(child), other)) ? rowsNamed(child, name, names) : [child];
  });
}

function rowOf(html: string, name: string, names: string[]): Element {
  const rows = rowsNamed(claudeSection(html, names), name, names);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const policy: Policy = { mode: 'B', guarded: [], harness: [], outsideAllowed: [], autoApproveMaxFiles: 3 };

const ideServer = (name: string, level: McpLevel): McpServerView => ({
  name, level, entry: { type: 'http', url: `https://${name}.example/mcp` }, entryHash: `hash-${name}`, status: 'ready', reason: null,
});

const settingsWith = (claudeCodeServers: SettingsView['claudeCodeServers']): SettingsView => ({
  servers: [ideServer('docs', 'ide'), ideServer('notes', 'project')],
  problems: [],
  fileHashes: { ideServers: 'a', trust: 'b' },
  externalEdits: { ideServers: false, trust: false, trustApproves: [] },
  policy: {
    ide: policy, project: {}, effective: policy, hashes: { ide: 'a', project: 'b' }, externalEdits: { ide: false, project: false },
    edited: { ide: null, project: null }, problems: [],
  },
  claudeCodeServers,
  accounts: { accounts: [], activeId: null, login: { state: 'idle', url: null, error: null } },
});

const render = (settings: SettingsView | null, sessionServers: McpServerState[] = []): string =>
  renderToStaticMarkup(
    <SettingsPanel settings={settings} lastResult={null} sessionServers={sessionServers} send={() => true} onClose={() => undefined} />,
  );

const claude = settingsWith([
  { name: 'linear', source: 'user', type: 'http' },
  { name: 'figma', source: 'local', type: 'sse' },
  { name: 'playwright', source: 'project', type: 'stdio' },
  { name: 'legacy', source: 'user', type: 'unknown' },
]);
const claudeNames = ['linear', 'figma', 'playwright', 'legacy'];
const claudeSession: McpServerState[] = [
  { name: 'linear', status: 'connected' },
  { name: 'figma', status: 'failed' },
  { name: 'playwright', status: 'pending' },
];

describe('Settings: servers from Claude Code', () => {
  it('places the section below the IDE server list', () => {
    const html = render(claude, claudeSession);
    expect(html.indexOf(HEADING)).toBeGreaterThan(html.indexOf('Project level — committed (.ide/mcp.json)'));
    expect(html.indexOf(HEADING)).toBeGreaterThan(html.lastIndexOf('Add server'));
  });

  it.each([
    ['linear', 'user'],
    ['figma', 'local'],
    ['playwright', 'project'],
    ['legacy', 'user'],
  ])('labels %s with the single source badge %s', (name, badge) => {
    const text = textOf(rowOf(render(claude, claudeSession), name, claudeNames));
    expect(BADGES.filter((word) => hasWord(text, word))).toEqual([badge]);
  });

  it.each([
    ['linear', 'http'],
    ['figma', 'sse'],
    ['playwright', 'stdio'],
    ['legacy', 'unknown'],
  ])('shows the transport of %s as %s', (name, transport) => {
    const text = textOf(rowOf(render(claude, claudeSession), name, claudeNames));
    expect(['stdio', 'http', 'sse', 'unknown'].filter((word) => hasWord(text, word))).toEqual([transport]);
  });

  it.each([
    ['linear', 'connected'],
    ['figma', 'failed'],
    ['playwright', 'pending'],
  ])('shows the live session status of %s as %s', (name, status) => {
    const text = textOf(rowOf(render(claude, claudeSession), name, claudeNames));
    expect(['connected', 'failed', 'pending'].filter((word) => hasWord(text, word))).toEqual([status]);
    expect(text).not.toContain('—');
  });

  it('shows — as the status of a server the session did not report', () => {
    const text = textOf(rowOf(render(claude, claudeSession), 'legacy', claudeNames));
    expect(text).toContain('—');
    expect(['connected', 'failed', 'pending'].filter((word) => hasWord(text, word))).toEqual([]);
  });

  it('offers no edit, remove or approve controls on its rows', () => {
    const html = render(claude, claudeSession);
    for (const name of claudeNames) {
      expect(tagsOf(rowOf(html, name, claudeNames)).filter((tag) => CONTROLS.includes(tag))).toEqual([]);
    }
  });

  it('adds a plugin row for a session server that neither the IDE registry nor Claude Code config lists', () => {
    const view = settingsWith([{ name: 'linear', source: 'user', type: 'http' }]);
    const html = render(view, [{ name: 'linear', status: 'connected' }, { name: 'context7', status: 'failed' }]);
    const text = textOf(rowOf(html, 'context7', ['linear', 'context7']));
    expect(BADGES.filter((word) => hasWord(text, word))).toEqual(['plugin']);
    expect(hasWord(text, 'failed')).toBe(true);
    expect(tagsOf(rowOf(html, 'context7', ['linear', 'context7'])).filter((tag) => CONTROLS.includes(tag))).toEqual([]);
  });

  it('keeps a Claude Code server reported by the session as one row with its own source, not a plugin row', () => {
    const view = settingsWith([{ name: 'linear', source: 'user', type: 'http' }]);
    const html = render(view, [{ name: 'linear', status: 'connected' }, { name: 'context7', status: 'failed' }]);
    const text = textOf(rowOf(html, 'linear', ['linear', 'context7']));
    expect(BADGES.filter((word) => hasWord(text, word))).toEqual(['user']);
  });

  it('does not list idecore or servers of the IDE registry that the session reports', () => {
    const view = settingsWith([]);
    const html = render(view, [
      { name: 'idecore', status: 'connected' },
      { name: 'docs', status: 'connected' },
      { name: 'notes', status: 'connected' },
      { name: 'context7', status: 'connected' },
    ]);
    const text = textOf(claudeSection(html, ['context7']));
    expect(['idecore', 'docs', 'notes'].filter((name) => hasWord(text, name))).toEqual([]);
  });

  it('shows the section with only plugin rows when Claude Code config lists nothing', () => {
    const html = render(settingsWith([]), [{ name: 'context7', status: 'connected' }]);
    const text = textOf(rowOf(html, 'context7', ['context7']));
    expect(BADGES.filter((word) => hasWord(text, word))).toEqual(['plugin']);
  });

  it('leaves the section out when there is nothing to show', () => {
    const html = render(settingsWith([]), [
      { name: 'idecore', status: 'connected' },
      { name: 'docs', status: 'connected' },
      { name: 'notes', status: 'failed' },
    ]);
    expect(html).not.toContain(HEADING);
  });

  it('shows no plugin rows before settings have loaded', () => {
    const html = render(null, [{ name: 'context7', status: 'connected' }, { name: 'idecore', status: 'connected' }]);
    expect(html).not.toContain(HEADING);
    expect(html).not.toContain('context7');
  });
});
