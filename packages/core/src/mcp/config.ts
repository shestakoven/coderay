import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpEntry } from '@ide/protocol';
import { isRecord } from '../json';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const RESERVED = new Map([
  ['ide', '"ide" is reserved by Claude Code'],
  ['idecore', '"idecore" is reserved for the IDE\'s own server'],
  ['__proto__', '"__proto__" cannot be a server name'],
]);

export interface McpFile {
  servers: Map<string, McpEntry>;
  problems: string[];
}

export interface RawMcpFile {
  [key: string]: unknown;
  mcpServers: Record<string, unknown>;
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

function compact(entry: McpEntry): McpEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as unknown as McpEntry;
}

export function parseEntry(name: string, raw: unknown): McpEntry | string {
  const reserved = RESERVED.get(name);
  if (reserved) return `${name}: ${reserved}`;
  if (!NAME.test(name)) return `${name}: names may contain only letters, digits, "_" and "-" (at most 64)`;
  if (!isRecord(raw)) return `${name}: an entry must be an object`;
  const { command, args, env, url, headers, timeout } = raw;
  const type = raw.type ?? (command === undefined ? undefined : 'stdio');
  if (timeout !== undefined && !isPositiveInteger(timeout)) return `${name}: "timeout" must be a positive whole number of milliseconds`;
  if (type === 'stdio') {
    if (typeof command !== 'string' || command === '') return `${name}: a stdio server needs a "command"`;
    if (args !== undefined && !isStringList(args)) return `${name}: "args" must be a list of strings`;
    if (env !== undefined && !isStringMap(env)) return `${name}: "env" must map names to strings`;
    return compact({ type, command, args, env, timeout });
  }
  if (type === 'http') {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return `${name}: an http server needs an http(s) "url"`;
    if (headers !== undefined && !isStringMap(headers)) return `${name}: "headers" must map names to strings`;
    return compact({ type, url, headers, timeout });
  }
  return `${name}: "type" must be "stdio" or "http"`;
}

export function readRawMcp(path: string): RawMcpFile | string {
  if (!existsSync(path)) return { mcpServers: {} };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `${path} is not valid JSON`;
  }
  if (!isRecord(value)) return `${path} must contain a JSON object`;
  const servers = value.mcpServers ?? {};
  if (!isRecord(servers)) return `${path}: "mcpServers" must be an object`;
  return { ...value, mcpServers: servers };
}

export function readMcpFile(path: string): McpFile {
  const servers = new Map<string, McpEntry>();
  const raw = readRawMcp(path);
  if (typeof raw === 'string') return { servers, problems: [raw] };
  const problems: string[] = [];
  for (const [name, value] of Object.entries(raw.mcpServers)) {
    const entry = parseEntry(name, value);
    if (typeof entry === 'string') problems.push(entry);
    else servers.set(name, entry);
  }
  return { servers, problems };
}

export function writeRawMcp(path: string, file: RawMcpFile, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, mode === undefined ? {} : { mode });
  if (mode !== undefined) chmodSync(path, mode);
}

export function entryHash(name: string, entry: McpEntry): string {
  return createHash('sha256').update(canonical([name, entry])).digest('hex');
}

export function fileHash(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

// claude expands ${VAR} and ${VAR:-default} in url and ${VAR} in headers itself (spike c28), so those secrets stay out of the run file.
export function prepareEntry(entry: McpEntry, env: NodeJS.ProcessEnv): { entry: McpEntry; missing: string[] } {
  const missing = new Set<string>();
  const prepare = (claudeExpands: 'none' | 'plain' | 'all') => (text: string): string =>
    text.replace(VARIABLE, (match, name: string, fallback: string | undefined) => {
      const value = Object.hasOwn(env, name) ? env[name] : undefined;
      if (value === undefined && fallback === undefined) missing.add(name);
      if (claudeExpands === 'all' || (claudeExpands === 'plain' && fallback === undefined)) return match;
      if (value !== undefined && value !== '') return value;
      return fallback ?? '';
    });
  const mapValues = (map: Record<string, string> | undefined, change: (text: string) => string) =>
    map && Object.fromEntries(Object.entries(map).map(([key, value]) => [key, change(value)]));
  const prepared = compact({
    ...entry,
    command: entry.command === undefined ? undefined : prepare('none')(entry.command),
    args: entry.args?.map(prepare('none')),
    env: mapValues(entry.env, prepare('none')),
    url: entry.url === undefined ? undefined : prepare('all')(entry.url),
    headers: mapValues(entry.headers, prepare('plain')),
  });
  return { entry: prepared, missing: [...missing].sort() };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);
}
