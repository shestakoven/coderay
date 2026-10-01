import type { DirEntry, ServerMessage } from '@ide/protocol';

export interface BrowseState {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  error: string | null;
  pending: string | null;
  opening: string | null;
}

export type BrowseAction =
  | { type: 'list'; requestId: string }
  | { type: 'open'; requestId: string }
  | { type: 'server'; message: ServerMessage }
  | { type: 'reset' };

export const initialBrowse: BrowseState = { path: null, parent: null, entries: [], error: null, pending: null, opening: null };

export function browseReducer(state: BrowseState, action: BrowseAction): BrowseState {
  switch (action.type) {
    case 'list':
      return { ...state, pending: action.requestId, error: null };
    case 'open':
      return { ...state, opening: action.requestId, error: null };
    case 'reset':
      return initialBrowse;
    case 'server': {
      const { message } = action;
      if (message.type === 'fs.list.result' && message.requestId === state.pending) {
        if (message.error) return { ...state, pending: null, error: message.error };
        return { ...state, pending: null, path: message.path, parent: message.parent, entries: message.entries, error: null };
      }
      if (message.type === 'project.open.result' && message.requestId === state.opening) {
        return { ...state, opening: message.error ? null : state.opening, error: message.error };
      }
      return state;
    }
  }
}

export const joinPath = (base: string, name: string): string => (base.endsWith('/') ? `${base}${name}` : `${base}/${name}`);

export const isOpening = (state: BrowseState): boolean => state.opening !== null;
