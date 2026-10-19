import { describe, expect, it } from 'vitest';
import { compareInits } from '../../scripts/agent-parity';

describe('compareInits', () => {
  it('names what one init has and the other lacks, field by field, and nothing for equal inits', () => {
    const raw = { model: 'haiku', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'idecore', status: 'connected' }], plugins: [{ name: 'p', path: '/x' }] };
    expect(compareInits(raw, { ...raw })).toEqual([]);
    expect(compareInits(raw, { ...raw, tools: ['Bash', 'AskUserQuestion'], mcp_servers: [{ name: 'idecore', status: 'failed' }] })).toEqual([
      'tools: +AskUserQuestion -Read', 'mcp_servers: +idecore:failed -idecore:connected',
    ]);
  });
});
