import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from '../src/chat/MarkdownText';

// Outside a chat an image renders as its name, so the names show which previews a message got.
const html = (text: string) => renderToStaticMarkup(<MarkdownText text={text} scope="item-1" />);
const draft = (text: string) => renderToStaticMarkup(<MarkdownText text={text} />);
const previews = (markup: string) => [...markup.matchAll(/<div class="md-previews">(.*?)<\/div>/g)].map((match) => [...match[1]!.matchAll(/>([^<]+)</g)].map((name) => name[1]));

describe('MarkdownText image previews', () => {
  it('previews each image file a message names once, after the block that names it, at most six', () => {
    const markup = html('First a/1.png and `2.png`.\n\nThen [three](a/3.png) a/1.png a/4.png a/5.png a/6.png a/7.png a/8.png');
    expect(previews(markup)).toEqual([['1.png', '2.png'], ['3.png', '4.png', '5.png', '6.png']]);
    expect(markup.indexOf('md-previews')).toBeGreaterThan(markup.indexOf('</p>'));
  });

  it('previews nothing in fenced code, for a web address, for a file shown as an image already, or before the reply has an item', () => {
    expect([
      html('```\nout/fenced.png\n```'),
      html('see https://example.com/a.png'),
      html('![shot](docs/e.png) is docs/e.png'),
      draft('see docs/a.png'),
    ].map(previews)).toEqual([[], [], [], []]);
  });
});

describe('MarkdownText links and remote images', () => {
  it('shows a remote image as a link to it and never as an image to load', () => {
    const markup = html('![chart](https://evil.test/c.png?leak=secret)');
    expect(markup).toContain('<a class="md-image-link" href="https://evil.test/c.png?leak=secret"');
    expect(markup).not.toMatch(/<img|ci-plain/);
  });

  it('keeps only http, https and mailto links as anchors', () => {
    const anchors = (text: string) => [...html(text).matchAll(/<a href="([^"]*)"/g)].map((match) => match[1]);
    expect(anchors('[a](https://x.test) [b](http://x.test) [c](mailto:me@x.test) [d](javascript:alert(1)) [e](file:///etc/passwd) [f](docs/x.md) [g](vscode://open)'))
      .toEqual(['https://x.test', 'http://x.test', 'mailto:me@x.test']);
  });
});
