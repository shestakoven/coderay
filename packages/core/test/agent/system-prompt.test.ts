import { createHash } from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MAX_PROJECT_INSTRUCTIONS, OPENCODE_RULES, opencodeSystem, systemPrompt, type PromptNames } from '../../src/agent/system-prompt';
import { createGateRuntime } from '../../src/gate/runtime';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { tempDir } from '../helpers';

describe('systemPrompt', () => {
  it('tells the agent to propose a plan and mark steps, and lists the component ids with their names', () => {
    const prompt = systemPrompt([{ id: 'auth', name: 'Auth' }, { id: 'billing', name: 'Billing' }]);
    expect(prompt).toContain('call mcp__idecore__propose_plan');
    expect(prompt).toContain('call mcp__idecore__step with {"key": "<key>", "phase": "start"}');
    expect(prompt).toContain('Tool errors that start with "CodeRay:" come from this CodeRay');
    expect(prompt.split('\n').slice(-3)).toEqual(['Components of this project (id — name):', '- auth — Auth', '- billing — Billing']);
  });

  it('tells the agent to send a flow with the plan, whichever optional tools are on', () => {
    expect([systemPrompt([]), systemPrompt([], true, true), systemPrompt([], false, false)].map((prompt) => prompt.includes('Send a "flow" with every plan, also when it only modifies or removes code')))
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

  it("keeps Claude's prompt byte for byte", () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect([
      systemPrompt([{ id: 'auth', name: 'Auth' }, { id: 'billing', name: 'Billing' }], true, true),
      systemPrompt([], false, false),
      systemPrompt([{ id: 'auth', name: 'Auth' }], false, true),
      systemPrompt([{ id: 'auth', name: 'Auth' }], true, false),
    ].map(sha)).toEqual([
      'f09138538d17fa647a6ea70d50521f9c7ed150f23aa93c31ece7b07dfcaeaa03',
      '14a64853f6a817d8f051c27d85585daf651997b662be022969f4fa44cce16578',
      'f4acfc2a482f426abef20f9a8856526ed25a7ee3b035ff36afc5f1f385b0fd94',
      '5bbcea362aaee6bfdd90d607128d036632502f63e7641279c49c7f110f0b4035',
    ]);
  });

  it("names every tool the way the engine's names say, and none of Claude's, in the prompt the gate hands an agent", async () => {
    const names: PromptNames = { idecore: (tool) => `idecore_${tool}`, writeTools: 'edit, write', exploreTools: 'grep, glob or exploring bash command' };
    const store = openStore(tempDir('ide-store-'));
    const runtime = createGateRuntime({
      root: tempDir('ide-root-'), home: tempDir('ide-home-'), store, policy: () => DEFAULT_POLICY, components: () => [], port: () => 0,
      map: () => null, search: () => Promise.reject(new Error('not searched')),
    });
    onTestFinished(async () => {
      await runtime.close();
      store.close();
    });
    const prompt = runtime.sessionGate.systemPrompt(names);
    expect([...prompt.matchAll(/idecore_\w+/g)].map(([name]) => name))
      .toEqual(['idecore_map_overview', 'idecore_propose_plan', 'idecore_step', 'idecore_map_component', 'idecore_search_code', 'idecore_set_chat_title']);
    expect([prompt.includes('mcp__'), prompt.includes('NotebookEdit'), prompt.includes('(edit, write, or a shell command'), prompt.includes('Before your first grep, glob or exploring bash command')])
      .toEqual([false, false, true, true]);
  });
});

describe('opencodeSystem', () => {
  it('puts the gate prompt first, then the rules, then each project instruction file under its path, cut at the limit with a note and never inside a character', () => {
    const text = opencodeSystem('PROMPT', [{ path: 'AGENTS.md', text: 'a'.repeat(MAX_PROJECT_INSTRUCTIONS) }, { path: 'CLAUDE.md', text: 'rules' }]);
    const wide = opencodeSystem(null, [{ path: 'AGENTS.md', text: 'é'.repeat(MAX_PROJECT_INSTRUCTIONS) }]);
    expect([
      text.startsWith(`PROMPT\n\n${OPENCODE_RULES}\n\n## AGENTS.md\naaa`), text.includes('## CLAUDE.md'), text.endsWith('a\n(project instructions cut at 64 KB)'),
      wide.startsWith(`${OPENCODE_RULES}\n\n## AGENTS.md\né`), wide.endsWith('é\n(project instructions cut at 64 KB)'),
      opencodeSystem(null, [{ path: 'AGENTS.md', text: 'short' }, { path: 'CLAUDE.md', text: 'rules' }]) === `${OPENCODE_RULES}\n\n## AGENTS.md\nshort\n\n## CLAUDE.md\nrules`,
    ]).toEqual([true, false, true, true, true, true]);
  });
});
