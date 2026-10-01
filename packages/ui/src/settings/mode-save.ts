export const MODE_SAVE_SHOWN_MS = 5000;

export interface ModeSave {
  error: string | null;
  until: number;
}

export type ModeSaveAction = { type: 'saved' } | { type: 'failed'; message: string; now: number } | { type: 'expire'; now: number };

export const initialModeSave: ModeSave = { error: null, until: 0 };

export function modeSaveReducer(state: ModeSave, action: ModeSaveAction): ModeSave {
  if (action.type === 'saved') return initialModeSave;
  if (action.type === 'failed') return { error: action.message, until: action.now + MODE_SAVE_SHOWN_MS };
  return state.error !== null && action.now >= state.until ? initialModeSave : state;
}
