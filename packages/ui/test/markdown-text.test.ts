import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { languageOf, textOf } from '../src/chat/markdown-text';

describe('textOf', () => {
  it('returns strings as they are', () => {
    expect(textOf('hello <b>')).toBe('hello <b>');
  });

  it('stringifies numbers including zero', () => {
    expect([textOf(42), textOf(0), textOf(-1.5)]).toEqual(['42', '0', '-1.5']);
  });

  it('gives an empty string for null, undefined and booleans', () => {
    expect([textOf(null), textOf(undefined), textOf(true), textOf(false)]).toEqual(['', '', '', '']);
  });

  it('concatenates arrays in order and skips empty entries', () => {
    expect(textOf(['a', 1, null, false, 'b', undefined])).toBe('a1b');
  });

  it('reads the children of an element', () => {
    expect(textOf(createElement('code', null, 'x = 1'))).toBe('x = 1');
  });

  it('reads nested elements and arrays depth first', () => {
    const tree = createElement('pre', null, createElement('code', null, 'a', createElement('span', null, 'b', 2), ['c', [createElement('i', null, 'd')]]), 'e');
    expect(textOf(tree)).toBe('ab2cde');
  });

  it('gives an empty string for an element without children', () => {
    expect(textOf(createElement('br'))).toBe('');
  });

  it('keeps whitespace and newlines untouched', () => {
    expect(textOf(['a\n', createElement('b', null, '  b\n')])).toBe('a\n  b\n');
  });
});

describe('languageOf', () => {
  it('reads the language from a language- class', () => {
    expect(languageOf('language-ts')).toBe('ts');
  });

  it('finds the class among others', () => {
    expect(languageOf('foo language-python bar')).toBe('python');
  });

  it.each([['language-c++', 'c++'], ['language-c#', 'c#'], ['language-objective-c', 'objective-c'], ['language-v1.2', 'v1.2'], ['language-c_sharp9', 'c_sharp9']])('keeps the whole name of %s', (cls, name) => {
    expect(languageOf(cls)).toBe(name);
  });

  it('stops at whitespace', () => {
    expect(languageOf('language-ts extra')).toBe('ts');
  });

  it('takes the first language class when there are several', () => {
    expect(languageOf('language-a language-b')).toBe('a');
  });

  it('gives null without a language class', () => {
    expect([languageOf('foo bar'), languageOf(''), languageOf('language-'), languageOf('xlanguage-ts')]).toEqual([null, null, null, null]);
  });

  it('gives null for undefined', () => {
    expect(languageOf(undefined)).toBeNull();
  });
});
