import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeStatus } from '../../src/agent/engines/claude';
import { MIN_CLAUDE_VERSION } from '../../src/agent/tools';
import { tempDir } from '../helpers';

const printing = (output: string, code = 0) => {
  const file = join(tempDir('ide-claude-'), 'claude.mjs');
  writeFileSync(file, `process.stdout.write(${JSON.stringify(output)}); process.exit(${code});`);
  return { command: process.execPath, args: [file] };
};

describe('claudeStatus', () => {
  it('is ready at the verified version and old below it, naming the version to update to', async () => {
    expect([await claudeStatus(printing(`${MIN_CLAUDE_VERSION} (Claude Code)\n`)), await claudeStatus(printing('2.0.1 (Claude Code)\n'))]).toEqual([
      { engine: 'claude', state: 'ready', hint: null },
      { engine: 'claude', state: 'old', hint: `Update to ≥ ${MIN_CLAUDE_VERSION}: run claude update.` },
    ]);
  });

  it('says claude is missing when it cannot be found, and that it failed when it prints no version or exits with an error', async () => {
    const states = await Promise.all([claudeStatus({ command: '/nonexistent/claude', args: [] }), claudeStatus(printing('hello')), claudeStatus(printing('', 1))]);
    expect(states.map((status) => status.state)).toEqual(['missing', 'error', 'error']);
  });
});
