import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownText } from '../src/chat/MarkdownText';

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), useState: <T,>(value: T) => [value, () => undefined] as const }));

const html = (text: string): string => renderToStaticMarkup(<MarkdownText text={text} />);
const body = (text: string): string => html(text).replace(/^<div class="md">/, '').replace(/<\/div>$/, '');

describe('markdown inline and block rendering', () => {
  it('renders bold, italic and inline code', () => {
    expect(body('**b** *i* `c`')).toBe('<p><strong>b</strong> <em>i</em> <code>c</code></p>');
  });

  it('escapes special characters in inline code', () => {
    expect(body('`a<b && c>d`')).toBe('<p><code>a&lt;b &amp;&amp; c&gt;d</code></p>');
  });

  it('renders heading levels', () => {
    expect(body('# One\n\n### Three\n\n###### Six')).toBe('<h1>One</h1>\n<h3>Three</h3>\n<h6>Six</h6>');
  });

  it('renders unordered lists', () => {
    expect(body('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  it('renders ordered lists with nested unordered lists', () => {
    expect(body('1. a\n2. b\n   - n')).toBe('<ol>\n<li>a</li>\n<li>b\n<ul>\n<li>n</li>\n</ul>\n</li>\n</ol>');
  });

  it('renders a GFM table with head and body cells', () => {
    expect(body('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  });

  it('renders task list items as disabled checkboxes with the right state', () => {
    const out = body('- [x] done\n- [ ] todo');
    expect(out).toContain('<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>');
    expect(out).toContain('<li class="task-list-item"><input type="checkbox" disabled=""/> todo</li>');
  });

  it('renders strikethrough as del', () => {
    expect(body('~~gone~~')).toBe('<p><del>gone</del></p>');
  });

  it('renders blockquotes', () => {
    expect(body('> quoted')).toBe('<blockquote>\n<p>quoted</p>\n</blockquote>');
  });

  it('renders an empty string as an empty wrapper', () => {
    expect(html('')).toBe('<div class="md"></div>');
  });

  it('keeps a very long single line in one paragraph', () => {
    const line = 'word '.repeat(5000).trim();
    expect(body(line)).toBe(`<p>${line}</p>`);
  });

  it('renders the same text to identical markup every time', () => {
    const text = '# t\n\n```ts\nx\n```\n\n[a](https://e.com)';
    expect(html(text)).toBe(html(text));
  });
});

describe('markdown links', () => {
  it('opens links in a new tab without leaking the opener', () => {
    expect(body('[y](https://e.com/p?q=1)')).toBe('<p><a href="https://e.com/p?q=1" target="_blank" rel="noopener noreferrer">y</a></p>');
  });

  it('turns a bare URL into an anchor with the same attributes', () => {
    expect(body('see https://auto.example.com now')).toBe('<p>see <a href="https://auto.example.com" target="_blank" rel="noopener noreferrer">https://auto.example.com</a> now</p>');
  });

  it('never emits a javascript: href', () => {
    expect(html('[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) [z](data:text/html,hi)')).not.toMatch(/href="\s*(javascript|data):/i);
  });

  it('keeps the link text of a blocked URL as plain text, not an empty link', () => {
    const out = html('[click me](javascript:alert(1))');
    expect(out).toContain('click me');
    expect(out).not.toContain('<a');
  });
});

describe('markdown raw html', () => {
  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://evil.example"></iframe>', '<a href="https://e.com" onclick="x()">raw</a>'])('does not emit %s as an element', (raw) => {
    const out = html(`before\n\n${raw}\n\nafter`);
    expect(out).not.toMatch(/<(script|img|iframe)\b/i);
    expect(out).not.toMatch(/<[^>]*\sonerror=/i);
    expect(out).not.toMatch(/<[^>]*\sonclick=/i);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('shows raw html as escaped text', () => {
    expect(body('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('markdown code blocks', () => {
  it('wraps a fenced block in .md-code with the language label and a Copy button', () => {
    expect(body('```ts\nconst a = 1;\n```')).toBe('<div class="md-code"><div class="md-code-bar"><span>ts</span><button aria-label="Copy code">Copy</button></div><pre><code class="language-ts">const a = 1;\n</code></pre></div>');
  });

  it('leaves the label empty when the fence has no language', () => {
    const out = body('```\nplain\n```');
    expect(out).toContain('<div class="md-code-bar"><span></span><button aria-label="Copy code">Copy</button></div>');
    expect(out).toContain('<pre><code>plain\n</code></pre>');
  });

  it.each([['c++', 'c++'], ['c#', 'c#'], ['objective-c', 'objective-c']])('labels a %s block', (fence, label) => {
    expect(body('```' + fence + '\nx\n```')).toContain(`<span>${label}</span>`);
  });

  it('preserves angle brackets, ampersands, quotes and backticks in code exactly', () => {
    const out = body('```html\n<div class="a">&amp; `x` ``y``</div>\n```');
    expect(out).toContain('<code class="language-html">&lt;div class=&quot;a&quot;&gt;&amp;amp; `x` ``y``&lt;/div&gt;\n</code>');
  });

  it('keeps indentation and blank lines inside the block', () => {
    expect(body('```py\nif x:\n\n    y\n```')).toContain('<code class="language-py">if x:\n\n    y\n</code>');
  });

  it('does not render markdown inside a fenced block', () => {
    const out = body('```\n**not bold** # not heading\n```');
    expect(out).not.toMatch(/<strong>|<h1>/);
    expect(out).toContain('**not bold** # not heading');
  });

  it('puts every fenced block in its own wrapper', () => {
    expect(html('```a\n1\n```\n\n```b\n2\n```').match(/class="md-code"/g)).toHaveLength(2);
  });

  it('does not wrap inline code in a code block bar', () => {
    expect(html('use `x`')).not.toContain('md-code');
  });
});

describe('markdown code copy payload', () => {
  type Props = { children?: ReactNode; onClick?: () => void };
  const find = (node: ReactNode, match: (element: ReactElement<Props>) => boolean): ReactElement<Props> | null => {
    if (Array.isArray(node)) return node.map((n) => find(n, match)).find(Boolean) ?? null;
    if (!isValidElement<Props>(node)) return null;
    return match(node) ? node : find(node.props.children, match);
  };

  const copied = async (text: string): Promise<string[]> => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const rendered = (MarkdownText as unknown as { type: (props: { text: string }) => ReactElement<Props> }).type({ text });
    const markdown = (rendered.props.children as ReactElement<{ children: string; components: unknown }>);
    const tree = (markdown.type as unknown as (props: unknown) => ReactElement<Props>)(markdown.props);
    const expand = (node: ReactNode): ReactNode => {
      if (Array.isArray(node)) return node.map(expand);
      if (!isValidElement<Props>(node)) return node;
      if (typeof node.type === 'function') return expand((node.type as (props: Props) => ReactNode)(node.props));
      return { ...node, props: { ...node.props, children: expand(node.props.children) } };
    };
    find(expand(tree), (el) => el.type === 'button')!.props.onClick!();
    await Promise.resolve();
    return writeText.mock.calls.map((call) => String((call as unknown[])[0]));
  };

  afterEach(() => vi.unstubAllGlobals());

  it('copies the code without the trailing newline', async () => {
    expect(await copied('```ts\nconst a = 1;\n```')).toEqual(['const a = 1;']);
  });

  it('copies special characters verbatim', async () => {
    expect(await copied('```\n<a href="x">&amp; `y`</a>\n```')).toEqual(['<a href="x">&amp; `y`</a>']);
  });

  it('removes only the final newline and keeps earlier blank lines', async () => {
    expect(await copied('```\na\n\n\nb\n```')).toEqual(['a\n\n\nb']);
  });
});
