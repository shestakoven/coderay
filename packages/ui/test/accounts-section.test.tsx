import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountLoginView, AccountView, EngineAccountsView, EngineId } from '@ide/protocol';
import { AccountsSection } from '../src/settings/AccountsSection';

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: (Element | string)[];
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const decode = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function parse(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const [, closing, tag, rawAttrs, selfClosing, text] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
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
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text);
const buttons = (node: Element, label: string): Element[] => all(node, (element) => element.tag === 'button' && textOf(element) === label);
const isDisabled = (element: Element): boolean => 'disabled' in element.attrs;

const A = { id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', email: 'a@example.com', createdAt: 1 };
const B = { id: '0b5c1a6e-3d2f-4e8a-9c7b-1f2e3d4c5b6a', email: 'b@example.com', createdAt: 2 };
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=secret-state-123';
const idle: AccountLoginView = { state: 'idle', engine: null, method: null, url: null, userCode: null, error: null };
const claudeLogin = (login: Pick<AccountLoginView, 'state' | 'url' | 'error'>): AccountLoginView => ({ ...login, engine: 'claude', method: 'browser', userCode: null });

function render(view: { accounts?: AccountView[]; activeId?: string | null; login?: Partial<AccountLoginView> } = {}, busy = false): Element {
  const { login = {}, ...list } = view;
  return parse(renderToStaticMarkup(
    <AccountsSection engine="claude" view={{ engine: 'claude', accounts: [A, B], activeId: null, ...list }} login={{ ...idle, ...login }} busy={busy} onRequest={() => undefined} />,
  ));
}

interface Row {
  label: string;
  text: string;
  checked: boolean;
  buttons: string[];
}

const isRadio = (element: Element): boolean => element.tag === 'input' && element.attrs.type === 'radio';

function rows(root: Element): Row[] {
  const group = all(root, (element) => element.attrs.role === 'radiogroup');
  expect(group).toHaveLength(1);
  return rowsIn(group[0]!);
}

function rowsIn(node: Element): Row[] {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [];
    const radios = all(child, isRadio);
    if (radios.length > 1) return rowsIn(child);
    if (radios.length === 0) return [];
    const label = all(child, (element) => element.tag === 'label')[0];
    return [{ label: textOf(label ?? child), text: textOf(child), checked: 'checked' in radios[0]!.attrs, buttons: all(child, (element) => element.tag === 'button').map(textOf) }];
  });
}

describe('AccountsSection account list', () => {
  it('lists System first and then each account by email', () => {
    expect(rows(render()).map((row) => row.label)).toStrictEqual(['System', 'a@example.com', 'b@example.com']);
  });

  it('marks the active account active and checks its radio, and only that one', () => {
    const listed = rows(render({ activeId: B.id }));
    expect([
      listed.filter((row) => hasWord(row.text, 'active')).map((row) => row.label),
      listed.filter((row) => row.checked).map((row) => row.label),
    ]).toStrictEqual([['b@example.com'], ['b@example.com']]);
  });

  it('marks System active and checked when no account is active', () => {
    const listed = rows(render({ activeId: null }));
    expect([
      listed.filter((row) => hasWord(row.text, 'active')).map((row) => row.label),
      listed.filter((row) => row.checked).map((row) => row.label),
    ]).toStrictEqual([['System'], ['System']]);
  });

  it('offers Remove on each real account and no button at all on System', () => {
    expect(rows(render({ activeId: A.id })).map((row) => [row.label, row.buttons])).toStrictEqual([
      ['System', []], ['a@example.com', ['Remove']], ['b@example.com', ['Remove']],
    ]);
  });

  it('offers no button on System while it is active either', () => {
    expect(rows(render({ activeId: null }))[0]).toMatchObject({ label: 'System', buttons: [] });
  });

  it('lists only System when there are no accounts', () => {
    expect(rows(render({ accounts: [] })).map((row) => [row.label, row.checked, row.buttons])).toStrictEqual([['System', true, []]]);
  });

  it('disables the choices, Remove and Add account while a request is in flight', () => {
    const root = render({ activeId: A.id }, true);
    const radios = all(root, isRadio);
    expect([radios.map(isDisabled), [...buttons(root, 'Remove'), ...buttons(root, 'Add account')].map(isDisabled)]).toStrictEqual([
      [true, true, true], [true, true, true],
    ]);
  });
});

