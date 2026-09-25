import type { ChatItem, McpServerState, SessionPatch, SessionState, SessionView, TaskView, TurnView } from '@ide/protocol';

export interface ChatState {
  session: SessionView | null;
  turns: Record<string, TurnView>;
  items: Record<string, ChatItem>;
  tasks: Record<string, TaskView>;
  mcpServers: McpServerState[];
  error: string | null;
}

export type ChatAction =
  | { type: 'snapshot'; state: SessionState }
  | { type: 'patch'; patch: SessionPatch }
  | { type: 'error'; message: string }
  | { type: 'dismiss-error' };

export interface TurnGroup {
  turn: TurnView | null;
  items: ChatItem[];
}

export const initialChatState: ChatState = { session: null, turns: {}, items: {}, tasks: {}, mcpServers: [], error: null };

const byId = <T extends { id: string }>(values: T[]): Record<string, T> => Object.fromEntries(values.map((value) => [value.id, value]));
const merge = <T extends { id: string }>(current: Record<string, T>, updates: T[] | undefined): Record<string, T> =>
  updates?.length ? { ...current, ...byId(updates) } : current;
const bySeq = (a: ChatItem, b: ChatItem) => a.seq - b.seq;
const openTurns = (state: ChatState) => Object.values(state.turns).filter((turn) => turn.closedAt === null);

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'snapshot':
      return {
        session: action.state.session,
        turns: byId(action.state.turns),
        items: byId(action.state.items),
        tasks: byId(action.state.tasks),
        mcpServers: action.state.mcpServers,
        error: state.error,
      };
    case 'patch':
      return {
        ...state,
        session: action.patch.session ?? state.session,
        turns: merge(state.turns, action.patch.turns),
        items: merge(state.items, action.patch.items),
        tasks: merge(state.tasks, action.patch.tasks),
        mcpServers: action.patch.mcpServers ?? state.mcpServers,
      };
    case 'error':
      return { ...state, error: action.message };
    case 'dismiss-error':
      return { ...state, error: null };
  }
}

export function turnGroups(state: ChatState): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const topLevel = Object.values(state.items).filter((item) => item.parentToolUseId === null).sort(bySeq);
  for (const item of topLevel) {
    const last = groups.at(-1);
    if (last && (last.turn?.id ?? null) === item.turnId) last.items.push(item);
    else groups.push({ turn: item.turnId === null ? null : (state.turns[item.turnId] ?? null), items: [item] });
  }
  return groups;
}

export const childItems = (state: ChatState, toolUseId: string): ChatItem[] =>
  Object.values(state.items).filter((item) => item.parentToolUseId === toolUseId).sort(bySeq);

export const runningTasks = (state: ChatState): TaskView[] => Object.values(state.tasks).filter((task) => task.endedAt === null);

export const canSend = (state: ChatState): boolean => openTurns(state).length === 0;

export const canStop = (state: ChatState): boolean => openTurns(state).some((turn) => turn.startedAt !== null);

// An interrupt also kills running async subagents; background shells keep running (spike c5b, c6).
export function stopControl(state: ChatState): { label: string; title: string } {
  const subagents = runningTasks(state).filter((task) => task.kind === 'subagent').length;
  if (subagents === 0 || !canStop(state)) return { label: 'Stop', title: 'Stop the current turn. Background shells keep running.' };
  const noun = subagents === 1 ? 'subagent' : 'subagents';
  return {
    label: `Stop (+${subagents} ${noun})`,
    title: `Stop the current turn. This also stops ${subagents} running background ${noun}; background shells keep running.`,
  };
}
