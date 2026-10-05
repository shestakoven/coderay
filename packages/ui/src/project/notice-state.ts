import type { Notice } from './project-status';

export interface NoticeItem extends Notice {
  id: string;
  // Null for a message that belongs to no project, such as a failed open.
  projectId: string | null;
}

export type NoticeAction =
  | { type: 'add'; notice: NoticeItem }
  | { type: 'dismiss'; id: string }
  // The project is on screen now, or its state moved on: whatever it asked for is stale.
  | { type: 'shown'; projectId: string }
  | { type: 'status'; projectId: string; kind: 'working' | 'attention' | 'idle' | 'error' }
  | { type: 'gone'; projectId: string };

// A project holds one notice at a time: a newer one replaces the older.
export function noticesReducer(state: NoticeItem[], action: NoticeAction): NoticeItem[] {
  switch (action.type) {
    case 'add':
      return [...state.filter((item) => action.notice.projectId === null || item.projectId !== action.notice.projectId), action.notice].slice(-4);
    case 'dismiss':
      return state.filter((item) => item.id !== action.id);
    case 'shown':
    case 'gone':
      return state.filter((item) => item.projectId !== action.projectId);
    case 'status':
      return state.filter((item) => item.projectId !== action.projectId || (item.kind === 'attention' && action.kind === 'attention') || (item.kind === 'error' && action.kind === 'error') || item.kind === 'done');
  }
}
