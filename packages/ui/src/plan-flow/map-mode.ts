export type MapMode = 'overview' | 'c4' | 'components' | 'flow';

export interface ModeInput {
  hasC4: boolean;
  hasFlow: boolean;
  hasOverview?: boolean;
}

export const MODE_LABEL: Record<MapMode, string> = { overview: 'Overview', c4: 'C4', components: 'Components', flow: 'Plan flow' };

export function availableModes({ hasC4, hasFlow, hasOverview = false }: ModeInput): MapMode[] {
  return [...(hasOverview ? ['overview' as const] : []), ...(hasC4 ? ['c4' as const] : []), 'components', ...(hasFlow ? ['flow' as const] : [])];
}

export function resolveMode(preferred: MapMode | null, input: ModeInput): MapMode {
  if (preferred !== null && availableModes(input).includes(preferred)) return preferred;
  return input.hasC4 ? 'c4' : input.hasOverview ? 'overview' : 'components';
}
