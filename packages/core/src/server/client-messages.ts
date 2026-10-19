import {
  AGENT_TERMINAL_ID, API_KEY_PATTERN, ENGINE_IDS, IMAGE_MEDIA_TYPES, isEffortFor, isEngineId, LOGIN_METHODS, MAX_CHAT_IMAGES, MAX_REVIEW_GRAPH_FILES, parseModelId,
  type ChatImage, type ClientMessage, type EngineId, type FileAnswer, type FileHashes, type McpEntry, type McpLevel, type PlanAnswer, type LoginMethod, type Policy, type PromptAnswer,
  type ReviewGraphFile, type WatchdogAnswer,
} from '@ide/protocol';
import { isAccountId } from '../accounts/account-store';
import { BLOB_ID } from '../images/blob-store';
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
    after, revertId, changeIds, stepKey, confirm, id, ids, modelChoice, effort, cols, rows, kind, data, images, title, parent, url, code, paths, side, message, key, files,
    engine, method, apiKey, providerID,
  } = value;
  switch (type) {
    case 'chat.send':
      if (typeof text !== 'string') return null;
      if (images === undefined) return { type, text };
      return isImageList(images) ? { type, text, images } : null;
    case 'chat.stop':
    case 'session.restart':
    case 'session.list':
    case 'models.list':
    case 'session.delete-all':
    case 'map.regroup':
    case 'map.overview':
    case 'settings.get':
    case 'git.refresh':
      return { type };
    case 'session.rename':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && typeof title === 'string' && title.trim() !== '' && title.length <= MAX_TITLE_LENGTH ? { type, id, title } : null;
    case 'task.stop':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.delete':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.switch':
      return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? { type, id } : null;
    case 'session.configure': {
      const pick = parsePick(modelChoice, effort);
      return pick ? { type, ...pick } : null;
    }
    case 'session.new': {
      if (modelChoice === undefined && effort === undefined) return { type };
      const pick = typeof modelChoice === 'string' ? parsePick(modelChoice, effort ?? null) : null;
      return pick && pick.modelChoice !== null ? { type, modelChoice: pick.modelChoice, effort: pick.effort } : null;
    }
    case 'image.get':
      if (!isBoundedString(key, MAX_PATH_LENGTH)) return null;
      if (id !== undefined) return path === undefined && typeof id === 'string' && BLOB_ID.test(id) ? { type, key, id } : null;
      return isBoundedString(path, MAX_PATH_LENGTH) ? { type, key, path } : null;
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
      if (!isTerminalId(id) || !isInteger(cols) || !isInteger(rows)) return null;
      if (kind === 'agent') return id === AGENT_TERMINAL_ID ? { type, id, cols, rows, kind } : null;
      return (kind === undefined || kind === 'shell') && id !== AGENT_TERMINAL_ID ? { type, id, cols, rows } : null;
    case 'terminal.resize':
      return isTerminalId(id) && isInteger(cols) && isInteger(rows) ? { type, id, cols, rows } : null;
    case 'terminal.input':
      return isTerminalId(id) && typeof data === 'string' && data.length <= MAX_TERMINAL_INPUT ? { type, id, data } : null;
    case 'terminal.close':
      return isTerminalId(id) ? { type, id } : null;
    case 'hub.activate':
      return isBoundedString(id, MAX_ID_LENGTH) ? { type, id } : null;
    case 'hub.order':
      return Array.isArray(ids) && ids.length <= MAX_HUB_IDS && ids.every((item) => isBoundedString(item, MAX_ID_LENGTH)) ? { type, ids } : null;
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
    case 'project.create':
      return isBoundedString(parent, MAX_PATH_LENGTH) && isBoundedString(name, MAX_NAME_LENGTH) ? { type, requestId, parent, name } : null;
    case 'project.clone':
      return isBoundedString(url, MAX_URL_LENGTH) && isBoundedString(parent, MAX_PATH_LENGTH) && (name === null || isBoundedString(name, MAX_NAME_LENGTH))
        ? { type, requestId, url, parent, name }
        : null;
    case 'project.clone.cancel':
    case 'project.close':
    case 'account.login.cancel':
      return { type, requestId };
    case 'account.login.start': {
      const target = loginTarget(engine, method, apiKey);
      return target ? { type, requestId, ...target } : null;
    }
    case 'account.login.code':
      return typeof code === 'string' && code.length <= MAX_CODE_LENGTH && code.trim() !== '' ? { type, requestId, code: code.trim() } : null;
    case 'account.select':
      return (id === null || isAccountId(id)) && isEngineOrNone(engine) ? { type, requestId, ...(engine === undefined ? {} : { engine }), id } : null;
    case 'account.remove':
      return isAccountId(id) && isEngineOrNone(engine) ? { type, requestId, ...(engine === undefined ? {} : { engine }), id } : null;
    case 'account.providers':
      return isAccountId(id) ? { type, requestId, id } : null;
    case 'account.provider.set':
      return isAccountId(id) && isProviderId(providerID) && isRuledText(apiKey) ? { type, requestId, id, providerID, apiKey } : null;
    case 'account.provider.remove':
      return isAccountId(id) && isProviderId(providerID) ? { type, requestId, id, providerID } : null;
    case 'hub.close':
    case 'hub.restart':
      return isBoundedString(id, MAX_ID_LENGTH) ? { type, requestId, id } : null;
    case 'history.diff':
      return typeof path === 'string' && isHashOrNull(before) && isHashOrNull(after) ? { type, requestId, path, before, after } : null;
    case 'review.graph':
      return (planId === null || isBoundedString(planId, MAX_ID_LENGTH)) && isGraphFiles(files) ? { type, requestId, planId, files } : null;
    case 'revert.undo':
      return typeof revertId === 'string' ? { type, requestId, revertId } : null;
    case 'change.revert':
      return isConfirmList(changeIds) && changeIds.length > 0 ? { type, requestId, changeIds } : null;
    case 'step.rollback-preview':
      return typeof planId === 'string' && typeof stepKey === 'string' ? { type, requestId, planId, stepKey } : null;
    case 'step.rollback':
      return typeof planId === 'string' && typeof stepKey === 'string' && isConfirmList(confirm) ? { type, requestId, planId, stepKey, confirm } : null;
    case 'git.init':
    case 'git.branches':
      return { type, requestId };
    case 'git.diff':
      return isBoundedString(path, MAX_PATH_LENGTH) && (side === 'staged' || side === 'unstaged') ? { type, requestId, path, side } : null;
    case 'git.stage':
    case 'git.unstage':
      return paths === 'all' || isGitPaths(paths) ? { type, requestId, paths } : null;
    case 'git.discard':
      return isGitPaths(paths) ? { type, requestId, paths } : null;
    case 'git.commit':
      return typeof message === 'string' && message.trim() !== '' && message.length <= MAX_COMMIT_MESSAGE ? { type, requestId, message } : null;
    case 'git.branch-create':
    case 'git.branch-switch':
    case 'git.branch-delete':
      return isBoundedString(name, MAX_BRANCH_NAME) ? { type, requestId, name } : null;
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

// A model of its engine and an effort that engine names; with no model the chat's engine decides, which only the session knows.
function parsePick(modelChoice: unknown, effort: unknown): { modelChoice: string | null; effort: string | null } | null {
  if ((modelChoice !== null && typeof modelChoice !== 'string') || (effort !== null && typeof effort !== 'string')) return null;
  const engine = modelChoice === null ? null : parseModelId(modelChoice)?.engine;
  if (engine === undefined) return null;
  if (effort !== null && !(engine === null ? ENGINE_IDS.some((id) => isEffortFor(id, effort)) : isEffortFor(engine, effort))) return null;
  return { modelChoice, effort };
}

const isEngineOrNone = (value: unknown): value is EngineId | undefined => value === undefined || isEngineId(value);

// opencode's provider ids are catalog slugs; one that is a path or a path's parts never reaches `/auth/:id`.
const isProviderId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,99}$/.test(value);

