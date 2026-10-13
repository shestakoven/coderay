import { EFFORT_LEVELS, formatModelId, isClaudeEffort, type ModelInfo } from '@ide/protocol';
import { startClaude, type ClaudeCommand } from '../agent/claude-process';
import { isRecord, parseJson } from '../json';

const REQUEST_ID = 'models';
const TIMEOUT_MS = 30_000;

export function parseModels(line: string): ModelInfo[] | null {
  const message = parseJson(line);
  if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) return null;
  const body = isRecord(message.response.response) ? message.response.response : null;
  if (message.response.request_id !== REQUEST_ID || !body) return null;
  const models = Array.isArray(body.models) ? body.models : [];
  return models.flatMap((model): ModelInfo[] => {
    if (!isRecord(model) || typeof model.value !== 'string' || typeof model.displayName !== 'string') return [];
    // "default" is the CLI's own pick, shown under whatever it resolves to; the user chooses explicitly.
    if (model.value === 'default') return [];
    const named = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && isClaudeEffort(level))
      : null;
    return [{ value: formatModelId({ engine: 'claude', model: model.value }), name: model.displayName, engine: 'claude', efforts: named ?? [...EFFORT_LEVELS] }];
  });
}

export async function fetchModels(claude: ClaudeCommand, cwd: string, timeoutMs = TIMEOUT_MS): Promise<ModelInfo[]> {
  let found: ModelInfo[] | null = null;
  let done: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    done = resolve;
  });
  const child = startClaude(
    claude,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    cwd,
    (line) => {
      const models = parseModels(line);
      if (!models) return;
      found = models;
      done();
    },
  );
  const timer = setTimeout(done, timeoutMs);
  child.write({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } });
  await Promise.race([answered, child.exited]);
  clearTimeout(timer);
  await child.kill();
  return found ?? [];
}
