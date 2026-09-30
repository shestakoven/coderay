import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../../src/agent/system-prompt';

describe('systemPrompt', () => {
  it('tells the agent to propose a plan and mark steps, and lists the component ids with their names', () => {
    const prompt = systemPrompt([{ id: 'auth', name: 'Auth' }, { id: 'billing', name: 'Billing' }]);
    expect(prompt).toContain('call mcp__idecore__propose_plan');
    expect(prompt).toContain('call mcp__idecore__step with {"key": "<key>", "phase": "start"}');
    expect(prompt).toContain('Tool errors that start with "IDE:" come from this IDE');
    expect(prompt.split('\n').slice(-3)).toEqual(['Components of this project (id — name):', '- auth — Auth', '- billing — Billing']);
  });

  it('lists at most 300 components and says how many more there are', () => {
    const components = Array.from({ length: 302 }, (_, index) => ({ id: `c${index}`, name: `C${index}` }));
    const lines = systemPrompt(components).split('\n');
    expect([lines.filter((line) => line.startsWith('- c')).length, lines.at(-1)]).toEqual([300, '- …and 2 more; name project paths for those.']);
  });

  it('asks for paths when the map has no components yet', () => {
    expect(systemPrompt([]).split('\n').at(-1)).toBe('The project map has no components yet; name project paths in your plans.');
  });
});
