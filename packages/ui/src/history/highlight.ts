import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { bash, css, javascript, json, markdown, python, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', py: 'python',
};

const MAX_CHARS = 20_000;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

export function languageOf(path: string): keyof typeof LANGUAGES | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension]! : null;
}

// One class per character of `text` (the innermost highlight.js token), or null when the file is not highlightable.
export function tokenClasses(path: string, text: string): (string | null)[] | null {
  const language = languageOf(path);
  if (!language || text.length === 0 || text.length > MAX_CHARS) return null;
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const classes: (string | null)[] = [];
  const stack: (string | null)[] = [];
  for (const part of html.split(/(<span class="[^"]*">|<\/span>|&(?:amp|lt|gt|quot|#x27|#39);)/)) {
    if (part === '') continue;
    const open = /^<span class="([^"]*)">$/.exec(part);
    if (open) stack.push(/hljs-[\w-]+/.exec(open[1]!)?.[0] ?? null);
    else if (part === '</span>') stack.pop();
    else {
      const literal = ENTITIES[part] ?? part;
      const cls = stack[stack.length - 1] ?? null;
      for (let i = 0; i < literal.length; i++) classes.push(cls);
    }
  }
  return classes.length === text.length ? classes : null;
}
