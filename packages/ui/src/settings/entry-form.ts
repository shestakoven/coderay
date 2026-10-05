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

export type EntryField = 'name' | 'command' | 'url' | 'env' | 'headers' | 'timeout';
export type EntryErrors = Partial<Record<EntryField, string>>;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// A Map: an object literal would swallow the __proto__ key instead of reserving it.
const RESERVED = new Map([
  ['ide', 'Claude Code reserves "ide".'],
  ['idecore', '"idecore" is the IDE\'s own server.'],
  ['__proto__', 'This name cannot be used.'],
]);

function checkPairs(text: string, separator: string, shape: string, nameRule: RegExp | null, nameHint: string): string | null {
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    if (at <= 0) return `"${line}" needs the form ${shape}.`;
    if (nameRule && !nameRule.test(line.slice(0, at).trim())) return `${nameHint}: "${line.slice(0, at).trim()}"`;
  }
  return null;
}

// Field by field, what the core would reject. `taken` lists the names already used at the form's level.
export function validateEntryForm(form: EntryForm, taken: string[], editing: string | null): EntryErrors {
  const errors: EntryErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'Give the server a name.';
  else if (RESERVED.has(name)) errors.name = RESERVED.get(name);
  else if (!NAME.test(name)) errors.name = 'Use letters, digits, "_" and "-" (up to 64).';
  else if (name !== editing && taken.includes(name)) errors.name = 'A server with this name already exists at this level.';
  if (form.type === 'stdio') {
    if (form.command.trim() === '') errors.command = 'Enter the command that starts the server.';
    const env = checkPairs(form.env, '=', 'NAME=value', VARIABLE_NAME, 'Names use letters, digits and "_"');
    if (env) errors.env = env;
  } else {
    const url = form.url.trim();
    if (url === '') errors.url = 'Enter the server URL.';
    else if (!/^https?:\/\/\S+$/.test(url)) errors.url = 'The URL must start with http:// or https://';
    const headers = checkPairs(form.headers, ':', 'Name: value', HEADER_NAME, 'Header names use letters, digits and "-"');
    if (headers) errors.headers = headers;
  }
  const timeout = form.timeout.trim();
  if (timeout !== '' && !/^[1-9]\d*$/.test(timeout)) errors.timeout = 'Use a whole number of milliseconds, above 0.';
  return errors;
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
