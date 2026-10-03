import { describe, expect, it } from 'vitest';
import type { PlanFlow, PlanFlowEdge, PlanFlowNode, PlanStatus, PlanView } from '@ide/protocol';
import {
  connections, edgePhase, flowOf, focusSet, nodePhase, nowFlow, pickFocus, rationale, stepBadges, stepPhase, summarize,
} from '../src/plan-flow/flow-model';
import { limitPlan, userPlan, withProgress } from './flow-fixtures';

const flowIn = (plan: PlanView): PlanFlow => {
  if (!plan.flow) throw new Error('fixture plan has no flow');
  return plan.flow;
};

const nodeIn = (flow: PlanFlow, id: string): PlanFlowNode => {
  const found = flow.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};

const node = (id: string, steps: string[], overrides: Partial<PlanFlowNode> = {}): PlanFlowNode => (
  { id, title: id, sub: '', kind: 'module', state: 'existing', steps, files: [], ...overrides }
);

const edge = (from: string, to: string, overrides: Partial<PlanFlowEdge> = {}): PlanFlowEdge => (
  { from, to, label: '', state: 'existing', ...overrides }
);

const ids = (set: Set<string>): string[] => [...set].sort();
const indexes = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);

const withRationales = (plan: PlanView, rationales: Record<string, string>): PlanView => ({
  ...plan,
  steps: plan.steps.map((step) => ({ ...step, rationale: rationales[step.key] ?? step.rationale })),
});

describe('flowOf', () => {
  it.each<PlanStatus>(['proposed', 'approved', 'done'])('returns the flow while the plan is %s', (status) => {
    const plan = userPlan({ status });
    expect(flowOf(plan)).toEqual(flowIn(plan));
  });

  it.each<PlanStatus>(['rejected', 'withdrawn', 'superseded', 'changes-requested'])('returns null while the plan is %s', (status) => {
    expect(flowOf(userPlan({ status }))).toBeNull();
  });

  it('returns null for a plan without a flow', () => {
    expect(flowOf(userPlan({ flow: null }))).toBeNull();
  });

  it('returns null for no plan', () => {
    expect(flowOf(null)).toBeNull();
  });
});

