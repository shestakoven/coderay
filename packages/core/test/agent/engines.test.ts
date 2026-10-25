import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeStatus } from '../../src/agent/engines/claude';
import { codexEngine } from '../../src/agent/engines/codex';
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

describe('codexEngine', () => {
  it('runs a background call on its fast model, else its default, or on the chosen one from any page of the list, at the lowest effort, never on another engine\'s model, and only with a run directory', async (t) => {
    const dir = tempDir('ide-codex-bg-', t);
    const runDir = join(dir, 'run');
    const command = fakeCodex(null, join(dir, 'record.jsonl'));
    const engine = (withRunDir: boolean) => codexEngine({ command: () => command, cwd: dir, signedOut: () => 'signed out', ...(withRunDir ? { runDir } : {}) });
    const answers = await Promise.all([engine(true).background(null), engine(true).background('codex:gpt-5.6-terra'), engine(true).background('gpt-6-luna'), engine(false).background(null)]);
    expect(answers).toMatchObject([
      { modelId: 'codex:gpt-6-luna', model: { options: { model: 'gpt-6-luna', effort: 'low', runDir } } },
      { modelId: 'codex:gpt-5.6-terra', model: { options: { model: 'gpt-5.6-terra', effort: 'low', runDir } } },
      null,
      null,
    ]);
  });
});
