import type { MapSnapshot } from '@ide/protocol';

export interface MapState {
  snapshot: MapSnapshot | null;
  expanded: ReadonlySet<string>;
  selected: string | null;
}

export type MapAction =
  | { type: 'snapshot'; snapshot: MapSnapshot }
  | { type: 'toggle'; componentId: string }
  | { type: 'select'; id: string | null };

export const initialMapState: MapState = { snapshot: null, expanded: new Set(), selected: null };

export function mapReducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case 'snapshot': {
      const ids = new Set([...action.snapshot.components.map((c) => c.id), ...action.snapshot.files.map((f) => f.path)]);
      return {
        snapshot: action.snapshot,
        expanded: new Set([...state.expanded].filter((id) => ids.has(id))),
        selected: state.selected && ids.has(state.selected) ? state.selected : null,
      };
    }
    case 'toggle': {
      const expanded = new Set(state.expanded);
      if (!expanded.delete(action.componentId)) expanded.add(action.componentId);
      return { ...state, expanded };
    }
    case 'select':
      return { ...state, selected: action.id };
  }
}
