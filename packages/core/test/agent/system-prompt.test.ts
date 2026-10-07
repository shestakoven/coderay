import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../../src/agent/system-prompt';

describe('systemPrompt', () => {
  it('tells the agent to propose a plan and mark steps, and lists the component ids with their names', () => {
    const prompt = systemPrompt([{ id: 'auth', name: 'Auth' }, { id: 'billing', name: 'Billing' }]);
    expect(prompt).toContain('call mcp__idecore__propose_plan');
    expect(prompt).toContain('call mcp__idecore__step with {"key": "<key>", "phase": "start"}');
    expect(prompt).toContain('Tool errors that start with "CodeRay:" come from this CodeRay');
    expect(prompt.split('\n').slice(-3)).toEqual(['Components of this project (id — name):', '- auth — Auth', '- billing — Billing']);
  });

  it('tells the agent to send a flow with the plan, whichever optional tools are on', () => {
    expect([systemPrompt([]), systemPrompt([], true, true), systemPrompt([], false, false)].map((prompt) => prompt.includes('send a "flow"')))
      .toEqual([true, true, true]);
  });

  it('tells the agent to mark every step done and never calls done optional', () => {
    const prompt = systemPrompt([]);
    expect(prompt).toContain('when it is finished, call it with "phase": "done"');
    expect(prompt).not.toMatch(/only needed|optional/i);
  });

  it('lists at most 300 components and says how many more there are', () => {
    const components = Array.from({ length: 302 }, (_, index) => ({ id: `c${index}`, name: `C${index}` }));
    const lines = systemPrompt(components).split('\n');
    expect([lines.filter((line) => line.startsWith('- c')).length, lines.at(-1)]).toEqual([300, '- …and 2 more; name project paths for those.']);
  });

  it('asks for paths when the map has no components yet', () => {
    expect(systemPrompt([]).split('\n').at(-1)).toBe('The project map has no components yet; name project paths in your plans.');
  });

  it('mentions the search tool only when it is enabled', () => {
    expect(systemPrompt([], false, true)).toContain('mcp__idecore__search_code');
    expect(systemPrompt([], false, false)).not.toContain('search_code');
    expect(systemPrompt([])).not.toContain('search_code');
  });

  it('adds one search line regardless of the map tools line', () => {
    const count = (prompt: string) => prompt.split('\n').filter((line) => line.includes('mcp__idecore__search_code')).length;
    expect([count(systemPrompt([], true, true)), count(systemPrompt([], false, true))]).toEqual([1, 1]);
  });

  it('leaves the map tools line out when only the search tool is on', () => {
    expect(systemPrompt([], false, true)).not.toContain('map_overview');
  });
});
