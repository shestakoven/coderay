import { Children, isValidElement, type ReactNode } from 'react';

export function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(textOf).join('');
  return '';
}

export const languageOf = (className: string | undefined): string | null => /\blanguage-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? null;
