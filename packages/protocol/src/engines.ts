import { EFFORT_LEVELS, type EffortLevel } from './session';

export type EngineId = 'claude' | 'codex' | 'opencode';

export const ENGINE_IDS: readonly EngineId[] = ['claude', 'codex', 'opencode'];

export const ENGINE_NAMES: Record<EngineId, string> = { claude: 'Claude', codex: 'Codex', opencode: 'opencode' };

export const isEngineId = (value: unknown): value is EngineId => ENGINE_IDS.includes(value as EngineId);

/** What an engine can do: the UI hides what it cannot, and the core skips the matching paths. */
export interface EngineCapabilities {
  slashCommands: boolean;
  transcriptRecovery: boolean;
  backgroundTasks: boolean;
  hardSandbox: boolean;
  terminalView: boolean;
}

export const ENGINE_CAPABILITIES: Record<EngineId, EngineCapabilities> = {
  claude: { slashCommands: true, transcriptRecovery: true, backgroundTasks: true, hardSandbox: false, terminalView: true },
  codex: { slashCommands: false, transcriptRecovery: false, backgroundTasks: false, hardSandbox: true, terminalView: false },
  opencode: { slashCommands: false, transcriptRecovery: false, backgroundTasks: false, hardSandbox: false, terminalView: false },
};

export type EngineState = 'ready' | 'missing' | 'old' | 'signed-out' | 'error';

export interface EngineStatus {
  engine: EngineId;
  state: EngineState;
  /** One line that tells the user what to do; null when the engine is ready. */
  hint: string | null;
  /** The active account's name, present once the engine has an account of CodeRay's: "System", or the account's e-mail and plan. */
  account?: string;
}

/** The engine, model and effort a chat runs with; a null model is claude's own default. */
export interface ChatPick {
  engine: EngineId;
  modelChoice: string | null;
  effort: string | null;
}

export interface ModelRef {
  engine: EngineId;
  /** The model as its engine names it: a Claude alias or id, a Codex model, or opencode's `<providerID>/<modelID>`. */
  model: string;
}

// Claude's model becomes an argv entry, so it must never start with '-' or carry anything but a model alias or id.
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/;
// Codex and opencode get the model inside JSON, never argv.
const ENGINE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/@+\-[\]]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODEX = 'codex:';
const OPENCODE = 'opencode:';

/** A bare id is Claude's, `codex:<model>` Codex's, `opencode:<providerID>/<modelID>` opencode's (split at the first `/`); null when the model is not valid for its engine. */
export function parseModelId(id: string): ModelRef | null {
  if (id.startsWith(CODEX)) {
    const model = id.slice(CODEX.length);
    return ENGINE_MODEL.test(model) ? { engine: 'codex', model } : null;
  }
  if (id.startsWith(OPENCODE)) {
    const model = id.slice(OPENCODE.length);
    const slash = model.indexOf('/');
    return slash > 0 && PROVIDER.test(model.slice(0, slash)) && ENGINE_MODEL.test(model.slice(slash + 1)) ? { engine: 'opencode', model } : null;
  }
  return CLAUDE_MODEL.test(id) ? { engine: 'claude', model: id } : null;
}

export const formatModelId = (ref: ModelRef): string => (ref.engine === 'claude' ? ref.model : `${ref.engine}:${ref.model}`);

export const isClaudeEffort = (effort: string): effort is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(effort);

// Codex and opencode name their own efforts (Codex's model list, an opencode model's variants).
const ENGINE_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

export const isEffortFor = (engine: EngineId, effort: string): boolean => (engine === 'claude' ? isClaudeEffort(effort) : ENGINE_EFFORT.test(effort));