describe('stepPhase', () => {
  it('reports every step as proposed while the plan waits for the user', () => {
    const plan = userPlan();
    expect(plan.steps.map((step) => [step.key, stepPhase(plan, step.key)])).toEqual([
      ['model', 'proposed'], ['schemas', 'proposed'], ['service', 'proposed'], ['route', 'proposed'], ['tests', 'proposed'],
    ]);
  });

  it('reports a waiting plan as proposed even when its steps carry another status', () => {
    const waiting: PlanView = { ...withProgress(userPlan(), 2), status: 'proposed' };
    expect(waiting.steps.map((step) => stepPhase(waiting, step.key))).toEqual(['proposed', 'proposed', 'proposed', 'proposed', 'proposed']);
  });

  it('reports the status of each step once the plan runs', () => {
    const plan = withProgress(userPlan(), 2);
    expect(plan.steps.map((step) => [step.key, stepPhase(plan, step.key)])).toEqual([
      ['model', 'done'], ['schemas', 'done'], ['service', 'active'], ['route', 'pending'], ['tests', 'pending'],
    ]);
  });

  it('reports every step as done once the plan is done', () => {
    const plan = withProgress(userPlan(), 5);
    expect(plan.status).toBe('done');
    expect(plan.steps.map((step) => stepPhase(plan, step.key))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('reports a key that is not in the plan as pending', () => {
    expect(stepPhase(withProgress(userPlan(), 2), 'ghost')).toBe('pending');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats the unknown key %s as an ordinary missing key', (key) => {
    expect(stepPhase(withProgress(userPlan(), 2), key)).toBe('pending');
  });

  it('reads the status of a step whose key is named like an Object member', () => {
    const base = withProgress(userPlan(), 1);
    const plan: PlanView = {
      ...base,
      steps: base.steps.map((step, index) => ({ ...step, key: ['constructor', '__proto__', 'toString', 'a', 'b'][index] ?? step.key })),
    };
    expect(['constructor', '__proto__', 'toString', 'a', 'b'].map((key) => stepPhase(plan, key))).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
  });
});

describe('nodePhase', () => {
  it('marks every node that has steps proposed and a node without steps none while the plan waits', () => {
    const plan = userPlan();
    expect(flowIn(plan).nodes.map((candidate) => [candidate.id, nodePhase(plan, candidate)])).toEqual([
      ['client', 'none'], ['route', 'proposed'], ['schemas', 'proposed'], ['service', 'proposed'], ['security', 'none'],
      ['model', 'proposed'], ['session', 'none'], ['db', 'proposed'], ['tests', 'proposed'],
    ]);
  });

  it('follows the progress of the steps a node names, and shares a step between two nodes', () => {
    const plan = withProgress(userPlan(), 2);
    expect(flowIn(plan).nodes.map((candidate) => [candidate.id, nodePhase(plan, candidate)])).toEqual([
      ['client', 'none'], ['route', 'pending'], ['schemas', 'done'], ['service', 'active'], ['security', 'none'],
      ['model', 'done'], ['session', 'none'], ['db', 'done'], ['tests', 'pending'],
    ]);
  });

  it('marks every node with steps done once the plan is done', () => {
    const plan = withProgress(userPlan(), 5);
    expect(flowIn(plan).nodes.map((candidate) => nodePhase(plan, candidate))).toEqual([
      'none', 'done', 'done', 'done', 'none', 'done', 'none', 'done', 'done',
    ]);
  });

  it('is pending for a node with one done and one pending step', () => {
    const plan = withProgress(userPlan(), 2);
    expect(nodePhase(plan, node('both', ['model', 'tests']))).toBe('pending');
  });

  it('is active for a node with one done and one active step', () => {
    const plan = withProgress(userPlan(), 2);
    expect(nodePhase(plan, node('both', ['model', 'service']))).toBe('active');
  });

  it('is active for a node with one active and one pending step', () => {
    const plan = withProgress(userPlan(), 2);
    expect(nodePhase(plan, node('both', ['service', 'tests']))).toBe('active');
  });

  it('is done for a node whose two steps are both done', () => {
    const plan = withProgress(userPlan(), 2);
    expect(nodePhase(plan, node('both', ['model', 'schemas']))).toBe('done');
  });

  it('is proposed for a node with several steps while the plan waits', () => {
    expect(nodePhase(userPlan(), node('both', ['model', 'tests']))).toBe('proposed');
  });

  it('is none for a node without steps whatever the plan does', () => {
    expect([null, 0, 3, 5].map((done) => nodePhase(withProgress(userPlan(), done), node('bare', [])))).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('edgePhase', () => {
  it('follows the phase of the step the edge belongs to', () => {
    const plan = withProgress(userPlan(), 2);
    expect([
      edgePhase(plan, edge('service', 'model', { state: 'new', step: 'model' })),
      edgePhase(plan, edge('service', 'model', { state: 'new', step: 'service' })),
      edgePhase(plan, edge('service', 'model', { state: 'new', step: 'route' })),
    ]).toEqual(['done', 'active', 'pending']);
  });

  it('marks the edges of a waiting plan proposed', () => {
    expect(edgePhase(userPlan(), edge('route', 'service', { state: 'new', step: 'route' }))).toBe('proposed');
  });

  it('is none for an existing edge without a step, in a waiting plan and in a running one', () => {
    const existing = flowIn(userPlan()).edges[6];
    expect(existing).toMatchObject({ from: 'session', to: 'db', state: 'existing' });
    expect([userPlan(), withProgress(userPlan(), 2), withProgress(userPlan(), 5)].map((plan) => edgePhase(plan, existing))).toEqual(['none', 'none', 'none']);
  });

  it('follows the step of a removed edge too', () => {
    const plan = withProgress(limitPlan(), 2);
    const removed = flowIn(plan).edges[1];
    expect(removed).toMatchObject({ from: 'auth', to: 'routes', state: 'removed', step: 'limiter' });
    expect(edgePhase(plan, removed)).toBe('active');
  });

  it('is pending for an edge whose step is not in the plan', () => {
    expect(edgePhase(withProgress(userPlan(), 2), edge('a', 'b', { state: 'new', step: 'ghost' }))).toBe('pending');
  });
});

describe('stepBadges', () => {
  it('numbers a node by the position of its step in the plan', () => {
    const plan = userPlan();
    expect(stepBadges(plan, nodeIn(flowIn(plan), 'route'))).toEqual([{ n: 4, phase: 'proposed' }]);
  });

  it('lists the steps of a node by number, whatever order the node names them in', () => {
    const plan = withProgress(userPlan(), 2);
    expect(stepBadges(plan, node('mixed', ['tests', 'model']))).toEqual([{ n: 1, phase: 'done' }, { n: 5, phase: 'pending' }]);
  });

  it('carries the phase of each step', () => {
    const plan = withProgress(userPlan(), 2);
    expect(stepBadges(plan, node('three', ['route', 'service', 'schemas']))).toEqual([
      { n: 2, phase: 'done' }, { n: 3, phase: 'active' }, { n: 4, phase: 'pending' },
    ]);
  });

  it('skips a step key that is not in the plan', () => {
    const plan = userPlan();
    expect(stepBadges(plan, node('half', ['ghost', 'route']))).toEqual([{ n: 4, phase: 'proposed' }]);
  });

  it('gives no badge to a node whose steps are all unknown, or to a node without steps', () => {
    const plan = userPlan();
    expect([stepBadges(plan, node('lost', ['ghost', 'constructor', '__proto__'])), stepBadges(plan, node('bare', []))]).toEqual([[], []]);
  });

  it('gives a node with no steps no badge in the flow of a finished plan either', () => {
    const plan = withProgress(limitPlan(), 5);
    expect(stepBadges(plan, nodeIn(flowIn(plan), 'client'))).toEqual([]);
  });
});

describe('nowFlow', () => {
  it('keeps the nodes that exist today and only the existing edges between them (user plan)', () => {
    const today = nowFlow(flowIn(userPlan()));
    expect(today.nodes.map((candidate) => candidate.id)).toEqual(['client', 'security', 'model', 'session', 'db']);
    expect(today.edges).toEqual([
      { from: 'session', to: 'db', label: 'SQL', state: 'existing' },
      { from: 'model', to: 'db', label: 'maps to', state: 'existing' },
    ]);
  });

  it('keeps the nodes that will change or go, and the removed edges between them (limit plan)', () => {
    const today = nowFlow(flowIn(limitPlan()));
    expect(today.nodes.map((candidate) => [candidate.id, candidate.state])).toEqual([
      ['client', 'existing'], ['auth', 'modify'], ['settings', 'modify'], ['routes', 'existing'], ['throttle', 'delete'],
    ]);
    expect(today.edges.map((candidate) => [candidate.from, candidate.to, candidate.state])).toEqual([
      ['client', 'auth', 'existing'], ['auth', 'routes', 'removed'], ['routes', 'throttle', 'removed'],
    ]);
  });

  it('drops a new edge even when both of its ends exist today', () => {
    const flow: PlanFlow = {
      nodes: [node('a', []), node('b', [])],
      edges: [edge('a', 'b', { label: 'old', state: 'existing' }), edge('a', 'b', { label: 'fresh', state: 'new' })],
    };
    expect(nowFlow(flow).edges.map((candidate) => candidate.label)).toEqual(['old']);
  });

  it('drops a removed edge that touches a node created by the plan', () => {
    const flow: PlanFlow = {
      nodes: [node('a', []), node('fresh', ['s'], { state: 'create' }), node('c', [])],
      edges: [edge('a', 'fresh', { state: 'removed' }), edge('fresh', 'c', { state: 'existing' }), edge('a', 'c', { state: 'removed' })],
    };
    const today = nowFlow(flow);
    expect(today.nodes.map((candidate) => candidate.id)).toEqual(['a', 'c']);
    expect(today.edges).toEqual([edge('a', 'c', { state: 'removed' })]);
  });

  it('returns the whole graph when nothing in it is new', () => {
    const flow: PlanFlow = {
      nodes: [node('a', []), node('b', ['s'], { state: 'modify' }), node('c', ['t'], { state: 'delete' })],
      edges: [edge('a', 'b'), edge('b', 'c', { state: 'removed', step: 't' })],
    };
    expect(nowFlow(flow)).toEqual(flow);
  });

  it('does not change the flow it is given', () => {
    const flow = flowIn(limitPlan());
    const before = structuredClone(flow);
    nowFlow(flow);
    expect(flow).toEqual(before);
  });
});

describe('focusSet', () => {
  it('is null without a focus', () => {
    expect(focusSet(flowIn(userPlan()), null)).toBeNull();
  });

  it('for a step gives the nodes of the step, its edges and both ends of those edges', () => {
    const focus = focusSet(flowIn(userPlan()), { step: 'service' });
    expect(focus && ids(focus.nodes)).toEqual(['model', 'security', 'service', 'session']);
    expect(focus && indexes(focus.edges)).toEqual([3, 4, 5]);
  });

  it('for a step reaches the client through the edge of the first step', () => {
    const focus = focusSet(flowIn(userPlan()), { step: 'route' });
    expect(focus && ids(focus.nodes)).toEqual(['client', 'route', 'schemas', 'service']);
    expect(focus && indexes(focus.edges)).toEqual([0, 1, 2]);
  });

  it('for a step without edges gives just the nodes that name it', () => {
    const focus = focusSet(flowIn(userPlan()), { step: 'model' });
    expect(focus && ids(focus.nodes)).toEqual(['db', 'model']);
    expect(focus && indexes(focus.edges)).toEqual([]);
  });

  it('for a step includes a removed edge and its ends', () => {
    const focus = focusSet(flowIn(limitPlan()), { step: 'limiter' });
    expect(focus && ids(focus.nodes)).toEqual(['auth', 'limiter', 'redis', 'routes', 'settings']);
    expect(focus && indexes(focus.edges)).toEqual([1, 3, 4, 5]);
  });

  it('for a step that nothing names gives empty sets', () => {
    const focus = focusSet(flowIn(userPlan()), { step: 'ghost' });
    expect(focus && ids(focus.nodes)).toEqual([]);
    expect(focus && indexes(focus.edges)).toEqual([]);
  });

  it('for a node gives the node, every edge that touches it and the other end of each', () => {
    const focus = focusSet(flowIn(userPlan()), { node: 'route' });
    expect(focus && ids(focus.nodes)).toEqual(['client', 'route', 'schemas', 'service', 'tests']);
    expect(focus && indexes(focus.edges)).toEqual([0, 1, 2, 8]);
  });

  it('for a node follows incoming edges as well as outgoing ones', () => {
    const focus = focusSet(flowIn(userPlan()), { node: 'db' });
    expect(focus && ids(focus.nodes)).toEqual(['db', 'model', 'session']);
    expect(focus && indexes(focus.edges)).toEqual([6, 7]);
  });

  it('for a node without edges gives just that node', () => {
    const flow: PlanFlow = { nodes: [node('solo', []), node('a', []), node('b', [])], edges: [edge('a', 'b')] };
    const focus = focusSet(flow, { node: 'solo' });
    expect(focus && ids(focus.nodes)).toEqual(['solo']);
    expect(focus && indexes(focus.edges)).toEqual([]);
  });

  it('for a node that is not in the flow gives that id alone and no edges', () => {
    const focus = focusSet(flowIn(userPlan()), { node: 'gone' });
    expect(focus && ids(focus.nodes)).toEqual(['gone']);
    expect(focus && indexes(focus.edges)).toEqual([]);
  });

  it('does not throw when the focused node vanished from a flow with no nodes at all', () => {
    const focus = focusSet({ nodes: [], edges: [] }, { node: 'gone' });
    expect(focus && ids(focus.nodes)).toEqual(['gone']);
    expect(focus && indexes(focus.edges)).toEqual([]);
  });
});

describe('pickFocus', () => {
  it.each<[string, string | null, string | null, string | null, ReturnType<typeof pickFocus>]>([
    ['nothing is given', null, null, null, null],
    ['only a selection is given', null, null, 'sel', { node: 'sel' }],
    ['only a hovered node is given', null, 'hn', null, { node: 'hn' }],
    ['a hovered node and a selection are given', null, 'hn', 'sel', { node: 'hn' }],
    ['only a hovered step is given', 'hs', null, null, { step: 'hs' }],
    ['a hovered step and a selection are given', 'hs', null, 'sel', { step: 'hs' }],
    ['a hovered step and a hovered node are given', 'hs', 'hn', null, { step: 'hs' }],
    ['all three are given', 'hs', 'hn', 'sel', { step: 'hs' }],
  ])('when %s', (_label, hoverStep, hoverNode, selected, expected) => {
    expect(pickFocus(hoverStep, hoverNode, selected)).toEqual(expected);
  });
});

describe('summarize', () => {
  it('counts what the user plan creates, changes and links', () => {
    expect(summarize(flowIn(userPlan()))).toEqual({ created: 4, modified: 2, removed: 0, links: 7, files: 7 });
  });

  it('counts what the limit plan creates, changes, removes and links', () => {
    expect(summarize(flowIn(limitPlan()))).toEqual({ created: 2, modified: 2, removed: 1, links: 5, files: 7 });
  });

  it('counts a file path once when several nodes list it', () => {
    const flow: PlanFlow = {
      nodes: [
        node('a', [], { files: [{ op: '~', path: 'src/x.ts' }, { op: '+', path: 'src/y.ts' }] }),
        node('b', [], { files: [{ op: '~', path: 'src/x.ts' }] }),
      ],
      edges: [],
    };
    expect(summarize(flow).files).toBe(2);
  });

  it('counts file paths named like Object members as ordinary paths', () => {
    const flow: PlanFlow = {
      nodes: [node('a', [], { files: [{ op: '+', path: 'constructor' }, { op: '+', path: '__proto__' }, { op: '+', path: 'toString' }] })],
      edges: [],
    };
    expect(summarize(flow).files).toBe(3);
  });

  it('counts only new edges as links, not existing or removed ones', () => {
    const flow: PlanFlow = {
      nodes: [node('a', []), node('b', [])],
      edges: [edge('a', 'b', { state: 'existing' }), edge('a', 'b', { state: 'removed' }), edge('a', 'b', { state: 'new' })],
    };
    expect(summarize(flow).links).toBe(1);
  });

  it('counts an empty flow as zeros', () => {
    expect(summarize({ nodes: [], edges: [] })).toEqual({ created: 0, modified: 0, removed: 0, links: 0, files: 0 });
  });
});

describe('connections', () => {
  it('lists the edges that touch a node in flow order, with the node at the other end and the direction', () => {
    const flow = flowIn(userPlan());
    expect(connections(flow, 'service')).toEqual([
      { edge: flow.edges[2], other: nodeIn(flow, 'route'), outgoing: false },
      { edge: flow.edges[3], other: nodeIn(flow, 'security'), outgoing: true },
      { edge: flow.edges[4], other: nodeIn(flow, 'model'), outgoing: true },
      { edge: flow.edges[5], other: nodeIn(flow, 'session'), outgoing: true },
    ]);
  });

  it('lists a node that only receives edges as incoming', () => {
    const flow = flowIn(userPlan());
    expect(connections(flow, 'db').map((link) => [link.other.id, link.outgoing])).toEqual([['session', false], ['model', false]]);
  });

  it('lists a removed edge like any other', () => {
    const flow = flowIn(limitPlan());
    expect(connections(flow, 'routes').map((link) => [link.edge.state, link.other.id, link.outgoing])).toEqual([
      ['removed', 'auth', false], ['new', 'limiter', false], ['removed', 'throttle', true],
    ]);
  });

  it('is empty for a node with no edges', () => {
    const flow: PlanFlow = { nodes: [node('solo', []), node('a', []), node('b', [])], edges: [edge('a', 'b')] };
    expect(connections(flow, 'solo')).toEqual([]);
  });

  it('is empty for an id that is not in the flow', () => {
    expect([connections(flowIn(userPlan()), 'nope'), connections(flowIn(userPlan()), 'gone')]).toEqual([[], []]);
  });
});

describe('ids named like Object members', () => {
  const flow: PlanFlow = {
    nodes: [node('constructor', ['__proto__']), node('__proto__', ['toString']), node('toString', []), node('plain', [])],
    edges: [
      edge('constructor', '__proto__', { state: 'new', step: 'toString' }),
      edge('__proto__', 'toString'),
      edge('toString', 'plain', { state: 'new', step: 'constructor' }),
    ],
  };

  it.each([
    ['constructor', ['__proto__', 'constructor'], [0]],
    ['__proto__', ['__proto__', 'constructor', 'toString'], [0, 1]],
    ['toString', ['__proto__', 'plain', 'toString'], [1, 2]],
  ])('focuses the node %s like any other id', (id, expectedNodes, expectedEdges) => {
    const focus = focusSet(flow, { node: id });
    expect(focus && ids(focus.nodes)).toEqual(expectedNodes);
    expect(focus && indexes(focus.edges)).toEqual(expectedEdges);
  });

  it('focuses a step whose key is named like an Object member', () => {
    const focus = focusSet(flow, { step: 'toString' });
    expect(focus && ids(focus.nodes)).toEqual(['__proto__', 'constructor']);
    expect(focus && indexes(focus.edges)).toEqual([0]);
  });

  it('lists the connections of a node named __proto__', () => {
    expect(connections(flow, '__proto__')).toEqual([
      { edge: flow.edges[0], other: nodeIn(flow, 'constructor'), outgoing: false },
      { edge: flow.edges[1], other: nodeIn(flow, 'toString'), outgoing: true },
    ]);
  });

  it('lists the connections of a node named toString', () => {
    expect(connections(flow, 'toString')).toEqual([
      { edge: flow.edges[1], other: nodeIn(flow, '__proto__'), outgoing: false },
      { edge: flow.edges[2], other: nodeIn(flow, 'plain'), outgoing: true },
    ]);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('treats %s as an unknown id in a flow that has no such node', (id) => {
    const regular = flowIn(userPlan());
    const focus = focusSet(regular, { node: id });
    expect([connections(regular, id), focus && ids(focus.nodes), focus && indexes(focus.edges)]).toEqual([[], [id], []]);
  });
});

describe('rationale', () => {
  it('returns the rationale of the step a node names', () => {
    const plan = userPlan();
    expect(rationale(plan, nodeIn(flowIn(plan), 'route'))).toBe('Thin handler: validate, call the service, map a duplicate to 409.');
  });

  it('returns the rationale of the shared step for each node that names it', () => {
    const plan = userPlan();
    const flow = flowIn(plan);
    expect([rationale(plan, nodeIn(flow, 'model')), rationale(plan, nodeIn(flow, 'db'))]).toEqual([
      'The users table has no email or password hash yet.', 'The users table has no email or password hash yet.',
    ]);
  });

  it('returns an empty string for a node without steps', () => {
    const plan = userPlan();
    expect(rationale(plan, nodeIn(flowIn(plan), 'client'))).toBe('');
  });

  it('returns an empty string for a node whose steps are not in the plan', () => {
    expect(rationale(userPlan(), node('lost', ['ghost', 'constructor']))).toBe('');
  });

  it('returns the first rationale when a node names several steps', () => {
    const plan = userPlan();
    expect(rationale(plan, node('both', ['model', 'schemas']))).toBe('The users table has no email or password hash yet.');
  });

  it('skips an empty rationale and returns the next one', () => {
    const plan = withRationales(userPlan(), { model: '', schemas: 'Schemas keep the ORM model off the wire.' });
    expect(rationale(plan, node('both', ['model', 'schemas']))).toBe('Schemas keep the ORM model off the wire.');
  });

  it('returns an empty string when every named step has an empty rationale', () => {
    const plan = withRationales(userPlan(), { model: '', schemas: '' });
    expect(rationale(plan, node('both', ['model', 'schemas']))).toBe('');
  });

  it('keeps working once the plan has progressed', () => {
    const plan = withProgress(limitPlan(), 3);
    expect(rationale(plan, nodeIn(flowIn(plan), 'limiter'))).toBe('One place decides 429 for every route.');
  });
});
