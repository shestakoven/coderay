import { describe, expect, it } from 'vitest';
import type { PlanFlow, PlanFlowEdge, PlanFlowNode } from '@ide/protocol';
import {
  EMPTY_DRAFT, draftReducer, describe as describeChanges, edgeKey, message, nodeKey, viewOf, withAsks,
  type Change, type DraftAction, type DraftState,
} from '../src/plan-flow/steer';

const node = (id: string, title: string, overrides: Partial<PlanFlowNode> = {}): PlanFlowNode => (
  { id, title, sub: '', kind: 'module', state: 'existing', steps: [], files: [], ...overrides }
);

const edge = (from: string, to: string, label: string, overrides: Partial<PlanFlowEdge> = {}): PlanFlowEdge => (
  { from, to, label, state: 'existing', ...overrides }
);

const flow: PlanFlow = {
  nodes: [node('web', 'Web app'), node('api', 'POST /orders', { kind: 'endpoint', state: 'create', steps: ['route'] }), node('svc', 'OrderService')],
  edges: [edge('web', 'api', 'POST'), edge('api', 'svc', 'create(order)', { state: 'new' })],
};

const run = (...actions: DraftAction[]): DraftState => actions.reduce(draftReducer, EMPTY_DRAFT);
const apply = (state: DraftState, action: DraftAction): DraftState => draftReducer(state, action);
const note = (target: string, text: string): DraftAction => ({ t: 'note', target, text });
const ask = (text: string, after = 'api'): DraftAction => ({ t: 'ask', after, text });
const noteChange = (target: string, text: string): Change => ({ kind: 'note', target, text });

const asksOf = (state: DraftState): { id: string; text: string }[] => viewOf(state.present).asks;
const idOfAsk = (state: DraftState, text: string): string => {
  const found = asksOf(state).find((candidate) => candidate.text === text);
  if (!found) throw new Error(`no ask "${text}"`);
  return found.id;
};
const noteTargets = (state: DraftState): string[] => state.present.flatMap((change) => (change.kind === 'note' ? [change.target] : []));

describe('draftReducer', () => {
  it('replaces the comment on a part when a second one is written for it', () => {
    const state = run(note(nodeKey('api'), 'return 400'), note(nodeKey('api'), 'return 409'));
    expect(state.present).toEqual([noteChange('n:api', 'return 409')]);
  });

  it('keeps the text without the blanks around it', () => {
    const state = run(note(nodeKey('web'), '  rename it\n'), ask(' add a cache \n'));
    expect(state.present).toEqual([noteChange('n:web', 'rename it'), expect.objectContaining({ kind: 'ask', text: 'add a cache' })]);
  });

  it('removes a comment when its text is cleared', () => {
    const state = run(note(edgeKey(0), 'rename the field'), note(edgeKey(0), '   '));
    expect(state.present).toEqual([]);
  });

  it('ignores a blank ask and a blank comment on an untouched target, without an undo step', () => {
    const state = run(note(nodeKey('web'), 'keep'), ask('   '), note(nodeKey('api'), '   '));
    expect(state.present).toEqual([noteChange('n:web', 'keep')]);
    expect(apply(state, { t: 'undo' }).present).toEqual([]);
  });

  it('never reuses an ask id, even after the ask was removed or the draft was cleared', () => {
    let state = run(ask('one'), ask('two'));
    const ids = [idOfAsk(state, 'one'), idOfAsk(state, 'two')];
    state = apply(state, { t: 'unask', id: idOfAsk(state, 'one') });
    state = apply(state, ask('three'));
    ids.push(idOfAsk(state, 'three'));
    state = apply(apply(state, { t: 'clear' }), ask('four'));
    ids.push(idOfAsk(state, 'four'));
    expect(new Set(ids).size).toBe(4);
  });

  it('removes an ask together with the comment written on that ask, and keeps other comments', () => {
    const asked = run(ask('rate-limit'), note(nodeKey('web'), 'keep me'));
    const id = idOfAsk(asked, 'rate-limit');
    const state = apply(apply(asked, note(nodeKey(id), 'which limit?')), { t: 'unask', id });
    expect(state.present).toEqual([noteChange('n:web', 'keep me')]);
  });

  it('drops one change by its position and keeps the others in order', () => {
    const state = run(note(nodeKey('web'), 'a'), note(nodeKey('api'), 'b'), note(edgeKey(0), 'c'));
    expect(noteTargets(apply(state, { t: 'remove', index: 1 }))).toEqual(['n:web', 'e:0']);
  });

  it('undoes one change at a time, including a replaced comment, and stops at the empty draft', () => {
    const state = run(note(nodeKey('web'), 'a'), note(nodeKey('api'), 'b'), note(nodeKey('web'), 'c'));
    const once = apply(state, { t: 'undo' });
    expect(once.present).toEqual([noteChange('n:web', 'a'), noteChange('n:api', 'b')]);
    const twice = apply(once, { t: 'undo' });
    expect(twice.present).toEqual([noteChange('n:web', 'a')]);
    const emptied = apply(twice, { t: 'undo' });
    expect(emptied.present).toEqual([]);
    expect(apply(emptied, { t: 'undo' })).toEqual(emptied);
  });
});

