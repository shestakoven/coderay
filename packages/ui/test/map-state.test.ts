import { describe, expect, it } from 'vitest';
import { initialMapState, mapReducer } from '../src/map/map-state';
import { demoSnapshot } from './snapshot';

describe('mapReducer', () => {
  it('toggles a component open and closed', () => {
    const opened = mapReducer(initialMapState, { type: 'toggle', componentId: 'folder:src/api' });
    expect([...opened.expanded]).toEqual(['folder:src/api']);
    expect([...mapReducer(opened, { type: 'toggle', componentId: 'folder:src/api' }).expanded]).toEqual([]);
  });

  it('keeps expansion and selection that still exist in a new snapshot and drops the rest', () => {
    let state = mapReducer(initialMapState, { type: 'snapshot', snapshot: demoSnapshot(1) });
    state = mapReducer(state, { type: 'toggle', componentId: 'folder:src/api' });
    state = mapReducer(state, { type: 'toggle', componentId: 'folder:src/gone' });
    state = mapReducer(state, { type: 'select', id: 'src/api/a.ts' });

    const next = mapReducer(state, { type: 'snapshot', snapshot: demoSnapshot(2) });
    expect([...next.expanded]).toEqual(['folder:src/api']);
    expect(next.selected).toBe('src/api/a.ts');

    const withoutA = { ...demoSnapshot(3), files: demoSnapshot(3).files.filter((f) => f.path !== 'src/api/a.ts') };
    expect(mapReducer(next, { type: 'snapshot', snapshot: withoutA }).selected).toBeNull();
  });
});
