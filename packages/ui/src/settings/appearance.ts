export type Density = 'comfortable' | 'compact';

export interface Appearance {
  density: Density;
  fontSize: number;
  // null follows the operating system setting
  reducedMotion: boolean | null;
  canvasDots: boolean;
}

export const FONT_SIZES = [12, 13, 14, 15, 16] as const;
export const BASE_FONT_SIZE = 13;

export const DEFAULT_APPEARANCE: Appearance = { density: 'comfortable', fontSize: BASE_FONT_SIZE, reducedMotion: null, canvasDots: true };

const KEY = 'ide.appearance';

export function normalizeAppearance(raw: unknown): Appearance {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    density: value.density === 'compact' ? 'compact' : 'comfortable',
    fontSize: FONT_SIZES.find((size) => size === value.fontSize) ?? DEFAULT_APPEARANCE.fontSize,
    reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : null,
    canvasDots: value.canvasDots === false ? false : true,
  };
}

export function loadAppearance(storage: Storage | undefined): Appearance {
  try {
    const text = storage?.getItem(KEY);
    return normalizeAppearance(text ? JSON.parse(text) : null);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(storage: Storage | undefined, appearance: Appearance): void {
  try {
    storage?.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // storage may be full or blocked; the setting then lasts for this session only
  }
}

export interface AppearanceAttributes {
  data: { density: string; motion: string; canvasDots: string };
  scale: number;
}

export function appearanceAttributes(appearance: Appearance, systemReducesMotion: boolean): AppearanceAttributes {
  const reduced = appearance.reducedMotion ?? systemReducesMotion;
  return {
    data: { density: appearance.density, motion: reduced ? 'reduce' : 'full', canvasDots: appearance.canvasDots ? 'on' : 'off' },
    scale: appearance.fontSize / BASE_FONT_SIZE,
  };
}

export const systemReducesMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  const { data, scale } = appearanceAttributes(appearance, systemReducesMotion());
  root.dataset.density = data.density;
  root.dataset.motion = data.motion;
  root.dataset.canvasDots = data.canvasDots;
  root.style.setProperty('--fs-scale', String(scale));
}
