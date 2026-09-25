import type { McpEntry, McpLevel, McpServerView, McpTransport } from '@ide/protocol';

export interface EntryForm {
  name: string;
  level: McpLevel;
  type: McpTransport;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  timeout: string;
}

export const emptyForm = (level: McpLevel): EntryForm =>
  ({ name: '', level, type: 'stdio', command: '', args: '', env: '', url: '', headers: '', timeout: '' });

export function formFromServer(server: McpServerView): EntryForm {
  const { entry } = server;
  return {
    name: server.name,
    level: server.level,
    type: entry.type,
    command: entry.command ?? '',
    args: (entry.args ?? []).join('\n'),
    env: Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    url: entry.url ?? '',
    headers: Object.entries(entry.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n'),
    timeout: entry.timeout === undefined ? '' : String(entry.timeout),
  };
}

export function entryFromForm(form: EntryForm): { entry: McpEntry } | { error: string } {
  const env = pairs(form.env, '=', 'NAME=value');
  if ('error' in env) return env;
  const headers = pairs(form.headers, ':', 'Name: value');
  if ('error' in headers) return headers;
  const timeoutText = form.timeout.trim();
  if (timeoutText !== '' && !/^\d+$/.test(timeoutText)) return { error: 'The timeout must be a whole number of milliseconds.' };
  if (form.type === 'stdio' && form.command.trim() === '') return { error: 'Enter a command.' };
  if (form.type === 'http' && form.url.trim() === '') return { error: 'Enter a URL.' };
  const args = lines(form.args);
  const base: McpEntry = form.type === 'stdio'
    ? {
        type: 'stdio',
        command: form.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env.pairs).length > 0 ? { env: env.pairs } : {}),
      }
    : { type: 'http', url: form.url.trim(), ...(Object.keys(headers.pairs).length > 0 ? { headers: headers.pairs } : {}) };
  return { entry: timeoutText === '' ? base : { ...base, timeout: Number(timeoutText) } };
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

function pairs(text: string, separator: string, shape: string): { pairs: Record<string, string> } | { error: string } {
  const result: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    if (at <= 0) return { error: `"${line}" needs the form ${shape}.` };
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { pairs: result };
}
