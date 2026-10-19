import type { EngineStatus, ModelInfo } from '@ide/protocol';

// The three engines as the popover will meet them once Codex and opencode exist: Codex signed out, opencode too old.
export const THREE_ENGINES: ModelInfo[] = [
  { value: 'sonnet', name: 'Sonnet 5.5', engine: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', name: 'Haiku 4.5', engine: 'claude', efforts: [] },
  { value: 'codex:gpt-6-luna', name: 'GPT-6 Luna', engine: 'codex', efforts: ['minimal', 'low', 'medium', 'high'] },
  { value: 'opencode:opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', engine: 'opencode', efforts: [] },
  { value: 'opencode:openrouter/anthropic/claude-3.5:beta', name: 'Claude 3.5 (OpenRouter)', engine: 'opencode', efforts: ['high'] },
];

export const ENGINE_STATES: EngineStatus[] = [
  { engine: 'claude', state: 'ready', hint: null },
  { engine: 'codex', state: 'signed-out', hint: 'Sign in: run codex login' },
  { engine: 'opencode', state: 'old', hint: 'Update to ≥ 1.19' },
];
