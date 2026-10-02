import type { ReviewSection } from './review-model';
import { fileState, isOpen, type Decisions } from './review-flow';

export interface ListFilter {
  query: string;
  onlyPending: boolean;
}

// Sections keep their totals; only the rows are filtered, and a section with no matching rows disappears.
export function filterSections(sections: ReviewSection[], filter: ListFilter, decisions: Decisions): ReviewSection[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0 && !filter.onlyPending) return sections;
  return sections
    .map((section) => ({
      ...section,
      files: section.files.filter((file) => {
        const haystack = `${file.path} ${file.renamedFrom ?? ''}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return false;
        return !filter.onlyPending || isOpen(fileState(decisions.reviewed, decisions.requested, file));
      }),
    }))
    .filter((section) => section.files.length > 0);
}

export type FileCategory = 'code' | 'style' | 'data' | 'doc' | 'image' | 'shell' | 'other';

const CATEGORIES: Record<string, FileCategory> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', mts: 'code', cts: 'code', py: 'code', go: 'code', rs: 'code', java: 'code', rb: 'code', c: 'code', h: 'code', cpp: 'code', swift: 'code', kt: 'code',
  css: 'style', scss: 'style', less: 'style', html: 'style', svg: 'image',
  json: 'data', yml: 'data', yaml: 'data', toml: 'data', csv: 'data', lock: 'data', xml: 'data', env: 'data',
  md: 'doc', mdx: 'doc', txt: 'doc', rst: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', avif: 'image',
  sh: 'shell', bash: 'shell', zsh: 'shell',
};

export function categoryOf(path: string): FileCategory {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return name === 'dockerfile' || name === 'makefile' ? 'shell' : 'other';
  const extension = name.slice(dot + 1);
  return Object.hasOwn(CATEGORIES, extension) ? CATEGORIES[extension]! : 'other';
}

export const isImage = (path: string): boolean => categoryOf(path) === 'image';
