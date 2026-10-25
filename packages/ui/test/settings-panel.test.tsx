import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { McpLevel, McpServerState, McpServerView, Policy, SettingsView } from '@ide/protocol';
import { SettingsPanel } from '../src/settings/SettingsPanel';
import { CATEGORIES, blocksOf, type CategoryId } from '../src/settings/categories';

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: (Element | string)[];
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const HEADING = 'From Claude Code';
const SOURCES = ['user', 'local', 'project', 'plugin'];
const TRANSPORTS = ['stdio', 'http', 'sse', 'unknown'];
const LIVE_LABELS = ['Connected', 'Failed', 'Connecting'];
const CONTROLS = ['button', 'input', 'select', 'textarea'];

const decode = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function parse(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const [, closing, tag, rawAttrs, selfClosing, text] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (text !== undefined) top.children.push(decode(text));
    else if (closing) stack.pop();
    else {
      const attrs = Object.fromEntries([...(rawAttrs ?? '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name!.toLowerCase(), decode(value ?? '')]));
      const element: Element = { tag: tag!.toLowerCase(), attrs, children: [] };
      top.children.push(element);
      if (!selfClosing && !VOID_TAGS.has(element.tag)) stack.push(element);
    }
  }
  return root;
}

const textOf = (node: Element | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(' ')).replace(/\s+/g, ' ').trim();
const all = (node: Element, match: (element: Element) => boolean): Element[] =>
  node.children.flatMap((child) => (typeof child === 'string' ? [] : [...(match(child) ? [child] : []), ...all(child, match)]));
const hasClass = (element: Element, ...names: string[]): boolean => names.every((name) => (element.attrs.class ?? '').split(/\s+/).includes(name));
const tagsOf = (node: Element): string[] => all(node, () => true).map((element) => element.tag);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w-])${escapeRegExp(word)}(?![\\w-])`).test(text);

const settingSections = (root: Element): Element[] => all(root, (element) => element.tag === 'section' && hasClass(element, 'sw-setting'));
const titleOf = (section: Element): string => textOf(all(section, (element) => element.tag === 'h3')[0]!);
const settingTitles = (root: Element): string[] => settingSections(root).map(titleOf);

function settingSection(root: Element, title: string): Element {
  const sections = settingSections(root).filter((section) => titleOf(section) === title);
  expect(sections, `setting "${title}"`).toHaveLength(1);
  return sections[0]!;
}

const claudeRowsIn = (node: Element): Element[] => all(node, (element) => element.tag === 'li' && hasClass(element, 'sw-server', 'static'));
const rowName = (row: Element): string => textOf(all(row, (element) => element.tag === 'b')[0]!);
const rowNames = (html: string): string[] => claudeRowsIn(settingSection(parse(html), HEADING)).map(rowName);

function rowOf(html: string, name: string): Element {
  const rows = claudeRowsIn(settingSection(parse(html), HEADING)).filter((row) => rowName(row) === name);
  expect(rows, `row ${name}`).toHaveLength(1);
  return rows[0]!;
}

const sourceOf = (row: Element): string[] => all(row, (element) => element.tag === 'span' && hasClass(element, 'sw-tag')).map(textOf);
const transportOf = (row: Element): string[] => all(row, (element) => element.tag === 'span' && hasClass(element, 'muted')).map(textOf);
const liveLabelsIn = (row: Element): string[] => LIVE_LABELS.filter((label) => hasWord(textOf(row), label));

const policy: Policy = { mode: 'B', guarded: [], harness: [], outsideAllowed: [], autoApproveMaxFiles: 3 };

const ideServer = (name: string, level: McpLevel): McpServerView => ({
  name, level, entry: { type: 'http', url: `https://${name}.example/mcp` }, entryHash: `hash-${name}`, status: 'ready', reason: null,
});

const settingsWith = (claudeCodeServers: SettingsView['claudeCodeServers'], project: Partial<Policy> = {}): SettingsView => ({
  servers: [ideServer('docs', 'ide'), ideServer('notes', 'project')],
  problems: [],
  fileHashes: { ideServers: 'a', trust: 'b' },
  externalEdits: { ideServers: false, trust: false, trustApproves: [] },
  policy: {
    ide: policy, project, effective: { ...policy, ...project }, hashes: { ide: 'a', project: 'b' }, externalEdits: { ide: false, project: false },
    edited: { ide: null, project: null }, problems: [],
  },
  claudeCodeServers,
  accounts: { engines: [{ engine: 'claude', accounts: [], activeId: null }], login: { state: 'idle', engine: null, method: null, url: null, userCode: null, error: null } },
  backgroundAi: { choice: { mode: 'auto' }, onboarded: true, status: { state: 'ready', engine: 'claude', modelId: 'haiku', note: null }, options: [] },
});

