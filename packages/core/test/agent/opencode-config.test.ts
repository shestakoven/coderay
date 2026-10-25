import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentPermission, BUILT_IN_TOOLS, checkedSubagents, denyAllProblem, inlineConfig, ruleset, selfCheck, toolOutputGlob } from '../../src/agent/opencode/config';
import { opencodeMcp } from '../../src/agent/opencode/mcp';

const RECORDED = fileURLToPath(new URL('../fixtures/opencode/recorded/', import.meta.url));
const RULES = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', todowrite: 'allow', question: 'allow', skill: 'allow', 'idecore_*': 'allow' };
// An executable file, as the shell wrapper is.
const SHELL = '/bin/sh';
const GONE = '/nonexistent/opencode-shell/zsh';
const TOOL_OUTPUT = '/data/opencode/tool-output/*';
const { config: mcp } = opencodeMcp({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer s' } }, files: { type: 'stdio', command: 'node', args: ['srv.js'], env: { A: '1' } } }, {});
const expected = { mcp, toolOutput: TOOL_OUTPUT, shell: SHELL };
const agent = (name: string, extra: Record<string, unknown> = {}, mode = name === 'general' || name === 'explore' ? 'subagent' : 'primary') => ({ name, mode, native: true, permission: { ...RULES, ...extra } });
const good = ['build', 'plan', 'general', 'explore'].map((name) => agent(name));
// F4: a plugin listed under OPENCODE_PURE is not loaded, so a listed one passes.
const config = { share: 'disabled', shell: SHELL, lsp: false, formatter: false, plugin: ['file:///home/.config/opencode/plugins/global.js'], mcp: { ...mcp, usersrv: { type: 'local', enabled: false } } };
const tools = [...BUILT_IN_TOOLS];
const check = ({ expected: shellOf = expected, ...answers }: { agents?: unknown; config?: unknown; toolIds?: unknown; expected?: typeof expected }) => selfCheck({ agents: good, config, toolIds: tools, ...answers }, shellOf);
const rule = (permission: string, pattern: string, action: string) => ({ permission, pattern, action });

const recorded = (file: string): { dir: string; msg: { path?: string; body?: unknown } }[] =>
  readFileSync(join(RECORDED, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const answer = (file: string, path: string): unknown => recorded(file).find((line) => line.dir === 'res' && line.msg.path === path)?.msg.body;

describe('inlineConfig', () => {
  it("puts the rules on every agent in use and at the top level, CodeRay's servers in, the user's off by name, sharing, updates, language servers and formatters off, the shell wrapper, and the same rules as a list for sessions", () => {
    const parsed = JSON.parse(inlineConfig(opencodeMcp({ idecore: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer s' } } }), ['usersrv', 'other', 'idecore'], SHELL));
    expect([Object.keys(parsed.agent), ...Object.values(parsed.agent).map((entry) => Object.entries((entry as { permission: object }).permission)), Object.entries(parsed.permission), parsed.mcp.idecore.url, parsed.mcp.usersrv, parsed.mcp.other, parsed.share, parsed.autoupdate, parsed.lsp, parsed.formatter, parsed.shell, ruleset(), agentPermission()]).toEqual([
      ['build', 'plan', 'general', 'explore'], ...Array(4).fill(Object.entries(RULES)), Object.entries(RULES), 'http://127.0.0.1:9/mcp?keepAlive=1', { enabled: false }, { enabled: false }, 'disabled', false, false, false, SHELL,
      Object.entries(RULES).map(([permission, action]) => rule(permission, '*', action)), RULES,
    ]);
  });
});

describe('selfCheck', () => {
  it('passes agents whose last catch-all rule asks or denies and whose later allows are only the read-only tools, idecore, or the tool-output directory', () => {
    const withGlob = good.map((entry) => ({ ...entry, permission: { ...entry.permission, external_directory: { '*': 'ask', [TOOL_OUTPUT]: 'allow' } } }));
    const listed = good.map((entry) => ({ ...entry, permission: [rule('*', '*', 'ask'), rule('edit', '*', 'allow'), rule('*', '*', 'deny'), rule('read', '*', 'allow'), rule('bash', 'rm *', 'deny'), rule('idecore_*', '*', 'allow')] }));
    // A string is one catch-all rule.
    const asks = good.map((entry) => ({ ...entry, permission: 'ask' }));
    expect([check({}), check({ agents: withGlob }), check({ agents: listed }), check({ agents: asks })]).toEqual([null, null, null, null]);
  });

  it.each([
    ['a later allow for edit', [agent('build', { edit: 'allow' })], { agent: 'build', permission: 'edit', pattern: '*', action: 'allow' }],
    ['an object value with an allow on a pattern', [agent('plan', { bash: { '*': 'allow', 'rm *': 'deny' } })], { agent: 'plan', permission: 'bash', pattern: '*', action: 'allow' }],
    ['an allow then a narrow deny (the allow still matches ls)', [agent('build', { bash: { 'git *': 'allow', 'rm *': 'deny' } })], { agent: 'build', permission: 'bash', pattern: 'git *', action: 'allow' }],
    ['a string value allow', [agent('build', { write: 'allow' })], { agent: 'build', permission: 'write', pattern: '*', action: 'allow' }],
    ['an allow for another MCP server', [agent('build', { 'usersrv_*': 'allow' })], { agent: 'build', permission: 'usersrv_*', pattern: '*', action: 'allow' }],
    ['external_directory allowed everywhere', [agent('build', { external_directory: 'allow' })], { agent: 'build', permission: 'external_directory', pattern: '*', action: 'allow' }],
    ["another home's tool-output directory", [agent('build', { external_directory: { '/elsewhere/opencode/tool-output/*': 'allow' } })], { agent: 'build', permission: 'external_directory', pattern: '/elsewhere/opencode/tool-output/*', action: 'allow' }],
    ['a subagent with no rules at all', [...good, { name: 'reviewer', mode: 'subagent', native: false, permission: {} }], { agent: 'reviewer', permission: '*', pattern: '*', action: 'none' }],
    ['an allow before a narrower ask, which is no catch-all', [{ name: 'build', mode: 'primary', permission: [rule('*', '*', 'ask'), rule('edit', '*', 'allow'), rule('*', 'src/*', 'ask')] }], { agent: 'build', permission: 'edit', pattern: '*', action: 'allow' }],
    ['a list of rules whose last catch-all is allow', [{ name: 'build', mode: 'primary', permission: [rule('*', '*', 'ask'), rule('*', '*', 'allow')] }], { agent: 'build', permission: '*', pattern: '*', action: 'allow' }],
    ['a list with a rule it cannot read', [{ name: 'build', mode: 'primary', permission: [rule('*', '*', 'ask'), { permission: 'edit' }] }], { agent: 'build', permission: '*', pattern: '*', action: 'unreadable' }],
  ])('refuses %s', (_name, agents, problem) => {
    expect(check({ agents })).toEqual(problem);
  });

  it.each([
    ['an agent in use missing from the list', { agents: good.filter((entry) => entry.name !== 'plan') }, 'opencode lists no agent "plan"'],
    ['an agent list it cannot read', { agents: 'nope' }, 'opencode listed no agents CodeRay can read'],
    ['an agent it cannot name', { agents: [...good, { mode: 'subagent', permission: RULES }] }, 'opencode listed no agents CodeRay can read'],
    ['a config it cannot read', { config: ['nope'] }, 'opencode answered with a config CodeRay cannot read'],
    ['a config whose servers it cannot read', { config: { ...config, mcp: 'nope' } }, 'opencode answered with a config CodeRay cannot read'],
    ['sharing on', { config: { ...config, share: 'auto' } }, 'opencode would share this chat (share: auto)'],
    ['another shell', { config: { ...config, shell: '/bin/zsh' } }, "opencode would run commands in /bin/zsh, not CodeRay's shell wrapper"],
    ['a shell wrapper that is gone', { config: { ...config, shell: GONE }, expected: { ...expected, shell: GONE } }, `CodeRay's shell wrapper ${GONE} is missing, so opencode would run commands in /bin/zsh`],
    ['a shell wrapper that is a directory', { config: { ...config, shell: '/bin' }, expected: { ...expected, shell: '/bin' } }, "CodeRay's shell wrapper /bin is missing, so opencode would run commands in /bin/zsh"],
    ['a shell wrapper that cannot run', { config: { ...config, shell: '/etc/hosts' }, expected: { ...expected, shell: '/etc/hosts' } }, "CodeRay's shell wrapper /etc/hosts is missing, so opencode would run commands in /bin/zsh"],
    ['language servers on', { config: { ...config, lsp: { typescript: { disabled: false } } } }, "opencode would start language servers, which can run the project's code"],
    ['formatters on', { config: { ...config, formatter: true } }, "opencode would run formatters, which can run the project's code"],
    ["idecore pointed elsewhere", { config: { ...config, mcp: { ...config.mcp, idecore: { ...mcp.idecore as object, url: 'http://evil/mcp' } } } }, 'opencode\'s MCP server "idecore" is not the one CodeRay configured'],
    ["idecore turned into a local server", { config: { ...config, mcp: { ...config.mcp, idecore: { ...mcp.idecore as object, type: 'local', command: ['node', 'evil.js'] } } } }, 'opencode\'s MCP server "idecore" is not the one CodeRay configured'],
    ["CodeRay's local server with another command", { config: { ...config, mcp: { ...config.mcp, files: { ...mcp.files as object, command: ['node', 'evil.js'] } } } }, 'opencode\'s MCP server "files" is not the one CodeRay configured'],
    ["CodeRay's local server with another environment", { config: { ...config, mcp: { ...config.mcp, files: { ...mcp.files as object, environment: { A: '1', NODE_OPTIONS: '--require evil.js' } } } } }, 'opencode\'s MCP server "files" is not the one CodeRay configured'],
    ["CodeRay's server missing", { config: { ...config, mcp: { usersrv: config.mcp.usersrv } } }, 'opencode\'s MCP server "idecore" is not the one CodeRay configured'],
    ["CodeRay's server switched off", { config: { ...config, mcp: { ...config.mcp, idecore: { ...mcp.idecore as object, enabled: false } } } }, 'opencode\'s MCP server "idecore" is not the one CodeRay configured'],
    ['a user server named as a property every object has', { config: { ...config, mcp: { ...config.mcp, constructor: { type: 'local' } } } }, 'opencode would start the MCP server "constructor", which CodeRay did not configure'],
    ['a user server still enabled', { config: { ...config, mcp: { ...config.mcp, usersrv: { type: 'local', enabled: true } } } }, 'opencode would start the MCP server "usersrv", which CodeRay did not configure'],
    ['a user server without an enabled flag', { config: { ...config, mcp: { ...config.mcp, other: { type: 'local' } } } }, 'opencode would start the MCP server "other", which CodeRay did not configure'],
    ['a custom tool', { toolIds: [...tools, 'marker'] }, 'opencode loaded a custom tool "marker", which would run without asking'],
    ['a custom tool in place of a built-in one', { toolIds: [...tools, 'write'] }, 'opencode loaded a custom tool "write" in place of its own, which would run without asking'],
    ['a tool list it cannot read', { toolIds: { ids: tools } }, 'opencode listed tools CodeRay cannot read'],
    ['an empty tool list', { toolIds: [] }, 'opencode listed tools without its own "bash", so CodeRay cannot tell which tools it runs'],
    ['a tool list without write', { toolIds: tools.filter((id) => id !== 'write') }, 'opencode listed tools without its own "write", so CodeRay cannot tell which tools it runs'],
  ])('refuses %s', (_name, answers, reason) => {
    expect(check(answers)).toBe(reason);
  });

  it("judges 1.19's recorded answers: its own rules around CodeRay's pass, a user's general agent with a bash allow (F3) and a user's write tool (F1) do not; with no data home set the glob is under ~/.local/share", () => {
    const home = (xdg: string) => toolOutputGlob({ XDG_DATA_HOME: `$TMP/${xdg}/data` });
    const judge = (file: string, xdg: string, toolIds: unknown = tools) => selfCheck({ agents: answer(file, '/agent'), config, toolIds }, { ...expected, toolOutput: home(xdg) });
    expect([
      judge('p01.jsonl', 'oc-e3-xdg-uRDFea'),
      judge('p06.jsonl', 'oc-e3-xdg-21uOao'),
      judge('p01.jsonl', 'oc-e3-xdg-uRDFea', answer('p06.jsonl', '/experimental/tool/ids')),
      checkedSubagents(answer('p06.jsonl', '/agent'), home('oc-e3-xdg-21uOao')),
      toolOutputGlob({ XDG_DATA_HOME: '' }),
    ]).toEqual([
      null,
      { agent: 'general', permission: 'bash', pattern: '*', action: 'allow' },
      'opencode loaded a custom tool "write" in place of its own, which would run without asking',
      ['explore'],
      join(homedir(), '.local', 'share', 'opencode', 'tool-output', '*'),
    ]);
  });
});

describe('denyAllProblem', () => {
  // 1.19's order (spike Q6): its defaults, the top-level map, the agent's map (a user's allow merged before CodeRay's deny), the tool-output allow.
  const echo = (after: Record<string, ReturnType<typeof rule>[]> = {}) => ['build', 'plan', 'general', 'explore'].map((name) => ({
    name, permission: [rule('*', '*', 'allow'), rule('*', '*', 'deny'), rule('edit', '*', 'allow'), rule('*', '*', 'deny'), rule('external_directory', TOOL_OUTPUT, 'allow'), ...(after[name] ?? [])],
  }));
  it("passes when only denies and the tool-output allow follow each agent's last deny, and names an allow or an ask there", () => {
    expect([
      denyAllProblem(echo(), TOOL_OUTPUT),
      denyAllProblem(echo({ build: [rule('external_directory', '/etc/*', 'allow')] }), TOOL_OUTPUT),
      denyAllProblem(echo({ plan: [rule('bash', '*', 'ask')] }), TOOL_OUTPUT),
    ]).toEqual([null, "opencode's agent build would allow external_directory /etc/*", "opencode's agent plan would ask bash *"]);
  });
});