describe('viewOf', () => {
  it('maps the comments by target and lists the asks', () => {
    const changes: Change[] = [noteChange('n:web', 'a'), { kind: 'ask', id: 'ask-7', after: 'api', text: 'x' }, noteChange('e:0', 'b')];
    const view = viewOf(changes);
    expect(Object.fromEntries(view.notes)).toEqual({ 'n:web': 'a', 'e:0': 'b' });
    expect(view.asks).toEqual([{ id: 'ask-7', after: 'api', text: 'x' }]);
  });
});

describe('withAsks', () => {
  it('returns the same flow when there is nothing to add', () => {
    expect(withAsks(flow, [])).toBe(flow);
  });

  it('adds a part to create for each ask, linked as a new "requested" link from the part it follows', () => {
    const out = withAsks(flow, [{ id: 'ask-1', after: 'api', text: 'rate-limit' }, { id: 'ask-2', after: 'web', text: 'cache' }]);
    const added = out.nodes.filter((candidate) => candidate.id.startsWith('ask-'));
    expect(added.map(({ id, state, steps }) => ({ id, state, steps }))).toEqual([
      { id: 'ask-1', state: 'create', steps: [] },
      { id: 'ask-2', state: 'create', steps: [] },
    ]);
    expect(out.edges.slice(flow.edges.length)).toEqual([
      expect.objectContaining({ from: 'api', to: 'ask-1', label: 'requested', state: 'new' }),
      expect.objectContaining({ from: 'web', to: 'ask-2', label: 'requested', state: 'new' }),
    ]);
    expect(out.nodes.slice(0, flow.nodes.length)).toEqual(flow.nodes);
  });
});

describe('describe and message', () => {
  const changes: Change[] = [
    { kind: 'ask', id: 'ask-1', after: 'svc', text: 'rate-limit sign-ups per IP' },
    noteChange(nodeKey('api'), 'return 409 on a duplicate'),
    noteChange(edgeKey(1), 'pass the email lowercased'),
  ];

  it('describes each change by its group, its place in the draft and the parts it points at', () => {
    expect(describeChanges(changes, flow)).toEqual([
      { group: 'ask', index: 0, title: 'after OrderService (svc)', detail: 'rate-limit sign-ups per IP' },
      { group: 'note', index: 1, title: 'POST /orders (api)', detail: 'return 409 on a duplicate' },
      { group: 'note', index: 2, title: 'POST /orders (api) → OrderService (svc)', detail: 'pass the email lowercased' },
    ]);
  });

  it('writes the revise request with Notes before Add, whatever order the changes were drafted in', () => {
    expect(message(describeChanges(changes, flow))).toBe([
      'Please revise the plan.',
      '',
      'Notes',
      '- POST /orders (api): return 409 on a duplicate',
      '- POST /orders (api) → OrderService (svc): pass the email lowercased',
      '',
      'Add',
      '- after OrderService (svc): rate-limit sign-ups per IP',
    ].join('\n'));
  });

  it('leaves out a group that has no items', () => {
    const onlyAsks = message(describeChanges([changes[0] as Change], flow));
    expect(onlyAsks).toContain('Add');
    expect(onlyAsks).not.toContain('Notes');
    const onlyNotes = message(describeChanges(changes.slice(1), flow));
    expect(onlyNotes).toContain('Notes');
    expect(onlyNotes).not.toContain('Add');
  });
});
