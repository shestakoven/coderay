import { describe, expect, it } from 'vitest';
import { cliArgs } from '../../src/agent/cli-transport';
import type { Launch } from '../../src/agent/transport';

const SESSION = '0b6f5a52-7c43-4c43-9a43-5d1d0c0e5a11';
const FRESH: Launch = {
  claude: { command: '/opt/claude', args: [] }, cwd: '/work/app', claudeSessionId: SESSION, resume: false,
  model: 'opus', effort: 'high', mcpConfigPath: '/run/app.mcp.json', disallowedTools: ['SendMessage', 'WebSearch'], gate: null,
};

describe('cliArgs', () => {
  it('starts a fresh chat and resumes a gated one as a headless stream-json claude in bypass with prompts on stdio, and nothing else', () => {
    const gate = { settingsPath: '/run/app.settings.json', appendSystemPrompt: 'CodeRay rules' };
    const stream = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'];
    const permissions = ['--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio'];
    expect([cliArgs(FRESH), cliArgs({ ...FRESH, resume: true, model: null, effort: null, gate })]).toEqual([
      [
        ...stream, '--session-id', SESSION, '--model', 'opus', '--effort', 'high',
        '--mcp-config', '/run/app.mcp.json', '--disallowedTools', 'SendMessage,WebSearch', ...permissions,
      ],
      [
        ...stream, '--resume', SESSION, '--mcp-config', '/run/app.mcp.json', '--disallowedTools', 'SendMessage,WebSearch',
        '--settings', '/run/app.settings.json', '--append-system-prompt', 'CodeRay rules', '--system-prompt-snapshot', 'off', ...permissions,
      ],
    ]);
  });
});
