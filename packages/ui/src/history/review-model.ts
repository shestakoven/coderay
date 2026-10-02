import type { ChangeView, HistoryView, PlanView } from '@ide/protocol';
import { reviewGroups, type ReviewFile, type ReviewGroup } from './review-state';

export interface ReviewItem extends ReviewFile {
  toolUseIds: string[];
  eventIds: string[];
  reverted: boolean;
  revertId: string | null;
  renamedFrom: string | null;
}

export interface ReviewSection extends Omit<ReviewGroup, 'files'> {
  files: ReviewItem[];
  planId: string | null;
  stepKey: string | null;
  rationale: string | null;
  stepNo: number | null;
  stepTotal: number;
}

export type ReviewKind = 'new' | 'deleted' | 'modified' | 'renamed';

export const kindOf = (file: Pick<ReviewItem, 'before' | 'after' | 'renamedFrom'>): ReviewKind => {
  if (file.renamedFrom) return 'renamed';
  if (file.before === null && file.after !== null) return 'new';
  if (file.after === null && file.before !== null) return 'deleted';
  return 'modified';
};

const RESTORED = new Set(['restored', 'deleted', 'recreated']);

// Files the user reverted from the review stay listed (marked) until the revert is undone. The core keeps the
// 'reverted' resolution on the changes after an undo, so an undone revert must not hide the file either.
// A record also lists the changes of files that hit a conflict: those were not reverted.
function revertState(history: HistoryView): { active: Map<string, string>; undone: Set<string> } {
  const paths = new Map(history.changes.map((change) => [change.id, change.path]));
  const active = new Map<string, string>();
  const live = new Set<string>();
  for (const record of history.reverts) {
    if (record.undoneAt !== null) continue;
    const restored = new Set(record.files.filter((file) => RESTORED.has(file.outcome)).map((file) => file.path));
    for (const id of record.changeIds) {
      const path = paths.get(id);
      if (path === undefined || !restored.has(path)) continue;
      live.add(id);
      if (record.kind === 'review') active.set(id, record.id);
    }
  }
  const undone = new Set(history.reverts.filter((record) => record.undoneAt !== null).flatMap((record) => record.changeIds).filter((id) => !live.has(id)));
  return { active, undone };
}

const unique = <T,>(values: T[]): T[] => [...new Set(values)];

const totals = (section: ReviewSection, files: ReviewItem[]): ReviewSection => ({ ...section, files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) });

// One row per path: a file edited in several steps (or by the agent and then by hand) is reviewed once, as the net
// change, in the section of its latest change. Decisions are kept per path, so two rows would never settle together.
function mergePaths(sections: ReviewSection[], changes: Map<string, ChangeView>, order: Map<string, number>): ReviewSection[] {
  const rows = new Map<string, { section: number; file: ReviewItem }[]>();
  sections.forEach((section, index) => {
    for (const file of section.files) rows.set(file.path, [...(rows.get(file.path) ?? []), { section: index, file }]);
  });
  const merged = new Map<string, { section: number; file: ReviewItem }>();
  for (const [path, entries] of rows) {
    if (entries.length < 2) continue;
    const ids = entries.flatMap((entry) => entry.file.ids).sort((a, b) => (changes.get(a)?.at ?? 0) - (changes.get(b)?.at ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const lastId = ids[ids.length - 1]!;
    const target = entries.find((entry) => entry.file.ids.includes(lastId))!;
    merged.set(path, {
      section: target.section,
      file: {
        path,
        ids,
        before: changes.get(ids[0]!)?.beforeHash ?? null,
        after: changes.get(lastId)?.afterHash ?? null,
        added: entries.reduce((sum, entry) => sum + entry.file.added, 0),
        removed: entries.reduce((sum, entry) => sum + entry.file.removed, 0),
        toolUseIds: unique(entries.flatMap((entry) => entry.file.toolUseIds)),
        eventIds: unique(entries.flatMap((entry) => entry.file.eventIds)),
        reverted: entries.every((entry) => entry.file.reverted),
        revertId: entries.map((entry) => entry.file.revertId).find((id) => id !== null) ?? null,
        renamedFrom: null,
      },
    });
  }
  if (merged.size === 0) return sections;
  return sections
    .map((section, index) => totals(section, section.files.flatMap((file) => {
      const one = merged.get(file.path);
      if (!one) return [file];
      return one.section === index ? [one.file] : [];
    })))
    .filter((section) => section.files.length > 0);
}

// A deleted file and a new file with the same content are one move (an empty file is not: all empty files look alike).
function mergeRenames(sections: ReviewSection[]): ReviewSection[] {
  const deleted = new Map<string, { section: ReviewSection; file: ReviewItem }>();
  for (const section of sections) {
    for (const file of section.files) if (file.after === null && file.before !== null && !file.reverted && file.removed > 0) deleted.set(file.before, { section, file });
  }
  const dropped = new Set<ReviewItem>();
  const merged = sections.map((section) => ({
    ...section,
    files: section.files.map((file) => {
      if (file.before !== null || file.after === null || file.reverted || file.added === 0) return file;
      const source = deleted.get(file.after);
      if (!source || dropped.has(source.file)) return file;
      dropped.add(source.file);
      return { ...file, before: file.after, ids: [...source.file.ids, ...file.ids], toolUseIds: unique([...source.file.toolUseIds, ...file.toolUseIds]), eventIds: unique([...source.file.eventIds, ...file.eventIds]), added: 0, removed: 0, renamedFrom: source.file.path };
    }),
  }));
  return merged.map((section) => totals(section, section.files.filter((file) => !dropped.has(file)))).filter((section) => section.files.length > 0);
}

export function reviewSections(history: HistoryView, plans: PlanView[]): ReviewSection[] {
  const { active: reverted, undone } = revertState(history);
  const view: HistoryView = { ...history, changes: history.changes.map((change): ChangeView => (change.resolution === 'reverted' && (reverted.has(change.id) || undone.has(change.id)) ? { ...change, resolution: null } : change)) };
  const byId = new Map(view.changes.map((change) => [change.id, change]));
  const sections = reviewGroups(view, plans).map((group): ReviewSection => {
    const [planId, stepKey] = group.key.includes('/') ? group.key.split('/') as [string, string] : [null, null];
    const plan = planId ? plans.filter((p) => p.id === planId).sort((a, b) => b.version - a.version)[0] : undefined;
    const step = plan?.steps.find((s) => s.key === stepKey);
    const files = group.files.map((file): ReviewItem => {
      const own = file.ids.map((id) => byId.get(id)).filter((change): change is ChangeView => change !== undefined);
      const revertIds = file.ids.map((id) => reverted.get(id));
      return {
        ...file,
        toolUseIds: unique(own.flatMap((change) => change.toolUseIds)),
        eventIds: unique(own.flatMap((change) => (change.eventId ? [change.eventId] : []))),
        reverted: file.ids.length > 0 && revertIds.every((id) => id !== undefined),
        revertId: revertIds.find((id) => id !== undefined) ?? null,
        renamedFrom: null,
      };
    });
    return { ...group, files, planId, stepKey, rationale: step?.rationale?.trim() || null, stepNo: step ? [...plan!.steps].sort((a, b) => a.order - b.order).findIndex((s) => s.key === stepKey) + 1 : null, stepTotal: plan?.steps.length ?? 0 };
  });
  return mergeRenames(mergePaths(sections, byId, new Map(view.changes.map((change, index) => [change.id, index]))));
}

export const sectionFiles = (sections: ReviewSection[]): ReviewItem[] => sections.flatMap((section) => section.files);
