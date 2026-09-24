import type { ClientMessage, PromptAnswer } from '@ide/protocol';
import { isRecord } from '../json';

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { type, text, requestId, answer } = value;
  switch (type) {
    case 'chat.send':
      return typeof text === 'string' ? { type, text } : null;
    case 'chat.stop':
    case 'session.restart':
    case 'session.new':
      return { type };
    case 'prompt.answer': {
      const parsed = parseAnswer(answer);
      return typeof requestId === 'string' && parsed ? { type, requestId, answer: parsed } : null;
    }
    default:
      return null;
  }
}

function parseAnswer(value: unknown): PromptAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'allow') return { kind: 'allow' };
  if (value.kind === 'deny') return typeof value.feedback === 'string' ? { kind: 'deny', feedback: value.feedback } : null;
  const answers = value.answers;
  if (value.kind !== 'answers' || !isRecord(answers) || !Object.values(answers).every((item) => typeof item === 'string')) return null;
  return { kind: 'answers', answers: answers as Record<string, string> };
}
