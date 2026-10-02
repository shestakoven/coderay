import { LAYOUT_CHOICES, type Density, type Direction, type EdgeStyle } from '../map/layout-settings';

// The C4 view keeps its semantic columns, so only direction, spacing and edge style are configurable.
export interface C4Layout {
  direction: Direction;
  density: Density;
  edgeStyle: EdgeStyle;
}

export const DEFAULT_C4_LAYOUT: C4Layout = { direction: 'RIGHT', density: 'normal', edgeStyle: 'default' };

const SPACING: Record<Density, { node: number; layer: number }> = {
  tight: { node: 16, layer: 64 },
  normal: { node: 26, layer: 110 },
  loose: { node: 44, layer: 170 },
};

export const c4Spacing = (density: Density): { node: number; layer: number } => SPACING[density];

const STORAGE_KEY = 'ide.c4-layout';

export function loadC4Layout(storage: Pick<Storage, 'getItem'> | undefined): C4Layout {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_C4_LAYOUT;
    const value = JSON.parse(raw) as Partial<Record<keyof C4Layout, unknown>>;
    const pick = <K extends keyof C4Layout>(key: K): C4Layout[K] =>
      (LAYOUT_CHOICES[key] as readonly unknown[]).includes(value[key]) ? (value[key] as C4Layout[K]) : DEFAULT_C4_LAYOUT[key];
    return { direction: pick('direction'), density: pick('density'), edgeStyle: pick('edgeStyle') };
  } catch {
    return DEFAULT_C4_LAYOUT;
  }
}

export function saveC4Layout(storage: Pick<Storage, 'setItem'> | undefined, layout: C4Layout): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // storage unavailable or full: the setting only lasts for this session
  }
}
