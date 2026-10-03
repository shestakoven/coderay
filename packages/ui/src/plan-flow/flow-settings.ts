import { LAYOUT_CHOICES, type Direction } from '../map/layout-settings';

const STORAGE_KEY = 'ide.flow-direction';

export const DEFAULT_FLOW_DIRECTION: Direction = 'DOWN';

export function loadFlowDirection(storage: Pick<Storage, 'getItem'> | undefined): Direction {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return LAYOUT_CHOICES.direction.find((choice) => choice === value) ?? DEFAULT_FLOW_DIRECTION;
  } catch {
    return DEFAULT_FLOW_DIRECTION;
  }
}

export function saveFlowDirection(storage: Pick<Storage, 'setItem'> | undefined, direction: Direction): void {
  try {
    storage?.setItem(STORAGE_KEY, direction);
  } catch {
    // storage unavailable or full: the choice only lasts for this session
  }
}
