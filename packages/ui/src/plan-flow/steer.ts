import type { PlanFlow, PlanFlowNode } from '@ide/protocol';

// What the user collects on the plan map before answering: remarks on parts and links, and parts to add.
export type Change =
  | { kind: 'note'; target: string; text: string }
  | { kind: 'ask'; id: string; after: string; text: string };

export const nodeKey = (id: string): string => `n:${id}`;
export const edgeKey = (index: number): string => `e:${index}`;

export interface DraftState {
  past: Change[][];
  present: Change[];
  seq: number;
}

export type DraftAction =
  | { t: 'note'; target: string; text: string }
  | { t: 'ask'; after: string; text: string }
  | { t: 'unask'; id: string }
  | { t: 'remove'; index: number }
  | { t: 'undo' }
  | { t: 'clear' };

export const EMPTY_DRAFT: DraftState = { past: [], present: [], seq: 0 };

const UNDO_DEPTH = 50;

function commit(state: DraftState, present: Change[], seq = state.seq): DraftState {
  return { past: [...state.past.slice(-(UNDO_DEPTH - 1)), state.present], present, seq };
}

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.t) {
    case 'note': {
      const rest = state.present.filter((change) => !(change.kind === 'note' && change.target === action.target));
      const text = action.text.trim();
      if (text === '' && rest.length === state.present.length) return state;
      return commit(state, text === '' ? rest : [...rest, { kind: 'note', target: action.target, text }]);
    }
    case 'ask': {
      const text = action.text.trim();
      if (text === '') return state;
      return commit(state, [...state.present, { kind: 'ask', id: `${ASK_PREFIX}${state.seq + 1}`, after: action.after, text }], state.seq + 1);
    }
    case 'unask':
      return commit(state, state.present.filter((change) => !(change.kind === 'ask' && change.id === action.id) && !(change.kind === 'note' && change.target === nodeKey(action.id))));
    case 'remove': {
      const gone = state.present[action.index];
      // A request takes the comments written on its part along.
      return commit(state, state.present.filter((change, index) => index !== action.index && !(gone?.kind === 'ask' && change.kind === 'note' && change.target === nodeKey(gone.id))));
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      return previous === undefined ? state : { ...state, past: state.past.slice(0, -1), present: previous };
    }
    case 'clear':
      return { ...EMPTY_DRAFT, seq: state.seq };
  }
}

export interface Ask {
  id: string;
  after: string;
  text: string;
}

export interface DraftView {
  notes: Map<string, string>;
  asks: Ask[];
}

export function viewOf(changes: readonly Change[]): DraftView {
  const view: DraftView = { notes: new Map(), asks: [] };
  for (const change of changes) {
    if (change.kind === 'note') view.notes.set(change.target, change.text);
    else view.asks.push({ id: change.id, after: change.after, text: change.text });
  }
  return view;
}

// The tilde keeps a request apart from any id the agent picked for its own parts.
const ASK_PREFIX = '~ask-';
export const isAsk = (id: string): boolean => id.startsWith(ASK_PREFIX);

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

// A request is drawn as a part the user wants added, hanging off the part it follows. The agent decides the files.
export function withAsks(flow: PlanFlow, asks: readonly Ask[]): PlanFlow {
  if (asks.length === 0) return flow;
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  return {
    nodes: [
      ...flow.nodes,
      ...asks.map((ask): PlanFlowNode => ({
        id: ask.id, title: clip(ask.text, 30), sub: `Requested · after ${byId.get(ask.after)?.title ?? ask.after}`, kind: 'module', state: 'create', steps: [], files: [],
      })),
    ],
    edges: [...flow.edges, ...asks.map((ask) => ({ from: ask.after, to: ask.id, label: 'requested', state: 'new' as const }))],
  };
}

export type Group = 'note' | 'ask';

export interface Item {
  group: Group;
  // Position in the draft, so one item can be removed from the list.
  index: number;
  title: string;
  detail: string;
}

export function describe(changes: readonly Change[], flow: PlanFlow): Item[] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const name = (id: string): string => {
    const node = byId.get(id);
    if (node === undefined) return id;
    // The agent never saw a request's id; it knows the part by what was asked.
    return isAsk(id) ? `requested part "${node.title}"` : `${node.title} (${node.id})`;
  };
  return changes.map((change, index): Item => {
    if (change.kind === 'ask') return { group: 'ask', index, title: `after ${name(change.after)}`, detail: change.text };
    if (change.target.startsWith('n:')) return { group: 'note', index, title: name(change.target.slice(2)), detail: change.text };
    const edge = flow.edges[Number(change.target.slice(2))];
    return { group: 'note', index, title: edge === undefined ? change.target : `${name(edge.from)} → ${name(edge.to)}`, detail: change.text };
  });
}

export const GROUP_ORDER: Group[] = ['note', 'ask'];
export const GROUP_LABEL: Record<Group, string> = { note: 'Notes', ask: 'Add' };

// The text the agent gets as the answer to propose_plan.
export function message(items: readonly Item[]): string {
  const blocks = GROUP_ORDER.flatMap((group) => {
    const inGroup = items.filter((item) => item.group === group);
    if (inGroup.length === 0) return [];
    return [`${GROUP_LABEL[group]}\n${inGroup.map((item) => `- ${item.title}: ${item.detail}`).join('\n')}`];
  });
  return `Please revise the plan.\n\n${blocks.join('\n\n')}`;
}
