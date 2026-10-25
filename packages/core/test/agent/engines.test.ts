import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { claudeEngine, claudeStatus } from '../../src/agent/engines/claude';
import { codexEngine } from '../../src/agent/engines/codex';
import type { BackgroundModel } from '../../src/agent/engines/registry';
import { MIN_CLAUDE_VERSION } from '../../src/agent/tools';
import { fakeCodex } from '../fake-codex/fake';
import { tempDir } from '../helpers';

const script = (body: string) => {
  const file = join(tempDir('ide-claude-'), 'claude.mjs');
  writeFileSync(file, body);
  return { command: process.execPath, args: [file] };
};
const printing = (output: string, code = 0) => script(`process.stdout.write(${JSON.stringify(output)}); process.exit(${code});`);

describe('claudeStatus', () => {
  it('is ready at the verified version and old below it, missing when claude cannot be found, and failed when it prints no version, exits with an error or never answers', async () => {
    const states = await Promise.all([
      claudeStatus(printing(`${MIN_CLAUDE_VERSION} (Claude Code)\n`)), claudeStatus(printing('2.0.1 (Claude Code)\n')), claudeStatus({ command: '/nonexistent/claude', args: [] }),
      claudeStatus(printing('hello')), claudeStatus(printing('', 1)), claudeStatus(script('setInterval(() => {}, 1000);'), 300),
    ]);
    const failed = expect.stringMatching(/^claude --version failed: /);
    expect(states).toEqual([
      { engine: 'claude', state: 'ready', hint: null },
      { engine: 'claude', state: 'old', hint: `Update to ≥ ${MIN_CLAUDE_VERSION}: run claude update.` },
      { engine: 'claude', state: 'missing', hint: 'Install Claude Code: claude is not on the PATH.' },
      { engine: 'claude', state: 'error', hint: 'claude --version printed no version.' },
      { engine: 'claude', state: 'error', hint: failed },
      { engine: 'claude', state: 'error', hint: 'claude --version did not answer in 0.3 s.' },
    ]);
  });
});

describe('claudeEngine', () => {
  it("runs a background call as the active account's claude in that account's whole environment, on haiku or a chosen Claude model, and only with a run directory", async (t) => {
    // The core may itself run inside a Claude Code session, whose mark claude refuses to start under.
    vi.stubEnv('CLAUDECODE', '1');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const dir = tempDir('ide-claude-bg-', t);
    const record = join(dir, 'call.json');
    const claude = script([
      "import { writeFileSync } from 'node:fs';",
      'for await (const chunk of process.stdin) void chunk;',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), account: process.env.ACCOUNT_MARK ?? null, inside: process.env.CLAUDECODE ?? null }));`,
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: { ok: true } }));",
    ].join('\n'));
    const engine = (runDir?: string) => claudeEngine({ command: () => ({ ...claude, env: { ACCOUNT_MARK: 'work' } }), cwd: dir, ...(runDir === undefined ? {} : { runDir }) });
    const run = join(dir, 'run');
    const [haiku, opus, foreign, unrun] = await Promise.all([engine(run).background(null), engine(run).background('opus'), engine(run).background('codex:gpt-6'), engine().background(null)]);
    expect([haiku && typeof haiku === 'object' && haiku.modelId, opus && typeof opus === 'object' && opus.modelId, foreign, unrun]).toEqual(['haiku', 'opus', null, null]);
    expect(await (haiku as BackgroundModel).model.generate({ prompt: 'p', schema: { type: 'object' } })).toEqual({ ok: true });
    const call = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; account: string | null; inside: string | null };
    expect([call.argv.slice(0, 3), call.account, call.inside]).toEqual([['-p', '--model', 'haiku'], 'work', null]);
  });
});

describe('codexEngine', () => {
  it('runs a background call on its fast model, else its default, or on the chosen one from any page of the list, at the lowest effort, never on another engine\'s model, and only with a run directory', async (t) => {
    const dir = tempDir('ide-codex-bg-', t);
    const runDir = join(dir, 'run');
    const engine = (withRunDir: boolean, env: Record<string, string> = {}) => codexEngine({ command: () => fakeCodex(null, join(dir, 'record.jsonl'), env), cwd: dir, signedOut: () => 'signed out', ...(withRunDir ? { runDir } : {}) });
    const answers = await Promise.all([
      engine(true).background(null), engine(true).background('codex:gpt-5.6-terra'), engine(true).background('gpt-6-luna'), engine(false).background(null),
      engine(true, { FAKE_CODEX_VERSION: '0.161.0' }).background(null),
    ]);
    expect(answers).toMatchObject([
      { modelId: 'codex:gpt-6-luna', model: { options: { model: 'gpt-6-luna', effort: 'low', runDir } } },
      { modelId: 'codex:gpt-5.6-terra', model: { options: { model: 'gpt-5.6-terra', effort: 'low', runDir } } },
      null,
      null,
      // A codex the tool switches were not verified on is a reason, before any call.
      'Codex 0.161.0 is newer than CodeRay has checked for background calls; chats are not affected',
    ]);
  });
});
