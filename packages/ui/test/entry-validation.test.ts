import { describe, expect, it } from 'vitest';
import { emptyForm, validateEntryForm, type EntryForm } from '../src/settings/entry-form';

const stdio = (patch: Partial<EntryForm> = {}): EntryForm => ({ ...emptyForm('ide'), name: 'local', command: 'npx', ...patch });
const http = (patch: Partial<EntryForm> = {}): EntryForm => ({ ...emptyForm('project'), type: 'http', name: 'docs', url: 'https://docs.example/mcp', ...patch });
const check = (form: EntryForm, taken: string[] = [], editing: string | null = null) => validateEntryForm(form, taken, editing);

function messageFor(form: EntryForm, field: keyof ReturnType<typeof check>, taken: string[] = [], editing: string | null = null): string {
  const errors = check(form, taken, editing);
  expect(Object.keys(errors), JSON.stringify(form)).toEqual([field]);
  expect(errors[field]!.trim()).not.toBe('');
  return errors[field]!;
}

describe('validateEntryForm', () => {
  it('finds nothing wrong with a complete stdio or http form', () => {
    expect(check(stdio())).toEqual({});
    expect(check(http())).toEqual({});
  });

  describe('name', () => {
    it.each(['', '   ', '\t'])('asks for a name when it is %j', (name) => {
      messageFor(stdio({ name }), 'name');
    });

    it('refuses the reserved names, each with its own message', () => {
      const reserved = ['ide', 'idecore', '__proto__'].map((name) => messageFor(stdio({ name }), 'name'));
      const generic = [messageFor(stdio({ name: 'a b' }), 'name'), messageFor(stdio({ name: 'docs' }), 'name', ['docs'])];
      expect(new Set([...reserved, ...generic]).size).toBe(5);
    });

    it('refuses a reserved name even with spaces around it', () => {
      expect(check(stdio({ name: ' idecore ' }))).toEqual({ name: check(stdio({ name: 'idecore' })).name });
    });

    it.each(['IDE', 'ide2', 'my-ide', 'constructor', 'toString', 'hasOwnProperty', 'prototype'])('accepts the ordinary name %j', (name) => {
      expect(check(stdio({ name }))).toEqual({});
    });

    it.each(['a', 'A-z_09', 'x'.repeat(64), '_', '-'])('accepts %j', (name) => {
      expect(check(stdio({ name }))).toEqual({});
    });

    it.each(['x'.repeat(65), 'a b', 'a.b', 'a/b', 'é', 'a:b', 'a@b'])('refuses %j', (name) => {
      messageFor(stdio({ name }), 'name');
    });

    it('refuses a name already used at the level', () => {
      messageFor(stdio({ name: 'docs' }), 'name', ['notes', 'docs']);
      messageFor(stdio({ name: ' docs ' }), 'name', ['docs']);
    });

    it('lets the server being edited keep its own name', () => {
      expect(check(stdio({ name: 'docs' }), ['notes', 'docs'], 'docs')).toEqual({});
      expect(check(stdio({ name: ' docs ' }), ['docs'], 'docs')).toEqual({});
    });

    it('refuses renaming the edited server onto another used name', () => {
      messageFor(stdio({ name: 'notes' }), 'name', ['notes', 'docs'], 'docs');
    });

    it('accepts a new name while editing', () => {
      expect(check(stdio({ name: 'fresh' }), ['notes', 'docs'], 'docs')).toEqual({});
    });
  });

  describe('stdio', () => {
    it.each(['', '   '])('asks for the command when it is %j', (command) => {
      messageFor(stdio({ command }), 'command');
    });

    it.each(['', 'A=1\nB=${HOME}', '_x=1', 'TOKEN=${TOKEN:-none}', 'QUERY=a=b', ' A = 1 \n\n  \nB=2', 'EMPTY='])('accepts the environment %j', (env) => {
      expect(check(stdio({ env }))).toEqual({});
    });

    it.each(['NOEQ', '=x', 'A=1\nBROKEN', '  =x  '])('names the line of %j that lacks NAME=', (env) => {
      const line = env.split('\n').at(-1)!.trim();
      expect(messageFor(stdio({ env }), 'env')).toContain(`"${line}"`);
    });

    it.each(['1BAD=x', 'BAD-NAME=x', 'A B=x', 'A=1\n9=x', 'é=x'])('refuses the variable name in %j', (env) => {
      messageFor(stdio({ env }), 'env');
    });

    it('ignores the http fields', () => {
      expect(check(stdio({ url: 'not a url', headers: 'broken' }))).toEqual({});
    });
  });

  describe('http', () => {
    it.each(['', '  '])('asks for the URL when it is %j', (url) => {
      messageFor(http({ url }), 'url');
    });

    it.each(['ftp://x', 'example.com', 'http://', 'https://', 'https://a b', 'HTTPS//x', 'ws://x'])('refuses the URL %j', (url) => {
      messageFor(http({ url }), 'url');
    });

    it.each(['https://a.b/c?d=e', 'http://localhost:3000/mcp', ' https://x '])('accepts the URL %j', (url) => {
      expect(check(http({ url }))).toEqual({});
    });

    it.each(['', 'Authorization: Bearer ${TOKEN}', 'X-Key:v\nX-Other: w', 'A: b:c'])('accepts the headers %j', (headers) => {
      expect(check(http({ headers }))).toEqual({});
    });

    it.each(['NoColon', ': value', 'A: 1\nB', '  :x'])('refuses the header lines %j', (headers) => {
      messageFor(http({ headers }), 'headers');
    });

    it.each(['X-Api-Key: v', 'Authorization: Bearer ${T}', 'x_y.z: v', "a!#$%&'*+.^_`|~-z: v", 'X-Key : v'])('accepts the header name in %j', (headers) => {
      expect(check(http({ headers }))).toEqual({});
    });

    it.each(['X Y: v', 'bad name: v', 'A: 1\nX Y: 2', 'Ключ: v', 'a(b): v', 'a/b: v', 'a"b: v'])('refuses the header name in %j', (headers) => {
      expect(messageFor(http({ headers }), 'headers')).toMatch(/^Header names use letters, digits and "-"/);
    });

    it.each(['NoColon', ': value', 'A: 1\nB', '  :x'])('reports the Name: value shape for %j', (headers) => {
      const message = messageFor(http({ headers }), 'headers');
      expect(message).toContain('Name: value');
      expect(message).toContain(`"${headers.split('\n').at(-1)!.trim()}"`);
      expect(message).not.toMatch(/^Header names/);
    });

    it('ignores the stdio fields', () => {
      expect(check(http({ command: '', env: 'broken' }))).toEqual({});
    });
  });

  describe('timeout', () => {
    it.each(['', '1', '60000'])('accepts %j', (timeout) => {
      expect(check(stdio({ timeout }))).toEqual({});
      expect(check(http({ timeout }))).toEqual({});
    });

    it.each(['0', '-5', '1.5', 'abc', '007', '1e3'])('refuses %j', (timeout) => {
      messageFor(stdio({ timeout }), 'timeout');
      messageFor(http({ timeout }), 'timeout');
    });
  });

  it('reports every broken field of a stdio form at once', () => {
    expect(Object.keys(check(stdio({ name: '', command: '', env: 'x', timeout: '0', url: 'bad', headers: 'bad' }))).sort())
      .toEqual(['command', 'env', 'name', 'timeout']);
  });

  it('reports every broken field of an http form at once', () => {
    expect(Object.keys(check(http({ name: 'a b', url: 'x', headers: 'bad', timeout: 'x', command: '', env: 'bad' }))).sort())
      .toEqual(['headers', 'name', 'timeout', 'url']);
  });
});
