import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

const components: Components = {
  a: ({ href, children }: ComponentProps<'a'>) => (href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>),
  pre: ({ children }: ComponentProps<'pre'>) => <CodeBlock>{children}</CodeBlock>,
};

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
    </div>
  );
});
