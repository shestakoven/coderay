import { ENGINE_PRODUCT_NAMES, type BackgroundAiStatus, type EngineState, type EngineStatus } from '@ide/protocol';

export const ENGINE_STATE_LABEL: Record<EngineState, string> = { ready: 'Ready', missing: 'Not installed', old: 'Update needed', 'signed-out': 'Signed out', error: 'Error' };

export const stateLabel = (status: EngineStatus | null): string => (status === null ? 'Checking…' : ENGINE_STATE_LABEL[status.state]);

export const LIMITS_NOTE = "Background calls use the chosen engine's account and its limits.";

const OFF_HERE = 'Background AI is off. No background calls are made; new groupings, summaries and overviews wait until you turn it on.';

// The core joins one line per engine with " · "; an engine's own reason may hold " · " too, so only a product name starts a line.
const perEngine = (text: string): string[] => text.split(new RegExp(` · (?=(?:${Object.values(ENGINE_PRODUCT_NAMES).join('|')})\\b)`));

/** The status line of Settings → Background AI: the engine only, never the model, one line per engine, and no "in Settings" while the reader is there. */
export function statusLine(status: BackgroundAiStatus): { tone: 'ok' | 'warn' | 'muted'; text: string; details: string[] } {
  if (status.state === 'checking') return { tone: 'muted', text: 'Checking the engines…', details: [] };
  if (status.state === 'ready') return { tone: 'ok', text: `Ready · ${ENGINE_PRODUCT_NAMES[status.engine]}`, details: status.note === null ? [] : perEngine(status.note) };
  if (status.reason === 'choice') return { tone: 'muted', text: OFF_HERE, details: [] };
  const lines = perEngine(status.hint.replace(/ in Settings → Background AI(?=\.)/g, ''));
  if (lines.length === 1) return { tone: status.reason === 'unavailable' ? 'warn' : 'muted', text: lines[0]!, details: [] };
  return { tone: 'muted', text: 'No engine can run the background AI right now.', details: lines };
}
