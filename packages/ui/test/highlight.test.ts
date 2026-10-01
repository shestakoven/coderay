import { describe, expect, it } from 'vitest';
import { languageOf, tokenClasses } from '../src/history/highlight';

const classesOf = (path: string, text: string): (string | null)[] => {
  const classes = tokenClasses(path, text);
  if (!classes) throw new Error(`expected classes for ${path}, got null`);
  return classes;
};
// Classes of the characters of `text` covered by the first occurrence of `needle`.
const classAt = (path: string, text: string, needle: string): (string | null)[] => {
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`${needle} not in ${text}`);
  return classesOf(path, text).slice(start, start + needle.length);
};
const all = (value: string | null, length: number): (string | null)[] => new Array<string | null>(length).fill(value);

describe('languageOf', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.tsx', 'typescript'],
    ['src/a.js', 'javascript'],
    ['package.json', 'json'],
    ['styles.css', 'css'],
    ['README.md', 'markdown'],
    ['run.sh', 'bash'],
    ['ci.yml', 'yaml'],
    ['script.py', 'python'],
    ['index.html', 'xml'],
  ])('maps %s to %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it.each([
    ['A.TS', 'typescript'],
    ['Readme.MD', 'markdown'],
    ['Deploy.Yml', 'yaml'],
  ])('ignores the case of the extension in %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it('returns null for an unknown extension', () => {
    expect(languageOf('src/main.rs')).toBeNull();
  });

  it('returns null for a file without an extension', () => {
    expect(languageOf('Makefile')).toBeNull();
  });

  it('returns null for a dot-prefixed file with an unknown name', () => {
    expect(languageOf('.gitignore')).toBeNull();
  });

  it('uses the last extension of a name with several dots', () => {
    expect(languageOf('app.test.ts')).toBe('typescript');
    expect(languageOf('archive.ts.bak')).toBeNull();
  });
});

describe('tokenClasses', () => {
  it('returns one entry per character', () => {
    const text = 'const x = "hi";';
    expect(classesOf('a.ts', text)).toHaveLength(text.length);
  });

  it('gives a keyword the hljs-keyword class on every character', () => {
    expect(classAt('a.ts', 'const x = 1;', 'const')).toEqual(all('hljs-keyword', 5));
  });

  it('gives a string literal, quotes included, the hljs-string class', () => {
    expect(classAt('a.ts', 'const x = "hi";', '"hi"')).toEqual(all('hljs-string', 4));
  });

  it('gives plain identifiers, whitespace and punctuation a null class', () => {
    const text = 'const x = "hi";';
    const classes = classesOf('a.ts', text);
    expect([classes[5], classes[6], classes[7], classes[8], classes[9], classes[14]]).toEqual(all(null, 6));
  });

  it('leaves text without any token entirely null', () => {
    expect(classesOf('a.ts', 'foo bar')).toEqual(all(null, 7));
  });

  it('keeps the length when the source contains characters highlight.js escapes', () => {
    const text = 'a < b && "x"';
    expect(classesOf('a.ts', text)).toHaveLength(text.length);
  });

  it('aligns classes with the right characters when the source contains < & and quotes', () => {
    const text = 'a < b && "x"';
    expect(classAt('a.ts', text, '<')).toEqual([null]);
    expect(classAt('a.ts', text, '&&')).toEqual([null, null]);
    expect(classAt('a.ts', text, '"x"')).toEqual(all('hljs-string', 3));
  });

  it('keeps the length for a single quote and a greater-than sign', () => {
    const text = "'it' && x > y";
    const classes = classesOf('a.ts', text);
    expect(classes).toHaveLength(text.length);
    expect(classes.slice(0, 4)).toEqual(all('hljs-string', 4));
    expect(classes[text.indexOf('>')]).toBeNull();
  });

  it('counts a literal entity written in the source as its own characters', () => {
    const text = '"&amp;"';
    expect(classesOf('a.ts', text)).toEqual(all('hljs-string', 7));
  });

  it('gives entity characters inside a string the string class', () => {
    expect(classAt('a.ts', 'x = "<&>"', '"<&>"')).toEqual(all('hljs-string', 5));
  });

  it('uses the innermost class for a token nested in another token', () => {
    const text = 'x = `a ${b} c`';
    const classes = classesOf('a.ts', text);
    expect(classes).toHaveLength(text.length);
    expect(classAt('a.ts', text, '${b}')).toEqual(all('hljs-subst', 4));
    expect(classAt('a.ts', text, '`a ')).toEqual(all('hljs-string', 3));
    expect(classAt('a.ts', text, ' c`')).toEqual(all('hljs-string', 3));
  });

  it('counts newline characters inside a multi-line token', () => {
    const text = '/* a\nb */ let';
    const classes = classesOf('a.ts', text);
    expect(classes).toHaveLength(text.length);
    expect(classAt('a.ts', text, '/* a\nb */')).toEqual(all('hljs-comment', 9));
    expect(classAt('a.ts', text, 'let')).toEqual(all('hljs-keyword', 3));
  });

  it.each([
    ['a.js', 'return 42', '42', 'hljs-number'],
    ['a.tsx', 'const a = <div className="x">hi</div>;', 'const', 'hljs-keyword'],
    ['a.json', '{"a": 1}', '1', 'hljs-number'],
    ['a.py', 'def f(): pass', 'pass', 'hljs-keyword'],
    ['a.sh', 'if true; then echo "x"; fi', 'echo', 'hljs-built_in'],
    ['a.css', 'a { color: red; }', 'color', 'hljs-attribute'],
    ['a.yml', 'key: value', 'key', 'hljs-attr'],
    ['a.md', '# Title', 'Title', 'hljs-section'],
    ['a.html', '<a href="x">y</a>', 'href', 'hljs-attr'],
  ])('highlights %s source: %j gives %s the class %s', (path, text, needle, expected) => {
    expect(classesOf(path, text)).toHaveLength(text.length);
    expect(classAt(path, text, needle)).toEqual(all(expected, needle.length));
  });

  it('reports only the hljs- class of a token that carries further classes', () => {
    const text = 'def f(): pass';
    expect(classesOf('a.py', text)[text.indexOf('f(')]).toBe('hljs-title');
  });

  it('still returns one class per character for source the grammar does not accept', () => {
    const text = '{"a": 1} nope';
    const classes = classesOf('a.json', text);
    expect(classes).toHaveLength(text.length);
    expect(classAt('a.json', text, '{"a"')).toEqual(['hljs-punctuation', 'hljs-attr', 'hljs-attr', 'hljs-attr']);
    expect(classAt('a.json', text, 'nope')).toEqual(all(null, 4));
  });

  it('returns null for an unknown extension', () => {
    expect(tokenClasses('main.rs', 'fn main() {}')).toBeNull();
  });

  it('returns null for a file without an extension', () => {
    expect(tokenClasses('Makefile', 'all:')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(tokenClasses('a.ts', '')).toBeNull();
  });

  it('highlights text of exactly 20000 characters', () => {
    const text = 'a'.repeat(20_000);
    expect(tokenClasses('a.ts', text)).toHaveLength(20_000);
  });

  it('returns null for text over 20000 characters', () => {
    expect(tokenClasses('a.ts', 'a'.repeat(20_001))).toBeNull();
  });
});

describe('extensions that are also Object.prototype members', () => {
  it.each(['a.constructor', 'a.toString', 'a.valueOf', 'a.__proto__', 'a.hasOwnProperty'])('treats %s as an unknown language', (path) => {
    expect(languageOf(path)).toBeNull();
    expect(tokenClasses(path, 'abc')).toBeNull();
  });
});
