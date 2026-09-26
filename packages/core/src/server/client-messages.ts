import type { ClientMessage, FileHashes, McpEntry, McpLevel, Policy, PromptAnswer } from '@ide/protocol';
import { isRecord } from '../json';

const isLevel = (value: unknown): value is McpLevel => value === 'ide' || value === 'project';

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { type, text, requestId, answer, level, name, entry, previousName, entryHash, fileHashes, policy, hashes } = value;
  switch (type) {
    case 'chat.send':
      return typeof text === 'string' ? { type, text } : null;
    case 'chat.stop':
    case 'session.restart':
    case 'session.new':
    case 'settings.get':
      return { type };
    case 'prompt.answer': {
      const parsed = parseAnswer(answer);
      return typeof requestId === 'string' && parsed ? { type, requestId, answer: parsed } : null;
    }
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