describe('AccountsSection sign-in', () => {
  it('offers an enabled Add account button while idle, and no sign-in controls', () => {
    const root = render();
    expect([
      buttons(root, 'Add account').map(isDisabled),
      buttons(root, 'Open sign-in page').length,
      all(root, (element) => element.tag === 'input' && !isRadio(element)).length,
    ]).toStrictEqual([[false], 0, 0]);
  });

  it('shows an enabled sign-in button, a code input, Submit, Cancel and a hint while waiting with a URL', () => {
    const root = render({ login: claudeLogin({ state: 'waiting', url: URL, error: null }) });
    const codeInputs = all(root, (element) => element.tag === 'input' && !isRadio(element));
    expect([
      buttons(root, 'Open sign-in page').map(isDisabled),
      codeInputs.length,
      buttons(root, 'Submit').length,
      buttons(root, 'Cancel').length,
      /paste/i.test(textOf(root)),
      buttons(root, 'Add account').length,
    ]).toStrictEqual([[false], 1, 1, 1, true, 0]);
  });

  it('never shows the sign-in URL as text', () => {
    expect(textOf(render({ login: claudeLogin({ state: 'waiting', url: URL, error: null }) }))).not.toContain('secret-state-123');
  });

  it('disables the sign-in button and says claude is starting while waiting without a URL', () => {
    const root = render({ login: claudeLogin({ state: 'waiting', url: null, error: null }) });
    expect([buttons(root, 'Open sign-in page').map(isDisabled), textOf(root).includes('Starting claude…')]).toStrictEqual([[true], true]);
  });

  it('says it is checking the account and offers no Add account while checking', () => {
    const root = render({ login: claudeLogin({ state: 'checking', url: null, error: null }) });
    expect([textOf(root).includes('Checking account…'), buttons(root, 'Add account').length, buttons(root, 'Open sign-in page').length]).toStrictEqual([true, 0, 0]);
  });

  it('shows the error message of a failed sign-in', () => {
    const root = render({ login: claudeLogin({ state: 'error', url: null, error: 'Claude did not report a signed-in account.' }) });
    expect(textOf(root)).toContain('Claude did not report a signed-in account.');
  });
});

const WORK = { id: '3c1e8f5a-7d2b-4c6e-9a1f-2b3c4d5e6f70', email: 'work@example.com', plan: 'Plus', createdAt: 3 };

function renderEngine(engine: EngineId, view: Partial<EngineAccountsView> = {}, login: AccountLoginView = idle): Element {
  return parse(renderToStaticMarkup(<AccountsSection engine={engine} view={{ engine, accounts: [], activeId: null, ...view }} login={login} busy={false} onRequest={() => undefined} />));
}

describe('AccountsSection per engine', () => {
  it("names the engine in its account group and in System's note, and shows an account's plan beside its e-mail", () => {
    const root = renderEngine('codex', { accounts: [WORK], activeId: WORK.id });
    expect([all(root, (element) => element.attrs.role === 'radiogroup')[0]?.attrs['aria-label'], rows(root).map((row) => row.text)]).toStrictEqual([
      'Codex account', ["System codex's own sign-in (codex login)", 'work@example.com Plus active Remove'],
    ]);
  });

  it("offers each of the engine's ways to sign in, the first one as the primary", () => {
    const ways = (engine: EngineId) => all(renderEngine(engine), (element) => element.tag === 'button' && (element.attrs.class ?? '').includes('account-add'))
      .map((button) => [textOf(button), !(button.attrs.class ?? '').includes('ghost')]);
    expect([ways('claude'), ways('codex')]).toStrictEqual([
      [['Add account', true]], [['Sign in with ChatGPT', true], ['Use a device code', false], ['Use an API key', false]],
    ]);
  });

  it('shows the code to enter, with a copy button, and never the page address as text, while a device-code sign-in waits', () => {
    const root = renderEngine('codex', {}, { state: 'waiting', engine: 'codex', method: 'device-code', url: 'https://auth.example.test/codex/device?s=SECRET', userCode: 'ABCD-1234', error: null });
    expect([buttons(root, 'Open the device page').map(isDisabled), textOf(root).includes('ABCD-1234'), buttons(root, 'Copy').length, textOf(root).includes('SECRET'), buttons(root, 'Cancel').length])
      .toStrictEqual([[false], true, 1, false, 1]);
  });
});
