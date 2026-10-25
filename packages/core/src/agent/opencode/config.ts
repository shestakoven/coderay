import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../json';
import type { OpencodeMcp } from './mcp';

export const AGENTS_IN_USE = ['build', 'plan', 'general', 'explore'] as const;
export const ALLOWED_TOOLS = ['read', 'glob', 'grep', 'list', 'todowrite', 'question', 'skill'] as const;
/** opencode 1.19's own tools under the hardening. A user's custom tool runs without asking whatever the rules say (F1). */
export const BUILT_IN_TOOLS = ['invalid', 'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'task', 'webfetch', 'todowrite', 'websearch', 'skill', 'apply_patch'] as const;
const ANY = '*';
const IDECORE_TOOLS = 'idecore_*';
const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_TOOLS);
const BUILT_IN: ReadonlySet<string> = new Set(BUILT_IN_TOOLS);
// An answer without these is not the registry the model's calls go through, so it cannot show a custom tool.
const REGISTRY_TOOLS = ['bash', 'read', 'edit', 'write'];

export type Action = 'allow' | 'ask' | 'deny';

// 1.19 lists the tools once a user tool's dependencies are installed; a server stopped mid-install leaves a lock the next waits about a minute on (F5).
export const TOOL_IDS_TIMEOUT_MS = 90_000;

/** The rules as opencode's config takes them (Q8-map): '*' first, insertion order kept. Only idecore's tools are allowed by rule (R14). */
export function agentPermission(): Record<string, Action> {
  return { [ANY]: 'ask', ...Object.fromEntries(ALLOWED_TOOLS.map((tool): [string, Action] => [tool, 'allow'])), [IDECORE_TOOLS]: 'allow' };
}

export interface Rule { permission: string; pattern: string; action: Action }

/** The same rules as a list, for POST /session. */
export function ruleset(): Rule[] {
  return Object.entries(agentPermission()).map(([permission, action]) => ({ permission, pattern: ANY, action }));
}

/** The inline config (`OPENCODE_CONFIG_CONTENT`): the rules on every agent in use and at the top level, CodeRay's MCP servers, the user's switched off by name, sharing, updates, language servers and formatters off, the shell wrapper. */
export function inlineConfig(mcp: OpencodeMcp, userServers: readonly string[], shell: string): string {
  return JSON.stringify({
    permission: agentPermission(),
    agent: Object.fromEntries(AGENTS_IN_USE.map((name) => [name, { permission: agentPermission() }])),
    mcp: { ...Object.fromEntries(userServers.filter((name) => !Object.hasOwn(mcp.config, name)).map((name) => [name, { enabled: false }])), ...mcp.config },
    share: 'disabled',
    autoupdate: false,
    // A language server or formatter runs the project's own code (its tsserver, eslint or prettier config) with no ask.
    lsp: false,
    formatter: false,
    shell,
  });
}

export const DENY_ALL: Rule[] = [{ permission: ANY, pattern: ANY, action: 'deny' }];

/** The inline config of a background call: no tool may run, none of the user's MCP servers starts, titles use the call's own model, nothing is shared. */
export function backgroundConfig(shell: string, userServers: readonly string[], smallModel?: string): string {
  const deny: Record<string, Action> = { [ANY]: 'deny' };
  return JSON.stringify({
    permission: deny,
    agent: Object.fromEntries(AGENTS_IN_USE.map((name) => [name, { permission: deny }])),
    // `mcp: {}` would merge with the user's config and switch nothing off: each of theirs is switched off by name.
    mcp: Object.fromEntries(userServers.map((name) => [name, { enabled: false }])),
    share: 'disabled',
    autoupdate: false,
    lsp: false,
    formatter: false,
    shell,
    // 1.19 titles every session with its small model, which would otherwise be the user's choice of provider (spike Q7).
    ...(smallModel === undefined ? {} : { small_model: smallModel }),
  });
}

/**
 * Why a background server could run anything: 1.19 takes the last rule that matches, so after each agent's last `* * deny` only denies may
 * follow, and the tool-output allow 1.19 appends to every agent (spike Q6). An ask counts too: nobody answers one. Null when every agent in use holds.
 */
