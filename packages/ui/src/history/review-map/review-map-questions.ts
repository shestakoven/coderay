import type { ReviewGraph } from '@ide/protocol';
import { targetKey, type Target } from './review-map-model';

export interface MapQuestion {
  id: string;
  target: Target;
  title: string;
  where: string;
  text: string;
  at: number;
  sentAt: number | null;
}

export const MAX_QUESTION = 4000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const same = (a: Target, b: Target): boolean => targetKey(a) === targetKey(b);

export function saveQuestion(list: MapQuestion[], draft: { target: Target; title: string; where: string; text: string }, id: string, at: number): MapQuestion[] {
  const rest = list.filter((question) => !(question.sentAt === null && same(question.target, draft.target)));
  const text = clip(draft.text.trim(), MAX_QUESTION);
  return text === '' ? rest : [...rest, { ...draft, text, id, at, sentAt: null }];
}

export const removeQuestion = (list: MapQuestion[], id: string): MapQuestion[] => list.filter((question) => question.id !== id);
export const unsentQuestions = (list: MapQuestion[]): MapQuestion[] => list.filter((question) => question.sentAt === null);

export function markAsked(list: MapQuestion[], ids: string[], at: number): MapQuestion[] {
  const asked = new Set(ids);
  return list.map((question) => (asked.has(question.id) ? { ...question, sentAt: at } : question));
}

// The newest question about a target, asked or not.
export const questionFor = (list: MapQuestion[], target: Target): MapQuestion | undefined =>
  [...list].reverse().find((question) => same(question.target, target));

export function outdated(list: MapQuestion[], graph: ReviewGraph): MapQuestion[] {
  const parts = new Set(graph.parts.map((part) => part.id));
  const links = new Set(graph.links.map((link) => `${link.from}>${link.to}`));
  return list.filter((question) => (question.target.t === 'part' ? !parts.has(question.target.id) : !links.has(`${question.target.from}>${question.target.to}`)));
}

export function formatQuestions(list: MapQuestion[]): string {
  const count = list.length === 1 ? 'a question' : `${list.length} questions`;
  const body = list.map((question, index) => {
    const where = question.where === '' ? '' : ` (${question.where})`;
    return `${index + 1}. ${question.title}${where}\n${question.text.split('\n').map((line) => `   ${line}`).join('\n')}`;
  });
  return `I am reviewing your changes and have ${count} about them. Answer only: do not change any code.\n\n${body.join('\n\n')}`;
}

const isTarget = (value: unknown): value is Target => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.t === 'part' && typeof v.id === 'string') || (v.t === 'link' && typeof v.from === 'string' && typeof v.to === 'string');
};

const isQuestion = (value: unknown): value is MapQuestion => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && isTarget(v.target) && typeof v.title === 'string' && typeof v.where === 'string'
    && typeof v.text === 'string' && typeof v.at === 'number' && (v.sentAt === null || typeof v.sentAt === 'number');
};

const keyOf = (root: string): string => `ide.review.questions.${root}`;

export function loadQuestions(storage: Pick<Storage, 'getItem'> | undefined, root: string): MapQuestion[] {
  try {
    const raw = storage?.getItem(keyOf(root));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter(isQuestion) : [];
  } catch {
    return [];
  }
}

export function persistQuestions(storage: Pick<Storage, 'setItem'> | undefined, root: string, list: MapQuestion[]): void {
  try {
    storage?.setItem(keyOf(root), JSON.stringify(list));
  } catch {
    // storage unavailable or full: questions only last for this session
  }
}
