import { describe, expect, it } from 'vitest';
import { formatModelId, isEffortFor, parseModelId } from '@ide/protocol';

describe('parseModelId', () => {
  it.each([
    ['sonnet', { engine: 'claude', model: 'sonnet' }],
    ['claude-sonnet-5[1m]', { engine: 'claude', model: 'claude-sonnet-5[1m]' }],
    ['us.anthropic.model-v1:0', { engine: 'claude', model: 'us.anthropic.model-v1:0' }],
    ['codex:gpt-6-luna', { engine: 'codex', model: 'gpt-6-luna' }],
    ['opencode:opencode/nemotron-3.5-lightning-free', { engine: 'opencode', model: 'opencode/nemotron-3.5-lightning-free' }],
    ['opencode:openrouter/anthropic/claude-3.5:beta', { engine: 'opencode', model: 'openrouter/anthropic/claude-3.5:beta' }],
    ['opencode:ollama/qwen2.5-coder:32b', { engine: 'opencode', model: 'ollama/qwen2.5-coder:32b' }],
  ])('reads %s as %o', (id, ref) => {
    expect(parseModelId(id)).toEqual(ref);
  });

  it("keeps Claude's argv-safe rule: no leading dash, dot, colon or bracket, no spaces, shell characters, slashes or non-ASCII, at most 64 characters", () => {
    const bad = ['', '-x', '--evil', '.hidden', '[1m]', ':x', 'opus 4', 'opus\n', 'opus;ls', '$(id)', 'a/b', "o'pus", 'opuś', 'a'.repeat(65)];
    expect([bad.filter((id) => parseModelId(id) !== null), parseModelId('a'.repeat(64))]).toEqual([[], { engine: 'claude', model: 'a'.repeat(64) }]);
  });

  it('refuses a prefixed id without its model, an opencode id without a provider or a model, and spaces, control characters or 129 characters in either', () => {
    const bad = ['codex:', 'codex:gpt 6', 'codex:gpt\n', `codex:${'a'.repeat(129)}`, 'opencode:', 'opencode:nemotron', 'opencode:/nemotron', 'opencode:opencode/', 'opencode:open code/x', 'opencode:p/m odel'];
    expect(bad.filter((id) => parseModelId(id) !== null)).toEqual([]);
  });

  it("never reads an id with an engine's prefix as a Claude model, even one Claude's rule would accept", () => {
    expect([parseModelId('codex:-x'), parseModelId('opencode:x')]).toEqual([null, null]);
  });
});

describe('formatModelId', () => {
  it('gives back the id it was read from, for every engine', () => {
    const ids = ['sonnet', 'us.anthropic.model-v1:0', 'codex:gpt-6-luna', 'opencode:openrouter/anthropic/claude-3.5:beta'];
    expect(ids.map((id) => formatModelId(parseModelId(id)!))).toEqual(ids);
  });
});

describe('isEffortFor', () => {
  it("takes only Claude's five levels for Claude, and a lowercase name of at most 32 characters for the other engines", () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'HIGH', '', 'ultra'].map((effort) => isEffortFor('claude', effort)))
      .toEqual([true, true, true, true, true, false, false, false, false]);
    expect(['minimal', 'high', 'x-high_2', 'HIGH', '', ' high', 'a'.repeat(33)].map((effort) => isEffortFor('codex', effort)))
      .toEqual([true, true, true, false, false, false, false]);
  });
});
