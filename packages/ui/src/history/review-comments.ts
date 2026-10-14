import { anchorKey, type Side } from './diff-rows';

export interface ReviewComment {
  id: string;
  path: string;
  side: Side;
  line: number;
  // The text of the line when the comment was written: a comment follows its line only while the line is unchanged.
  quote: string;
  text: string;
  at: number;
  sentAt: number | null;
}

export type NewComment = Pick<ReviewComment, 'path' | 'side' | 'line' | 'quote' | 'text'>;

export const MAX_COMMENT = 4000;

// Cuts to `max` UTF-16 units without leaving half of a surrogate pair behind.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function addComment(comments: ReviewComment[], draft: NewComment, id: string, at: number): ReviewComment[] {
  const text = clip(draft.text.trim(), MAX_COMMENT);
  if (text === '') return comments;
  return [...comments, { ...draft, text, id, at, sentAt: null }];
}

export function editComment(comments: ReviewComment[], id: string, text: string): ReviewComment[] {
  const next = clip(text.trim(), MAX_COMMENT);
  if (next === '') return removeComment(comments, id);
  return comments.map((comment) => (comment.id === id ? { ...comment, text: next } : comment));
}

export const removeComment = (comments: ReviewComment[], id: string): ReviewComment[] => comments.filter((comment) => comment.id !== id);

export const unsent = (comments: ReviewComment[]): ReviewComment[] => comments.filter((comment) => comment.sentAt === null);

export const commentsOf = (comments: ReviewComment[], path: string): ReviewComment[] => comments.filter((comment) => comment.path === path);

export const markSent = (comments: ReviewComment[], ids: string[], at: number): ReviewComment[] => {
  const sent = new Set(ids);
  return comments.map((comment) => (sent.has(comment.id) ? { ...comment, sentAt: at } : comment));
};

// A decision on a file settles its comments.
export const dropFor = (comments: ReviewComment[], paths: string[]): ReviewComment[] => comments.filter((comment) => !paths.includes(comment.path));

export const filesWith = (comments: ReviewComment[]): string[] => [...new Set(comments.map((comment) => comment.path))];

export interface Anchored {
  inline: Map<string, ReviewComment[]>;
  outdated: ReviewComment[];
}

export function anchorComments(comments: ReviewComment[], texts: ReadonlyMap<string, string>): Anchored {
  const inline = new Map<string, ReviewComment[]>();
  const outdated: ReviewComment[] = [];
  for (const comment of comments) {
    const key = anchorKey(comment.side, comment.line);
    if (texts.get(key) === comment.quote) inline.set(key, [...(inline.get(key) ?? []), comment]);
    else outdated.push(comment);
  }
  return { inline, outdated };
}

const QUOTE_MAX = 80;
const quoted = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > QUOTE_MAX ? `${clip(trimmed, QUOTE_MAX)}…` : trimmed;
};

const indent = (text: string): string => text.split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n');

// One message for the agent: where each comment is (path:line, and the line itself in case numbers have moved) and what it asks.
export function formatRequest(comments: ReviewComment[]): string {
  const files = filesWith(comments);
  const header = `I reviewed your changes and need these fixes (${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} on ${files.length} ${files.length === 1 ? 'file' : 'files'}):`;
  const body = files.map((path) => {
    const own = commentsOf(comments, path).sort((a, b) => a.line - b.line);
    const lines = own.map((comment) => {
      const where = comment.side === 'old' ? `${path}:${comment.line} (a line you removed)` : `${path}:${comment.line}`;
      return `- ${where}${comment.quote.trim() === '' ? '' : `  \`${quoted(comment.quote)}\``}\n  ${indent(comment.text)}`;
    });
    return lines.join('\n');
  });
  return `${header}\n\n${body.join('\n\n')}\n\nPlease make these changes and leave everything else as it is.`;
}

const isComment = (value: unknown): value is ReviewComment => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.path === 'string' && (v.side === 'old' || v.side === 'new') && typeof v.line === 'number'
    && typeof v.quote === 'string' && typeof v.text === 'string' && typeof v.at === 'number' && (v.sentAt === null || typeof v.sentAt === 'number');
};

const key = (root: string): string => `ide.review.comments.${root}`;

export function loadComments(storage: Pick<Storage, 'getItem'> | undefined, root: string): ReviewComment[] {
  try {
    const raw = storage?.getItem(key(root));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter(isComment) : [];
  } catch {
    return [];
  }
}

export function saveComments(storage: Pick<Storage, 'setItem'> | undefined, root: string, comments: ReviewComment[]): void {
  try {
    storage?.setItem(key(root), JSON.stringify(comments));
  } catch {
    // storage unavailable or full: comments only last for this session
  }
}
