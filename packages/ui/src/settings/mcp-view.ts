import type { McpEntry, McpServerStatus, McpServerView } from '@ide/protocol';

export type Tone = 'ok' | 'warn' | 'error' | 'muted';

export interface ServerBadge {
  tone: Tone;
  label: string;
}

const CONFIG_BADGE: Record<McpServerStatus, ServerBadge> = {
  ready: { tone: 'ok', label: 'Ready' },
  unapproved: { tone: 'warn', label: 'Needs approval' },
  'missing-env': { tone: 'error', label: 'Missing variable' },
  shadowed: { tone: 'muted', label: 'Shadowed' },
};

export function liveBadge(status: string | undefined): ServerBadge | null {
  if (status === undefined) return null;
  if (status === 'connected') return { tone: 'ok', label: 'Connected' };
  if (status === 'failed') return { tone: 'error', label: 'Failed' };
  if (status === 'pending') return { tone: 'warn', label: 'Connecting' };
  if (status === 'needs-auth') return { tone: 'warn', label: 'Needs sign-in' };
  return { tone: 'muted', label: status };
}

// One dot and word per row: the configuration problem wins; a ready server shows what the running session reports.
export function serverBadge(status: McpServerStatus, live: string | undefined): ServerBadge {
  const config = CONFIG_BADGE[status];
  return status === 'ready' ? liveBadge(live) ?? config : config;
}

const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|cookie|session/i;

export const hasReference = (value: string): boolean => REFERENCE.test(value);

// A literal value under a secret-looking name is masked; ${VAR} references hold no secret themselves.
export const looksSecret = (name: string, value: string): boolean => SECRET_NAME.test(name) && !hasReference(value) && value !== '';

export const MASK = '••••••••';

export interface EntryPair {
  name: string;
  value: string;
  secret: boolean;
}

export interface EntryDescription {
  transport: McpEntry['type'];
  headline: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: EntryPair[];
  headers: EntryPair[];
  timeout: number | null;
}

const pairs = (map: Record<string, string> | undefined): EntryPair[] =>
  Object.entries(map ?? {}).map(([name, value]) => ({ name, value, secret: looksSecret(name, value) }));

export function describeEntry(entry: McpEntry): EntryDescription {
  const args = entry.args ?? [];
  return {
    transport: entry.type,
    headline: entry.type === 'stdio' ? [entry.command ?? '', ...args].join(' ').trim() : entry.url ?? '',
    command: entry.command ?? null,
    args,
    url: entry.url ?? null,
    env: pairs(entry.env),
    headers: pairs(entry.headers),
    timeout: entry.timeout ?? null,
  };
}

export const levelName = (level: McpServerView['level']): string => (level === 'ide' ? 'All projects' : 'This project');
