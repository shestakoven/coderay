import { MAX_REVIEW_GRAPH_FILES } from '@ide/protocol';
import type { PlanView, ReviewGraph, ReviewGraphFile, ReviewLink, ReviewLinkState, ReviewPart } from '@ide/protocol';
import type { ReviewSection } from '../review-model';

export type StepOutcome = 'done' | 'partial' | 'skipped';
export interface MapStep { key: string; no: number; title: string; outcome: StepOutcome }
export interface MapView { parts: ReviewPart[]; links: { link: ReviewLink; index: number }[] }
export interface Focus { parts: Set<string>; links: Set<number> }
export interface Totals { created: number; modified: number; deleted: number; missing: number; outside: number; unplanned: number; broken: number; added: number; removed: number }
export type Target = { t: 'part'; id: string } | { t: 'link'; from: string; to: string };

export const FLAGGED_LINKS: ReadonlySet<ReviewLinkState> = new Set(['unplanned', 'missing', 'broken', 'removed']);

export const targetKey = (target: Target): string => (target.t === 'part' ? `p:${target.id}` : `l:${target.from}>${target.to}`);

const FOLLOW_UP_STEP = '(follow-up)';

// Reverted files are back to how they were: they would draw links that no longer exist.
// A follow-up section has an empty step key, which the request refuses; any non-null step marks a file as in-plan.
export function graphFilesOf(sections: ReviewSection[]): ReviewGraphFile[] {
  return sections
    .flatMap((section) => section.files
      .filter((file) => !file.reverted)
      .map((file): ReviewGraphFile => ({
        path: file.path, before: file.before, after: file.after, step: section.stepKey === '' ? FOLLOW_UP_STEP : section.stepKey, external: section.key === 'external', added: file.added, removed: file.removed,
      })))
    .slice(0, MAX_REVIEW_GRAPH_FILES);
}

export function graphKey(files: ReviewGraphFile[], planId: string | null): string {
  return JSON.stringify([planId, [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => [file.path, file.before, file.after, file.step, file.external, file.added, file.removed])]);
}

export function visibleMap(graph: ReviewGraph, context: boolean): MapView {
  const flagged = new Set(graph.links.filter((link) => FLAGGED_LINKS.has(link.state)).flatMap((link) => [link.from, link.to]));
  const parts = graph.parts.filter((part) => context || part.status !== 'untouched' || flagged.has(part.id));
  const ids = new Set(parts.map((part) => part.id));
  const links = graph.links.map((link, index) => ({ link, index })).filter(({ link }) => ids.has(link.from) && ids.has(link.to));
  return { parts, links };
}

export function focusOf(view: MapView, target: Target | null): Focus | null {
  if (target === null) return null;
  if (target.t === 'link') {
    const at = view.links.find(({ link }) => link.from === target.from && link.to === target.to);
    return at === undefined ? null : { parts: new Set([target.from, target.to]), links: new Set([at.index]) };
  }
  if (!view.parts.some((part) => part.id === target.id)) return null;
  const around = view.links.filter(({ link }) => link.from === target.id || link.to === target.id);
  return { parts: new Set([target.id, ...around.flatMap(({ link }) => [link.from, link.to])]), links: new Set(around.map(({ index }) => index)) };
}

export function stepOutcomes(plan: PlanView | null, graph: ReviewGraph): MapStep[] {
  if (plan === null) return [];
  const withFiles = new Set(graph.parts.flatMap((part) => part.files.map((file) => file.step)).filter((step): step is string => step !== null));
  return [...plan.steps].sort((a, b) => a.order - b.order).map((step, index) => ({
    key: step.key,
    no: index + 1,
    title: step.title,
    outcome: !withFiles.has(step.key) ? 'skipped' : step.status === 'done' ? 'done' : 'partial',
  }));
}

export function totalsOf(graph: ReviewGraph): Totals {
  const count = (status: ReviewPart['status']): number => graph.parts.filter((part) => part.status === status).length;
  const files = graph.parts.flatMap((part) => part.files);
  return {
    created: count('created'), modified: count('modified'), deleted: count('deleted'), missing: count('missing'),
    outside: graph.parts.filter((part) => part.outside).length,
    unplanned: graph.links.filter((link) => link.state === 'unplanned').length,
    broken: graph.links.filter((link) => link.state === 'broken').length + graph.parts.reduce((sum, part) => sum + part.broken.length, 0),
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

export const partOfPath = (graph: ReviewGraph, path: string): string | null =>
  graph.parts.find((part) => part.files.some((file) => file.path === path))?.id ?? null;
