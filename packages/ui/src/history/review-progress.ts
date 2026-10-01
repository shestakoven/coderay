import type { ReviewFile, ReviewGroup } from './review-state';

// Path -> the "after" hash that was accepted (null = the file was deleted).
export type Reviewed = Record<string, string | null>;
export type FileStatus = 'pending' | 'reviewed' | 'updated';

export interface Position {
  group: string;
  path: string;
}

export function statusOf(reviewed: Reviewed, file: ReviewFile): FileStatus {
  if (!(file.path in reviewed)) return 'pending';
  return reviewed[file.path] === file.after ? 'reviewed' : 'updated';
}

export const accept = (reviewed: Reviewed, files: ReviewFile[]): Reviewed => ({ ...reviewed, ...Object.fromEntries(files.map((file) => [file.path, file.after])) });

export function progress(groups: ReviewGroup[], reviewed: Reviewed): { done: number; total: number } {
  const files = groups.flatMap((group) => group.files);
  return { done: files.filter((file) => statusOf(reviewed, file) === 'reviewed').length, total: files.length };
}

const flat = (groups: ReviewGroup[]): { position: Position; file: ReviewFile }[] =>
  groups.flatMap((group) => group.files.map((file) => ({ position: { group: group.key, path: file.path }, file })));

const same = (a: Position | null, b: Position): boolean => a !== null && a.group === b.group && a.path === b.path;

// The next file after `from` that still needs a decision, wrapping around; the first pending one when `from` is null.
export function nextPending(groups: ReviewGroup[], reviewed: Reviewed, from: Position | null): Position | null {
  const rows = flat(groups);
  const start = from ? rows.findIndex((row) => same(from, row.position)) : -1;
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(start + step + rows.length) % rows.length]!;
    if (statusOf(reviewed, row.file) !== 'reviewed') return row.position;
  }
  return null;
}

export function neighbor(groups: ReviewGroup[], from: Position | null, delta: 1 | -1): Position | null {
  const rows = flat(groups);
  if (rows.length === 0) return null;
  const at = from ? rows.findIndex((row) => same(from, row.position)) : -1;
  const next = at < 0 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  return rows[next]!.position;
}

const key = (root: string): string => `ide.review.${root}`;

export function loadReviewed(storage: Pick<Storage, 'getItem'> | undefined, root: string): Reviewed {
  try {
    const raw = storage?.getItem(key(root));
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, hash]) => hash === null || typeof hash === 'string')) as Reviewed;
  } catch {
    return {};
  }
}

export function saveReviewed(storage: Pick<Storage, 'setItem'> | undefined, root: string, reviewed: Reviewed): void {
  try {
    storage?.setItem(key(root), JSON.stringify(reviewed));
  } catch {
    // storage unavailable or full: decisions only last for this session
  }
}
