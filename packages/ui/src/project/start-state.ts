import type { ClonePhase, ServerMessage } from '@ide/protocol';

export type StartView = 'home' | 'create' | 'clone';

export interface StartWork {
  kind: 'create' | 'clone';
  requestId: string;
  phase: ClonePhase | null;
  percent: number | null;
}

export interface StartState {
  view: StartView;
  work: StartWork | null;
  error: string | null;
}

export type StartAction =
  | { type: 'view'; view: StartView }
  | { type: 'begin'; kind: 'create' | 'clone'; requestId: string }
  | { type: 'server'; message: ServerMessage };

export const initialStart: StartState = { view: 'home', work: null, error: null };

export function startReducer(state: StartState, action: StartAction): StartState {
  switch (action.type) {
    case 'view':
      return state.work ? state : { view: action.view, work: null, error: null };
    case 'begin':
      return { ...state, work: { kind: action.kind, requestId: action.requestId, phase: null, percent: null }, error: null };
    case 'server': {
      const { message } = action;
      const { work } = state;
      if (!work) return state;
      if (message.type === 'project.clone.progress' && message.requestId === work.requestId) {
        return { ...state, work: { ...work, phase: message.phase, percent: message.percent } };
      }
      if ((message.type === 'project.create.result' || message.type === 'project.clone.result') && message.requestId === work.requestId) {
        // On success the core is about to restart on the new project: keep the form locked until the page reloads.
        return message.error ? { ...state, work: null, error: message.error } : state;
      }
      return state;
    }
  }
}

export const isWorking = (state: StartState): boolean => state.work !== null;

export const PHASE_LABEL: Record<ClonePhase, string> = {
  counting: 'Counting objects',
  compressing: 'Compressing objects',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  'checking-out': 'Checking out files',
};

export function formatAgo(now: number, then: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}
