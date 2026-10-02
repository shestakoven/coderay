import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, elkOptions, handlePositions, loadLayout, saveLayout } from '../src/map/layout-settings';

const memory = (initial?: string) => {
  let value = initial;
  return { getItem: () => value ?? null, setItem: (_key: string, next: string) => (value = next) };
};

describe('layout settings', () => {
  it('maps settings to ELK options', () => {
    const options = elkOptions({ ...DEFAULT_LAYOUT, direction: 'DOWN', density: 'loose' });
    expect(options['elk.direction']).toBe('DOWN');
    expect(options['elk.layered.spacing.nodeNodeBetweenLayers']).toBe('150');
    expect(elkOptions({ ...DEFAULT_LAYOUT, algorithm: 'radial' })['elk.layered.spacing.nodeNodeBetweenLayers']).toBeUndefined();
  });

  it('round-trips through storage', () => {
    const storage = memory();
    saveLayout(storage, { ...DEFAULT_LAYOUT, algorithm: 'stress', detail: 'compact' });
    expect(loadLayout(storage)).toEqual({ ...DEFAULT_LAYOUT, algorithm: 'stress', detail: 'compact' });
  });

  it('falls back per field on junk or unknown values', () => {
    expect(loadLayout(memory('{bad'))).toEqual(DEFAULT_LAYOUT);
    expect(loadLayout(memory(JSON.stringify({ direction: 'SIDEWAYS', detail: 'full' })))).toEqual({ ...DEFAULT_LAYOUT, detail: 'full' });
  });

  it('puts handles on the sides the flow enters and leaves', () => {
    expect(handlePositions('RIGHT')).toEqual({ target: 'left', source: 'right' });
    expect(handlePositions('UP')).toEqual({ target: 'bottom', source: 'top' });
  });
});
