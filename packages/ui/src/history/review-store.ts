import type { DiffMode } from './diff-rows';
import type { Requested } from './review-flow';

type Reader = Pick<Storage, 'getItem'> | undefined;
type Writer = Pick<Storage, 'setItem'> | undefined;

export function loadRequested(storage: Reader, root: string): Requested {
  try {
    const raw = storage?.getItem(`ide.review.requested.${root}`);
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, hash]) => hash === null || typeof hash === 'string')) as Requested;
  } catch {
    return {};
  }
}

export function saveRequested(storage: Writer, root: string, requested: Requested): void {
  try {
    storage?.setItem(`ide.review.requested.${root}`, JSON.stringify(requested));
  } catch {
    // storage unavailable or full: the marks only last for this session
  }
}

export interface ReviewPrefs {
  mode: DiffMode;
  listWidth: number;
  showContext: boolean;
}

export const LIST_WIDTH = { min: 220, max: 560, initial: 320 } as const;
export const DEFAULT_PREFS: ReviewPrefs = { mode: 'unified', listWidth: LIST_WIDTH.initial, showContext: true };

export const clampListWidth = (width: number): number => Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, width)));

export function loadPrefs(storage: Reader): ReviewPrefs {
  try {
    const raw = storage?.getItem('ide.review.prefs');
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (typeof value !== 'object' || value === null) return DEFAULT_PREFS;
    const v = value as Record<string, unknown>;
    return {
      mode: v.mode === 'split' ? 'split' : 'unified',
      listWidth: typeof v.listWidth === 'number' && Number.isFinite(v.listWidth) ? clampListWidth(v.listWidth) : DEFAULT_PREFS.listWidth,
      showContext: v.showContext !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(storage: Writer, prefs: ReviewPrefs): void {
  try {
    storage?.setItem('ide.review.prefs', JSON.stringify(prefs));
  } catch {
    // storage unavailable: the preferences only last for this session
  }
}