export function denyAllProblem(agents: unknown, toolOutput: string): string | null {
  if (!readableAgents(agents)) return 'opencode listed no agents CodeRay can read';
  for (const name of AGENTS_IN_USE) {
    const agent = agents.find((candidate) => candidate.name === name);
    if (agent === undefined) return `opencode lists no agent "${name}"`;
    const rules = normalise(agent.permission);
    if (rules === null) return `opencode's agent ${name} has rules CodeRay cannot read`;
    const last = rules.findLastIndex((rule) => rule.permission === ANY && rule.pattern === ANY && rule.action === 'deny');
    if (last === -1) return `opencode's agent ${name} has no rule that denies everything`;
    const loose = rules.slice(last + 1).find((rule) => rule.action !== 'deny' && !(rule.permission === 'external_directory' && rule.pattern === toolOutput && rule.action === 'allow'));
    if (loose !== undefined) return `opencode's agent ${name} would ${loose.action} ${loose.permission} ${loose.pattern}`;
  }
  return null;
}

/** The glob 1.19 appends to every agent's rules, after CodeRay's: its tool-output directory under the server's data home. */
export function toolOutputGlob(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'tool-output', ANY);
}

export interface SelfCheckProblem { agent: string; permission: string; pattern: string; action: string }
/** The server's answers to GET /agent, GET /config and GET /experimental/tool/ids. */
export interface SelfCheckAnswers { agents: unknown; config: unknown; toolIds: unknown }
/** `mcp` is CodeRay's rendered entries (`OpencodeMcp.config`). */
export interface SelfCheckExpected { mcp: Record<string, unknown>; toolOutput: string; shell: string }

/** Why the server would let a write through, share the chat, or hand the model its secrets; null when it would not. The rules are read from GET /agent only: GET /config does not keep their order (Q8). */
export function selfCheck(answers: SelfCheckAnswers, expected: SelfCheckExpected): SelfCheckProblem | string | null {
  return configProblem(answers.config, expected) ?? toolProblem(answers.toolIds) ?? agentsProblem(answers.agents, expected.toolOutput);
}

/** The agents a `task` may reach (opencode's own test: not primary) that passed, by name. */
export function checkedSubagents(agents: unknown, toolOutput: string): string[] {
  if (!readableAgents(agents)) return [];
  const failed = new Set(agents.filter((agent) => agentProblem(agent, toolOutput) !== null).map((agent) => agent.name));
  return agents.filter((agent) => agent.mode !== 'primary' && !failed.has(agent.name)).map((agent) => agent.name);
}