// A profile name or a provider key the core judges itself, answering one it refuses with its rule; bounded here only.
const isRuledText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_RULED_TEXT;

// A key goes only with the API-key way, and never into a log line; a profile's name rides in its slot.
function loginTarget(engine: unknown, method: unknown, apiKey: unknown): { engine?: EngineId; method?: LoginMethod; apiKey?: string } | null {
  if (!isEngineOrNone(engine)) return null;
  if (method !== undefined && !LOGIN_METHODS[engine ?? 'claude'].includes(method as LoginMethod)) return null;
  if (method === 'profile') return isRuledText(apiKey) ? { engine, method, apiKey: apiKey.trim() } : null;
  if ((method === 'api-key') !== (apiKey !== undefined)) return null;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !API_KEY_PATTERN.test(apiKey))) return null;
  return {
    ...(engine === undefined ? {} : { engine }),
    ...(method === undefined ? {} : { method: method as LoginMethod }),
    ...(apiKey === undefined ? {} : { apiKey: apiKey as string }),
  };
}

function parsePlanAnswer(value: unknown): PlanAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'approve' || value.kind === 'accept') return { kind: value.kind };
  if ((value.kind === 'changes' || value.kind === 'reject') && typeof value.feedback === 'string') return { kind: value.kind, feedback: value.feedback };
  return null;
}

const MAX_CONFIRM_FILES = 5000;
const MAX_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 1024;
const MAX_ID_LENGTH = 100;
const MAX_CODE_LENGTH = 4096;
// Longer than any rule allows, so a name or key over its rule's length gets the rule's answer.
const MAX_RULED_TEXT = 4096;
const MAX_HUB_IDS = 100;
const MAX_GIT_PATHS = 5000;
const MAX_COMMIT_MESSAGE = 100_000;
const MAX_BRANCH_NAME = 255;

const isImageList = (value: unknown): value is ChatImage[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_CHAT_IMAGES && value.every((item) =>
    isRecord(item) && IMAGE_MEDIA_TYPES.includes(item.mediaType as ChatImage['mediaType']) && typeof item.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data));

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const isBoundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

const isTerminalId = (value: unknown): value is string => typeof value === 'string' && TERMINAL_ID.test(value);

const isHashOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isGraphFile = (value: unknown): value is ReviewGraphFile =>
  isRecord(value)
  && isBoundedString(value.path, MAX_PATH_LENGTH)
  && isHashOrNull(value.before)
  && isHashOrNull(value.after)
  && (value.step === null || isBoundedString(value.step, MAX_ID_LENGTH))
  && typeof value.external === 'boolean'
  && Number.isSafeInteger(value.added)
  && Number.isSafeInteger(value.removed);

const isGraphFiles = (value: unknown): value is ReviewGraphFile[] =>
  Array.isArray(value) && value.length <= MAX_REVIEW_GRAPH_FILES && value.every(isGraphFile);

const isGitPaths = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_GIT_PATHS && value.every((item) => isBoundedString(item, MAX_PATH_LENGTH));

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