const render = (settings: SettingsView | null, sessionServers: McpServerState[] = [], initialCategory: CategoryId = 'mcp'): string =>
  renderToStaticMarkup(
    <SettingsPanel settings={settings} lastResult={null} providers={{}} loadProviders={() => undefined} sessionServers={sessionServers} send={() => true} onClose={() => undefined} initialCategory={initialCategory} />,
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
  it('places the section after the servers you added, with their two groups and Add buttons', () => {
    const html = render(claude, claudeSession);
    const added = settingSection(parse(html), 'Servers you added');
    expect(all(added, (element) => element.tag === 'button' && textOf(element) === 'Add server')).toHaveLength(2);
    const groups = all(added, (element) => element.tag === 'b').map(textOf);
    expect(groups.filter((text) => text === 'This project' || text === 'All projects')).toEqual(['This project', 'All projects']);
    expect(html.indexOf(HEADING)).toBeGreaterThan(html.indexOf('Servers you added'));
    expect(html.indexOf(HEADING)).toBeGreaterThan(html.lastIndexOf('Add server'));
  });

  it('lists each Claude Code server in one row', () => {
    expect(rowNames(render(claude, claudeSession)).sort()).toEqual([...claudeNames].sort());
  });

  it.each([
    ['linear', 'user'],
    ['figma', 'local'],
    ['playwright', 'project'],
    ['legacy', 'user'],
  ])('labels %s with the single source tag %s', (name, source) => {
    const row = rowOf(render(claude, claudeSession), name);
    expect(sourceOf(row)).toEqual([source]);
    expect(SOURCES.filter((word) => hasWord(textOf(row), word))).toEqual([source]);
  });

  it.each([
    ['linear', 'http'],
    ['figma', 'sse'],
    ['playwright', 'stdio'],
    ['legacy', 'unknown'],
  ])('shows the transport of %s as %s', (name, transport) => {
    const row = rowOf(render(claude, claudeSession), name);
    expect(transportOf(row)).toEqual([transport]);
    expect(TRANSPORTS.filter((word) => hasWord(textOf(row), word))).toEqual([transport]);
  });

  it.each([
    ['linear', 'Connected'],
    ['figma', 'Failed'],
    ['playwright', 'Connecting'],
  ])('shows the session status of %s as %s', (name, label) => {
    const text = textOf(rowOf(render(claude, claudeSession), name));
    expect(LIVE_LABELS.filter((candidate) => hasWord(text, candidate))).toEqual([label]);
    expect(text).not.toContain('—');
  });

  it('shows — as the status of a server the session did not report', () => {
    const row = rowOf(render(claude, claudeSession), 'legacy');
    expect(textOf(row)).toContain('—');
    expect(liveLabelsIn(row)).toEqual([]);
  });

  it('offers no edit, remove or approve controls on its rows', () => {
    const html = render(claude, claudeSession);
    for (const name of claudeNames) {
      expect(tagsOf(rowOf(html, name)).filter((tag) => CONTROLS.includes(tag))).toEqual([]);
    }
  });

  it('adds a plugin row for a session server that neither CodeRay registry nor Claude Code config lists', () => {
    const view = settingsWith([{ name: 'linear', source: 'user', type: 'http' }]);
    const html = render(view, [{ name: 'linear', status: 'connected' }, { name: 'context7', status: 'failed' }]);
    const row = rowOf(html, 'context7');
    expect(sourceOf(row)).toEqual(['plugin']);
    expect(liveLabelsIn(row)).toEqual(['Failed']);
    expect(tagsOf(row).filter((tag) => CONTROLS.includes(tag))).toEqual([]);
  });

  it('keeps a Claude Code server reported by the session as one row with its own source, not a plugin row', () => {
    const view = settingsWith([{ name: 'linear', source: 'user', type: 'http' }]);
    const html = render(view, [{ name: 'linear', status: 'connected' }, { name: 'context7', status: 'failed' }]);
    expect(rowNames(html).sort()).toEqual(['context7', 'linear']);
    expect(sourceOf(rowOf(html, 'linear'))).toEqual(['user']);
  });

  it('does not list idecore or servers of CodeRay registry that the session reports', () => {
    const html = render(settingsWith([]), [
      { name: 'idecore', status: 'connected' },
      { name: 'docs', status: 'connected' },
      { name: 'notes', status: 'connected' },
      { name: 'context7', status: 'connected' },
    ]);
    expect(rowNames(html)).toEqual(['context7']);
    expect(['idecore', 'docs', 'notes'].filter((name) => hasWord(textOf(settingSection(parse(html), HEADING)), name))).toEqual([]);
  });

  it('shows the section with only plugin rows when Claude Code config lists nothing', () => {
    const html = render(settingsWith([]), [{ name: 'context7', status: 'connected' }]);
    expect(rowNames(html)).toEqual(['context7']);
    expect(sourceOf(rowOf(html, 'context7'))).toEqual(['plugin']);
  });

  it('leaves the section out when there is nothing to show', () => {
    const html = render(settingsWith([]), [
      { name: 'idecore', status: 'connected' },
      { name: 'docs', status: 'connected' },
      { name: 'notes', status: 'failed' },
    ]);
    expect(html).not.toContain(HEADING);
    expect(settingTitles(parse(html))).toEqual(['Servers you added']);
  });

  it('shows a loading skeleton and no server rows before settings have loaded', () => {
    const html = render(null, [{ name: 'context7', status: 'connected' }, { name: 'idecore', status: 'connected' }]);
    const root = parse(html);
    expect(all(root, (element) => hasClass(element, 'sw-skeleton') && element.attrs['aria-busy'] === 'true')).toHaveLength(1);
    expect(all(root, (element) => element.tag === 'li' && hasClass(element, 'sw-server'))).toEqual([]);
    expect(html).not.toContain(HEADING);
    expect(html).not.toContain('context7');
  });
});

