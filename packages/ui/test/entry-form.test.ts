import { describe, expect, it } from 'vitest';
import { emptyForm, entryFromForm, formFromServer } from '../src/settings/entry-form';

describe('entryFromForm', () => {
  it('builds a stdio entry from argument lines and NAME=value lines, keeping "=" inside values', () => {
    const form = { ...emptyForm('ide'), name: 'local', command: 'npx', args: '-y\nserver\n', env: 'TOKEN=${TOKEN}\nQUERY=a=b' };
    expect(entryFromForm(form)).toEqual({ entry: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${TOKEN}', QUERY: 'a=b' } } });
  });

  it('builds an http entry from "Name: value" header lines', () => {
    const form = { ...emptyForm('project'), name: 'docs', type: 'http' as const, url: 'https://docs.example/mcp', headers: 'Authorization: Bearer ${TOKEN}', timeout: '60000' };
    expect(entryFromForm(form)).toEqual({ entry: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeout: 60000 } });
  });

  it('rejects an env line without "="', () => {
    expect(entryFromForm({ ...emptyForm('ide'), command: 'x', env: 'TOKEN' })).toEqual({ error: '"TOKEN" needs the form NAME=value.' });
  });

  it('round-trips a server through the form', () => {
    const entry = { type: 'stdio' as const, command: 'npx', args: ['-y', 'server'], env: { A: '1' }, timeout: 5000 };
    expect(entryFromForm(formFromServer({ name: 'local', level: 'ide', entry, entryHash: 'h', status: 'ready', reason: null }))).toEqual({ entry });
  });
});
