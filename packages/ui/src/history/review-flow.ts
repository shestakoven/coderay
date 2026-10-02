import type { ReviewFile } from './review-state';
import type { ReviewItem, ReviewSection } from './review-model';
import { sectionFiles } from './review-model';
import type { Reviewed } from './review-progress';

// Path -> the "after" hash the file had when changes were requested.
export type Requested = Record<string, string | null>;

// 'changed' and 'revised' are the open states a file falls back to when the agent edits it after a decision.
export type FileState = 'pending' | 'accepted' | 'requested' | 'reverted' | 'changed' | 'revised';

export const OPEN_STATES: readonly FileState[] = ['pending', 'changed', 'revised'];
export const isOpen = (state: FileState): boolean => OPEN_STATES.includes(state);

export function fileState(reviewed: Reviewed, requested: Requested, file: Pick<ReviewItem, 'path' | 'after' | 'reverted'>): FileState {
  if (file.reverted) return 'reverted';
  if (Object.hasOwn(reviewed, file.path)) return reviewed[file.path] === file.after ? 'accepted' : 'changed';
  if (Object.hasOwn(requested, file.path)) return requested[file.path] === file.after ? 'requested' : 'revised';
  return 'pending';
}

const without = <T,>(record: Record<string, T>, paths: string[]): Record<string, T> => {
  const drop = new Set(paths);
  return Object.fromEntries(Object.entries(record).filter(([path]) => !drop.has(path)));
};

export interface Decisions {
  reviewed: Reviewed;
  requested: Requested;
}

export function acceptFiles(decisions: Decisions, files: ReviewFile[]): Decisions {
  const paths = files.map((file) => file.path);
  return { reviewed: { ...decisions.reviewed, ...Object.fromEntries(files.map((file) => [file.path, file.after])) }, requested: without(decisions.requested, paths) };
}

export function undoAccept(decisions: Decisions, files: ReviewFile[]): Decisions {
  return { ...decisions, reviewed: without(decisions.reviewed, files.map((file) => file.path)) };
}

export function requestChanges(decisions: Decisions, files: ReviewFile[]): Decisions {
  const paths = files.map((file) => file.path);
  return { reviewed: without(decisions.reviewed, paths), requested: { ...decisions.requested, ...Object.fromEntries(files.map((file) => [file.path, file.after])) } };
}

export interface Tally {
  accepted: number;
  requested: number;
  reverted: number;
  open: number;
  total: number;
}

export function tally(sections: ReviewSection[], decisions: Decisions): Tally {
  const counts: Tally = { accepted: 0, requested: 0, reverted: 0, open: 0, total: 0 };
  for (const file of sectionFiles(sections)) {
    const state = fileState(decisions.reviewed, decisions.requested, file);
    counts.total++;
    if (state === 'accepted') counts.accepted++;
    else if (state === 'requested') counts.requested++;
    else if (state === 'reverted') counts.reverted++;
    else counts.open++;
  }
  return counts;
}

// The review is settled when nothing is waiting for the user: every file is accepted, reverted or sent back to the agent.
export const settled = (counts: Tally): boolean => counts.open === 0;

export interface Position {
  group: string;
  path: string;
}

const flat = (sections: ReviewSection[]): { position: Position; file: ReviewItem }[] =>
  sections.flatMap((section) => section.files.map((file) => ({ position: { group: section.key, path: file.path }, file })));

const same = (a: Position | null, b: Position): boolean => a !== null && a.group === b.group && a.path === b.path;

// The next file after `from` that still needs a decision, wrapping around.
export function nextOpen(sections: ReviewSection[], decisions: Decisions, from: Position | null): Position | null {
  const rows = flat(sections);
  const start = from ? rows.findIndex((row) => same(from, row.position)) : -1;
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(start + step + rows.length) % rows.length]!;
    if (isOpen(fileState(decisions.reviewed, decisions.requested, row.file))) return row.position;
  }
  return null;
}

export function step(sections: ReviewSection[], from: Position | null, delta: 1 | -1): Position | null {
  const rows = flat(sections);
  if (rows.length === 0) return null;
  const at = from ? rows.findIndex((row) => same(from, row.position)) : -1;
  const next = at < 0 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  return rows[next]!.position;
}