describe('Settings workspace', () => {
  const tabs = (root: Element): Element[] => all(root, (element) => element.attrs.role === 'tab');

  it.each(CATEGORIES.map((category) => category.id))('lists the six categories in the rail with %s selected', (id) => {
    const list = tabs(parse(render(claude, claudeSession, id)));
    expect(list).toHaveLength(6);
    list.forEach((tab, index) => expect(textOf(tab)).toContain(CATEGORIES[index]!.label));
    expect(list.map((tab) => tab.attrs['aria-selected'])).toEqual(CATEGORIES.map((category) => String(category.id === id)));
  });

  it.each(CATEGORIES.map((category) => category.id))('shows only the settings of the %s category', (id) => {
    // The fixture's core runs Claude alone, so the accounts blocks of Codex and opencode stay hidden.
    expect(settingTitles(parse(render(claude, claudeSession, id)))).toEqual(blocksOf(id).filter((block) => block.id !== 'accounts-codex' && block.id !== 'accounts-opencode').map((block) => block.title));
  });

  const modeGroup = (root: Element): Element[] => {
    const groups = all(root, (element) => element.attrs.role === 'radiogroup')
      .map((group) => all(group, (element) => element.attrs.role === 'radio'))
      .filter((radios) => radios.some((radio) => textOf(radio).startsWith('Block')));
    expect(groups).toHaveLength(1);
    return groups[0]!;
  };

  it.each([
    [{}, 'Ask me'],
    [{ mode: 'A' }, 'Block'],
    [{ mode: 'C' }, 'Allow and flag'],
  ] as const)('checks the effective mode card for the project override %j', (project, label) => {
    const radios = modeGroup(parse(render(settingsWith([], project), [], 'agent')));
    expect(radios.map((radio) => textOf(all(radio, (element) => element.tag === 'b')[0]!))).toEqual(['Block', 'Ask me', 'Allow and flag']);
    expect(radios.map((radio) => radio.attrs['aria-checked'])).toEqual(['Block', 'Ask me', 'Allow and flag'].map((name) => String(name === label)));
  });

  it('shows no unsaved-changes bar for freshly loaded settings', () => {
    const html = render(settingsWith([], { mode: 'C' }), [], 'agent');
    expect(all(parse(html), (element) => element.attrs['aria-label'] === 'Unsaved changes' || hasClass(element, 'sw-savebar'))).toEqual([]);
    expect(html).not.toMatch(/unsaved change/i);
  });

  it('shows the four appearance settings with their defaults', () => {
    const root = parse(render(claude, claudeSession, 'appearance'));
    expect(settingTitles(root)).toEqual(['Density', 'Text size', 'Reduce motion', 'Dots on the map']);
    const radioGroups = all(root, (element) => element.attrs.role === 'radiogroup').map((group) => all(group, (element) => element.attrs.role === 'radio'));
    expect(radioGroups.map((radios) => radios.length)).toEqual([2, 5]);
    expect(radioGroups.map((radios) => radios.filter((radio) => radio.attrs['aria-checked'] === 'true').length)).toEqual([1, 1]);
    const switches = all(root, (element) => element.attrs.role === 'switch');
    expect(switches.map((element) => [element.attrs['aria-label'], element.attrs['aria-checked']])).toEqual([['Reduce motion', 'false'], ['Dots on the map', 'true']]);
  });
});

describe('Settings: accounts', () => {
  it("shows the accounts and the running sign-in of a core from before engine-scoped accounts as Claude's", () => {
    const account = { id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', email: 'a@example.com', createdAt: 1 };
    const older = { ...claude, accounts: { accounts: [account], activeId: account.id, login: { state: 'waiting', url: 'https://claude.com/oauth', error: null } } };
    const root = parse(render(older as unknown as SettingsView, claudeSession, 'accounts'));
    const section = settingSection(root, 'Claude accounts');
    expect([settingTitles(root), textOf(section).includes('a@example.com active'), all(section, (element) => element.tag === 'button' && textOf(element) === 'Open sign-in page').length])
      .toEqual([['Claude accounts'], true, 1]);
  });
});