function configProblem(config: unknown, expected: SelfCheckExpected): string | null {
  const mcp = isRecord(config) ? (config.mcp ?? {}) : null;
  if (!isRecord(config) || !isRecord(mcp)) return 'opencode answered with a config CodeRay cannot read';
  if (config.share !== 'disabled') return `opencode would share this chat (share: ${String(config.share)})`;
  // Q7: any other shell hands the model the server's password and config.
  if (config.shell !== expected.shell) return `opencode would run commands in ${String(config.shell)}, not CodeRay's shell wrapper`;
  // 1.19 falls back to /bin/zsh, with the secrets, when its shell is not an existing file.
  if (!isExecutableFile(expected.shell)) return `CodeRay's shell wrapper ${expected.shell} is missing, so opencode would run commands in /bin/zsh`;
  // A layer merged after CodeRay's (the user's org config, the managed one) can turn them back on.
  if (config.lsp !== false) return "opencode would start language servers, which can run the project's code";
  if (config.formatter !== false) return "opencode would run formatters, which can run the project's code";
  // A later layer can repoint CodeRay's own entry, and every idecore_* tool runs without asking.
  for (const [name, ours] of Object.entries(expected.mcp)) {
    if (!sameServer(Object.hasOwn(mcp, name) ? mcp[name] : undefined, ours)) return `opencode's MCP server "${name}" is not the one CodeRay configured`;
  }
  for (const [name, entry] of Object.entries(mcp)) {
    if (!Object.hasOwn(expected.mcp, name) && !(isRecord(entry) && entry.enabled === false)) return `opencode would start the MCP server "${name}", which CodeRay did not configure`;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameServer = (actual: unknown, ours: unknown): boolean =>
  isRecord(actual) && isRecord(ours) && actual.enabled === true && actual.type === ours.type
  && (ours.type === 'remote' ? actual.url === ours.url : same(actual.command, ours.command) && same(actual.environment, ours.environment));

function toolProblem(ids: unknown): string | null {
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return 'opencode listed tools CodeRay cannot read';
  const seen = new Set<string>();
  for (const id of ids) {
    if (!BUILT_IN.has(id)) return `opencode loaded a custom tool "${id}", which would run without asking`;
    if (seen.has(id)) return `opencode loaded a custom tool "${id}" in place of its own, which would run without asking`;
    seen.add(id);
  }
  const missing = REGISTRY_TOOLS.find((id) => !seen.has(id));
  return missing === undefined ? null : `opencode listed tools without its own "${missing}", so CodeRay cannot tell which tools it runs`;
}

type Agent = Record<string, unknown> & { name: string };
const readableAgents = (agents: unknown): agents is Agent[] =>
  Array.isArray(agents) && agents.every((agent) => isRecord(agent) && typeof agent.name === 'string');

function agentsProblem(agents: unknown, toolOutput: string): SelfCheckProblem | string | null {
  if (!readableAgents(agents)) return 'opencode listed no agents CodeRay can read';
  for (const agent of agents) {
    const problem = agentProblem(agent, toolOutput);
    if (problem) return problem;
  }
  const missing = AGENTS_IN_USE.find((name) => !agents.some((agent) => agent.name === name));
  return missing === undefined ? null : `opencode lists no agent "${missing}"`;
}

interface ServerRule { permission: string; pattern: string; action: string }

/** 1.19 takes the last rule that matches, so only an allow after the last catch-all ask or deny can let a call through: it must be a read-only tool's, idecore's, or the tool-output directory's. */
function agentProblem(agent: Agent, toolOutput: string): SelfCheckProblem | null {
  const problem = (rule: ServerRule): SelfCheckProblem => ({ agent: agent.name, permission: rule.permission, pattern: rule.pattern, action: rule.action });
  const rules = normalise(agent.permission);
  if (rules === null) return problem({ permission: ANY, pattern: ANY, action: 'unreadable' });
  const last = rules.findLastIndex((rule) => rule.permission === ANY && rule.pattern === ANY && (rule.action === 'ask' || rule.action === 'deny'));
  if (last === -1) return problem({ permission: ANY, pattern: ANY, action: 'none' });
  const allowed = (rule: ServerRule): boolean =>
    rule.action === 'ask' || rule.action === 'deny' || ALLOWED.has(rule.permission) || rule.permission === IDECORE_TOOLS
    || (rule.permission === 'external_directory' && rule.pattern === toolOutput);
  const loose = rules.slice(last + 1).find((rule) => !allowed(rule));
  return loose === undefined ? null : problem(loose);
}

const isServerRule = (rule: unknown): rule is ServerRule =>
  isRecord(rule) && typeof rule.permission === 'string' && typeof rule.pattern === 'string' && typeof rule.action === 'string';

/** An agent's rules in evaluation order: 1.19 answers a list; a config map counts in its insertion order. Null when one cannot be read. */
function normalise(permission: unknown): ServerRule[] | null {
  if (typeof permission === 'string') return [{ permission: ANY, pattern: ANY, action: permission }];
  if (Array.isArray(permission)) return permission.every(isServerRule) ? permission : null;
  if (!isRecord(permission)) return null;
  const rules: ServerRule[] = [];
  for (const [name, value] of Object.entries(permission)) {
    if (typeof value === 'string') rules.push({ permission: name, pattern: ANY, action: value });
    else if (!isRecord(value)) return null;
    else for (const [pattern, action] of Object.entries(value)) {
      if (typeof action !== 'string') return null;
      rules.push({ permission: name, pattern, action });
    }
  }
  return rules;
}
