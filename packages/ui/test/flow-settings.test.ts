import { describe, expect, it } from 'vitest';
import { DEFAULT_C4_LAYOUT, loadC4Layout, saveC4Layout } from '../src/c4/c4-layout';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../src/history/review-store';
import { initialPanels, loadPanels, savePanels } from '../src/layout/panel-state';
import { DEFAULT_SIZES, loadSizes, saveSizes } from '../src/layout/sizes';
import { DEFAULT_LAYOUT, loadLayout, saveLayout } from '../src/map/layout-settings';
import { DEFAULT_FLOW_DIRECTION, loadFlowDirection, saveFlowDirection } from '../src/plan-flow/flow-settings';

const DIRECTIONS = ['RIGHT', 'DOWN', 'LEFT', 'UP'] as const;

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};
const holding = (value: string | null) => ({ getItem: () => value });
const throwing = () => {
  throw new Error('storage is disabled');
};

describe('flow direction', () => {
  it('reads top to bottom unless the user chose otherwise', () => {
    expect(DEFAULT_FLOW_DIRECTION).toBe('DOWN');
  });

  it('falls back to the default without storage', () => {
    expect(loadFlowDirection(undefined)).toBe('DOWN');
  });

  it('falls back to the default from an empty store', () => {
    expect(loadFlowDirection(memory())).toBe('DOWN');
    expect(loadFlowDirection(holding(null))).toBe('DOWN');
  });

  it.each(['SIDEWAYS', '', 'down', 'Right', ' UP', 'UP ', 'LEFT\n', '"RIGHT"', '{"direction":"UP"}', 'null', 'undefined', '0', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to the default for the stored value %j',
    (junk) => {
      expect(loadFlowDirection(holding(junk))).toBe('DOWN');
    },
  );

  it('falls back to the default when reading the store throws', () => {
    expect(loadFlowDirection({ getItem: throwing })).toBe('DOWN');
  });

  it.each(DIRECTIONS)('returns the stored value %s', (direction) => {
    expect(loadFlowDirection(holding(direction))).toBe(direction);
  });

  it.each(DIRECTIONS)('round-trips %s through storage', (direction) => {
    const storage = memory();
    saveFlowDirection(storage, direction);
    expect(loadFlowDirection(storage)).toBe(direction);
  });

  it('remembers the last direction that was saved', () => {
    const storage = memory();
    saveFlowDirection(storage, 'UP');
    saveFlowDirection(storage, 'LEFT');
    expect(loadFlowDirection(storage)).toBe('LEFT');
  });

  it('keeps the saved direction in the storage it was saved to, not in the module', () => {
    saveFlowDirection(memory(), 'UP');
    expect(loadFlowDirection(memory())).toBe('DOWN');
  });

  it('writes to the store once per save', () => {
    const writes: [string, string][] = [];
    saveFlowDirection({ setItem: (key: string, value: string) => void writes.push([key, value]) }, 'RIGHT');
    expect(writes).toHaveLength(1);
  });

  it('does not throw when writing to the store throws', () => {
    expect(() => saveFlowDirection({ setItem: throwing }, 'UP')).not.toThrow();
  });

  it('does not throw without storage', () => {
    expect(() => saveFlowDirection(undefined, 'UP')).not.toThrow();
  });

  it('is kept apart from the map layout setting in the same storage', () => {
    const storage = memory();
    saveLayout(storage, { ...DEFAULT_LAYOUT, direction: 'LEFT' });
    saveFlowDirection(storage, 'UP');
    expect(loadLayout(storage).direction).toBe('LEFT');
    expect(loadFlowDirection(storage)).toBe('UP');

    const other = memory();
    saveFlowDirection(other, 'RIGHT');
    saveLayout(other, { ...DEFAULT_LAYOUT, direction: 'DOWN' });
    expect(loadFlowDirection(other)).toBe('RIGHT');
    expect(loadLayout(other).direction).toBe('DOWN');
  });

  it('does not overwrite any other setting kept in the same storage', () => {
    const storage = memory();
    saveLayout(storage, { ...DEFAULT_LAYOUT, direction: 'LEFT' });
    saveC4Layout(storage, { ...DEFAULT_C4_LAYOUT, direction: 'UP' });
    saveSizes(storage, { ...DEFAULT_SIZES, left: DEFAULT_SIZES.left + 7 });
    savePanels(storage, { ...initialPanels, bottom: true });
    savePrefs(storage, { ...DEFAULT_PREFS, mode: 'split' });
    const before = {
      layout: loadLayout(storage),
      c4: loadC4Layout(storage),
      sizes: loadSizes(storage),
      panels: loadPanels(storage),
      prefs: loadPrefs(storage),
    };
    expect(before.layout.direction).toBe('LEFT');
    expect(before.c4.direction).toBe('UP');
    expect(before.panels.bottom).toBe(true);
    expect(before.prefs.mode).toBe('split');

    saveFlowDirection(storage, 'RIGHT');

    expect(loadFlowDirection(storage)).toBe('RIGHT');
    expect(loadLayout(storage)).toEqual(before.layout);
    expect(loadC4Layout(storage)).toEqual(before.c4);
    expect(loadSizes(storage)).toEqual(before.sizes);
    expect(loadPanels(storage)).toEqual(before.panels);
    expect(loadPrefs(storage)).toEqual(before.prefs);
  });

  it('does not take the map layout direction as its own', () => {
    const storage = memory();
    saveLayout(storage, { ...DEFAULT_LAYOUT, direction: 'LEFT' });
    expect(loadFlowDirection(storage)).toBe('DOWN');
  });
});
