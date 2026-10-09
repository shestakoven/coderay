import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../layout/Icon';
import { ChatImage } from './ChatImage';
import { isLocalUrl, isWebUrl } from './image-paths';
import { baseName } from './image-source';
import { PREVIEWS_ELEMENT, remarkChatImages } from './markdown-images';
import { languageOf, textOf } from './markdown-text';

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = textOf(children).replace(/\n$/, '');
  const element = Array.isArray(children) ? children[0] : children;
  const language = languageOf((element as { props?: { className?: string } } | null)?.props?.className);
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{language ?? ''}</span>
        <button onClick={copy} aria-label="Copy code">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const NAVIGABLE = /^(?:https?|mailto):/i;

// File URLs survive for images the chat shows itself; every other scheme goes through react-markdown's filter.
const urlTransform = (url: string): string => (/^file:/i.test(url) ? url : defaultUrlTransform(url));

// A remote image is never fetched: its address could carry what the agent read out to anyone.
function MarkdownImage({ src, alt, 'data-scope': scope }: ComponentProps<'img'> & ExtraProps & { 'data-scope'?: string }) {
  const url = typeof src === 'string' ? src : '';
  if (isLocalUrl(url)) {
    return <ChatImage source={{ path: url }} title={alt || baseName(url)} name={baseName(url)} caption={alt || undefined} size="large" scope={scope || undefined} />;
  }
  if (isWebUrl(url)) {
    return (
      <a className="md-image-link" href={url} target="_blank" rel="noopener noreferrer" data-tip="Remote image, not loaded" data-sub={url}>
        <Icon name="image" size={13} />{alt || 'image'}
      </a>
    );
  }
  return <span className="md-image-link">{alt}</span>;
}

function ImagePreviews({ 'data-paths': paths, 'data-scope': scope }: { 'data-paths'?: string; 'data-scope'?: string }) {
  const list = JSON.parse(paths ?? '[]') as string[];
  return (
    <div className="md-previews">
      {list.map((path) => (
        <ChatImage key={path} source={{ path }} title={baseName(path)} name={baseName(path)} size={list.length > 1 ? 'small' : 'large'} scope={scope || undefined} quiet />
      ))}
    </div>
  );
}

const components = {
  a: ({ href, children }: ComponentProps<'a'>) => (href && NAVIGABLE.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>),
  pre: ({ children }: ComponentProps<'pre'>) => <CodeBlock>{children}</CodeBlock>,
  img: MarkdownImage,
  [PREVIEWS_ELEMENT]: ImagePreviews,
} as Components;

type Plugins = NonNullable<Options['remarkPlugins']>;

const DRAFT_PLUGINS: Plugins = [remarkGfm, [remarkChatImages, { scope: null, previews: false }]];

// `scope` is the chat item the text belongs to; without it (a reply still streaming) mentioned paths get no preview yet.
export const MarkdownText = memo(function MarkdownText({ text, scope }: { text: string; scope?: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={scope === undefined ? DRAFT_PLUGINS : [remarkGfm, [remarkChatImages, { scope, previews: true }]]}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </Markdown>
    </div>
  );
});
