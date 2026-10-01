import {
  EFFORT_LEVELS, IMAGE_MEDIA_TYPES, MAX_CHAT_IMAGES,
  type ChatImage, type ClientMessage, type EffortLevel, type FileAnswer, type FileHashes, type McpEntry, type McpLevel, type PlanAnswer, type Policy, type PromptAnswer,
  type WatchdogAnswer,
} from '@ide/protocol';
import { isModelChoice } from '../agent/tools';
import { isRecord } from '../json';
import { MAX_TERMINAL_INPUT, TERMINAL_ID } from '../terminal/terminal-service';

const MAX_TITLE_LENGTH = 200;

const isLevel = (value: unknown): value is McpLevel => value === 'ide' || value === 'project';

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const {
    type, text, requestId, answer, level, name, entry, previousName, entryHash, fileHashes, policy, hashes, planId, version, promptId, eventId, path, before,
    after, revertId, stepKey, confirm, id, modelChoice, effort, cols, rows, data, images, title,
  } = value;
  switch (type) {
    case 'chat.send':
      if (typeof text !== 'string') return null;
      if (images === undefined) return { type, text };
      return isImageList(images) ? { type, text, images } : null;
    case 'chat.stop':
    case 'session.restart':
    case 'session.new':
    case 'session.list':
    case 'models.list':
    case 'session.delete-all':
    case 'map.regroup':
    case 'settings.get':
      return { type };
    case 'session.rename':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && typeof title === 'string' && title.trim() !== '' && title.length <= MAX_TITLE_LENGTH ? { type, id, title } : null;
    case 'task.stop':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.delete':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.switch':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.configure':
      return (modelChoice === null || (typeof modelChoice === 'string' && isModelChoice(modelChoice))) && (effort === null || isEffort(effort))
        ? { type, modelChoice, effort }
        : null;
    case 'prompt.answer': {
      const parsed = parseAnswer(answer);
      return typeof requestId === 'string' && parsed ? { type, requestId, answer: parsed } : null;
    }
    case 'plan.answer': {
      const parsed = parsePlanAnswer(answer);
      return typeof planId === 'string' && typeof version === 'number' && Number.isInteger(version) && version >= 1 && parsed ? { type, planId, version, answer: parsed } : null;
    }
    case 'gate.answer':
      return typeof promptId === 'string' && (answer === 'allow-once' || answer === 'expand-plan' || answer === 'deny') ? { type, promptId, answer } : null;
    case 'watchdog.answer': {
      const parsed = parseWatchdogAnswer(answer);
      return typeof eventId === 'string' && parsed ? { type, eventId, answer: parsed } : null;
    }
    case 'watchdog.stop-agent':
      return typeof eventId === 'string' ? { type, eventId } : null;
    case 'terminal.open':
      return isTerminalId(id) && isInteger(cols) && isInteger(rows) ? { type, id, cols, rows } : null;
    case 'terminal.resize':
      return isTerminalId(id) && isInteger(cols) && isInteger(rows) ? { type, id, cols, rows } : null;
    case 'terminal.input':
      return isTerminalId(id) && typeof data === 'string' && data.length <= MAX_TERMINAL_INPUT ? { type, id, data } : null;
    case 'terminal.close':
      return isTerminalId(id) ? { type, id } : null;
  }
  if (typeof requestId !== 'string') return null;
  switch (type) {
    // McpRegistry.save validates the entry itself before storing it.
    case 'mcp.save':
      return isLevel(level) && typeof name === 'string' && (previousName === null || typeof previousName === 'string') && isRecord(entry)
        ? { type, requestId, level, name, entry: entry as unknown as McpEntry, previousName }
        : null;
    case 'mcp.remove':
      return isLevel(level) && typeof name === 'string' ? { type, requestId, level, name } : null;
    case 'mcp.approve':
      return typeof name === 'string' && typeof entryHash === 'string' ? { type, requestId, name, entryHash } : null;
    case 'mcp.confirm-external-edits':
      return isFileHashes(fileHashes) ? { type, requestId, fileHashes } : null;
    case 'policy.save':
      return isLevel(level) && isRecord(policy) ? { type, requestId, level, policy: policy as Partial<Policy> } : null;
    case 'policy.confirm-external-edits':
      return isRecord(hashes) && typeof hashes.ide === 'string' && typeof hashes.project === 'string'
        ? { type, requestId, hashes: { ide: hashes.ide, project: hashes.project } }
        : null;
    case 'fs.list':
      return path === null || typeof path === 'string' ? { type, requestId, path } : null;
    case 'project.open':
      return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LENGTH ? { type, requestId, path } : null;
    case 'history.diff':
      return typeof path === 'string' && isHashOrNull(before) && isHashOrNull(after) ? { type, requestId, path, before, after } : null;
    case 'revert.undo':
      return typeof revertId === 'string' ? { type, requestId, revertId } : null;
    case 'step.rollback-preview':
      return typeof planId === 'string' && typeof stepKey === 'string' ? { type, requestId, planId, stepKey } : null;
    case 'step.rollback':
      return typeof planId === 'string' && typeof stepKey === 'string' && isConfirmList(confirm) ? { type, requestId, planId, stepKey, confirm } : null;
    default:
      return null;
  }
}

function isFileHashes(value: unknown): value is FileHashes {
  return isRecord(value) && typeof value.ideServers === 'string' && typeof value.trust === 'string';
}

function parseAnswer(value: unknown): PromptAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'allow') return { kind: 'allow' };
  if (value.kind === 'deny') return typeof value.feedback === 'string' ? { kind: 'deny', feedback: value.feedback } : null;
  const answers = value.answers;
  if (value.kind !== 'answers' || !isRecord(answers) || !Object.values(answers).every((item) => typeof item === 'string')) return null;
  return { kind: 'answers', answers: answers as Record<string, string> };
}

function parsePlanAnswer(value: unknown): PlanAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'approve') return { kind: 'approve' };
  if ((value.kind === 'changes' || value.kind === 'reject') && typeof value.feedback === 'string') return { kind: value.kind, feedback: value.feedback };
  return null;
}

const MAX_CONFIRM_FILES = 5000;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LENGTH = 100;

const isImageList = (value: unknown): value is ChatImage[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_CHAT_IMAGES && value.every((item) =>
    isRecord(item) && IMAGE_MEDIA_TYPES.includes(item.mediaType as ChatImage['mediaType']) && typeof item.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data));

const isEffort = (value: unknown): value is EffortLevel => EFFORT_LEVELS.includes(value as EffortLevel);

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const isTerminalId = (value: unknown): value is string => typeof value === 'string' && TERMINAL_ID.test(value);

const isHashOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isConfirmList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_CONFIRM_FILES && value.every((item) => typeof item === 'string');

const isFileAnswer = (value: unknown): value is FileAnswer => value === 'keep' || value === 'revert' || value === 'mine';

function parseWatchdogAnswer(value: unknown): WatchdogAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'all') return isFileAnswer(value.answer) || value.answer === 'expand-plan' ? { kind: 'all', answer: value.answer } : null;
  if (value.kind === 'files' && isRecord(value.files) && Object.values(value.files).every(isFileAnswer)) {
    return { kind: 'files', files: value.files as Record<string, FileAnswer> };
  }
  return null;
}
