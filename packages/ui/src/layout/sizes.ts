export type SizedPanel = 'left' | 'right' | 'bottom';

export type PanelSizes = Record<SizedPanel, number>;

export const DEFAULT_SIZES: PanelSizes = { left: 264, right: 340, bottom: 200 };

export const LIMITS: Record<SizedPanel, { min: number; max: number }> = {
  left: { min: 200, max: 560 },
  right: { min: 280, max: 720 },
  bottom: { min: 100, max: 480 },
};

export const MIN_MAP_WIDTH = 320;
export const ACTIVITY_BAR_WIDTH = 48;
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export interface Room {
  viewportWidth: number;
  viewportHeight: number;
  otherSideWidth: number;
}

export function clampSize(panel: SizedPanel, size: number, room: Room): number {
  const { min, max } = LIMITS[panel];
  const roomMax = panel === 'bottom'
    ? room.viewportHeight - 200
    : room.viewportWidth - ACTIVITY_BAR_WIDTH - MIN_MAP_WIDTH - room.otherSideWidth;
  const ceiling = Math.max(min, Math.min(max, roomMax));
  if (!Number.isFinite(size)) return DEFAULT_SIZES[panel];
  return Math.round(Math.min(ceiling, Math.max(min, size)));
}

const STORAGE_KEY = 'ide.panel-sizes';

export function loadSizes(storage: Pick<Storage, 'getItem'> | undefined): PanelSizes {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SIZES;
    const value = JSON.parse(raw) as Partial<Record<SizedPanel, unknown>>;
    const read = (panel: SizedPanel): number => {
      const stored = value?.[panel];
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_SIZES[panel];
      return Math.round(Math.min(LIMITS[panel].max, Math.max(LIMITS[panel].min, stored)));
    };
    return { left: read('left'), right: read('right'), bottom: read('bottom') };
  } catch {
    return DEFAULT_SIZES;
  }
}

export function saveSizes(storage: Pick<Storage, 'setItem'> | undefined, sizes: PanelSizes): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // storage can be blocked; sizes then reset on reload
  }
}
