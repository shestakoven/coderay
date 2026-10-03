export type MapMode = 'c4' | 'components' | 'flow';

export interface ModeInput {
  hasC4: boolean;
  hasFlow: boolean;
}

export const MODE_LABEL: Record<MapMode, string> = { c4: 'C4', components: 'Components', flow: 'Plan flow' };

export function availableModes({ hasC4, hasFlow }: ModeInput): MapMode[] {
  return [...(hasC4 ? ['c4' as const] : []), 'components', ...(hasFlow ? ['flow' as const] : [])];
}

export function resolveMode(preferred: MapMode | null, input: ModeInput): MapMode {
  if (preferred !== null && availableModes(input).includes(preferred)) return preferred;
  return input.hasC4 ? 'c4' : 'components';
}
