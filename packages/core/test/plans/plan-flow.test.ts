import { describe, expect, it } from 'vitest';
import type { FrozenScope, PlanFlow, PlanFlowNode, PlanStep, PlanTarget } from '@ide/protocol';
import { flowNotes, parsePlanFlow } from '../../src/plans/plan-flow';

const keys: ReadonlySet<string> = new Set(['a', 'b']);
const named: ReadonlySet<string> = new Set(['draft', 'ship']);
const toRel = (path: string): string | null => (path.startsWith('..') ? null : path);

const parse = (raw: unknown, stepKeys: ReadonlySet<string> = keys) => parsePlanFlow(raw, stepKeys, toRel);

function parsed(raw: unknown, stepKeys: ReadonlySet<string> = keys): PlanFlow {
  const result = parse(raw, stepKeys);
  if (result === null || typeof result === 'string') throw new Error(`expected a flow, got ${JSON.stringify(result)}`);
  return result;
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, kind: 'service', state: 'existing', ...extra });
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from, to, state: 'existing', ...extra });
const omit = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const file = (path: string, extra: Record<string, unknown> = {}) => ({ op: '~', path, ...extra });
const pairs = (count: number) => {
  const ids = Array.from({ length: 10 }, (_, index) => `n${index}`);
  return ids.flatMap((from) => ids.filter((to) => to !== from).map((to) => edge(from, to))).slice(0, count);
};

type Mention = string | RegExp;

function refused(result: unknown, ...mentions: Mention[]): void {
  expect(result).toEqual(expect.stringMatching(/^CodeRay: /));
  for (const mention of mentions) {
    expect(result).toEqual(typeof mention === 'string' ? expect.stringContaining(mention) : expect.stringMatching(mention));
  }
}

const route = node('route', { kind: 'endpoint', state: 'create', steps: ['a'] });
const db = node('db', { kind: 'store' });
const KINDS = ['actor', 'endpoint', 'schema', 'service', 'module', 'model', 'store', 'external', 'test'];

describe('parsePlanFlow', () => {
  it.each([undefined, null])('returns null when the flow is %s', (raw) => {
    expect(parse(raw)).toBeNull();
  });

  it('fills the defaults of a valid flow and trims its texts', () => {
    expect(parse({
      nodes: [
        { id: 'route', title: ' POST /users ', sub: ' Endpoint ', kind: 'endpoint', state: 'create', steps: ['a'], files: [{ op: '+', path: 'src/routes.ts', note: ' create_user ' }] },
        { id: 'db', title: 'users', kind: 'store', state: 'existing' },
      ],
      edges: [
        { from: 'route', to: 'db', label: ' insert ', state: 'new', step: 'b' },
        { from: 'db', to: 'route', state: 'existing' },
      ],
    })).toEqual({
      nodes: [
        { id: 'route', title: 'POST /users', sub: 'Endpoint', kind: 'endpoint', state: 'create', steps: ['a'], files: [{ op: '+', path: 'src/routes.ts', note: 'create_user' }] },
        { id: 'db', title: 'users', sub: '', kind: 'store', state: 'existing', steps: [], files: [] },
      ],
      edges: [
        { from: 'route', to: 'db', label: 'insert', state: 'new', step: 'b' },
        { from: 'db', to: 'route', label: '', state: 'existing' },
      ],
    });
  });

  describe('file paths', () => {
    const inProject = (path: string): string | null => (path.startsWith('/proj/') ? path.slice('/proj/'.length) : null);
    const twoNodes = (paths: string[][]) => ({ nodes: paths.map((list, index) => node(`n${index}`, { files: list.map((path) => file(path)) })) });

    it('stores every file path in the project-relative form toRel gives, on every node', () => {
      const flow = parsePlanFlow(twoNodes([['/proj/src/a.ts', '/proj/src/b.ts'], ['/proj/lib/c.ts']]), keys, inProject) as PlanFlow;
      expect(flow.nodes.map((n) => n.files.map((f) => f.path))).toEqual([['src/a.ts', 'src/b.ts'], ['lib/c.ts']]);
    });

    it('refuses a path toRel rejects, naming the node and the path', () => {
      refused(parsePlanFlow(twoNodes([['/proj/src/a.ts', '/elsewhere/x.ts']]), keys, inProject), 'n0', '/elsewhere/x.ts');
    });

    it('refuses a rejected path on the last file of a later node', () => {
      refused(parsePlanFlow(twoNodes([['/proj/src/a.ts'], ['/proj/src/b.ts', '/outside/z.ts']]), keys, inProject), 'n1', '/outside/z.ts');
    });

    it('refuses a path the default toRel finds outside the project', () => {
      refused(parse({ nodes: [node('svc', { files: [file('../secret.ts')] })] }), 'svc', '../secret.ts');
    });
  });

  describe('refuses', () => {
    const cases: { label: string; raw: unknown; mentions: Mention[]; stepKeys?: ReadonlySet<string> }[] = [
      { label: 'a flow that is a string', raw: 'nope', mentions: [/\bflow\b/] },
      { label: 'a flow that is a number', raw: 42, mentions: [/\bflow\b/] },
      { label: 'a flow that is a list', raw: [node('a')], mentions: [/\bflow\b/] },
      { label: 'a flow without nodes', raw: {}, mentions: [/\bnodes\b/] },
      { label: 'nodes that are a string', raw: { nodes: 'x' }, mentions: [/\bnodes\b/] },
      { label: 'nodes that are an object', raw: { nodes: { a: node('a') } }, mentions: [/\bnodes\b/] },
      { label: 'zero nodes', raw: { nodes: [] }, mentions: [/\bnode/] },
      { label: '41 nodes, naming the limit of 40', raw: { nodes: Array.from({ length: 41 }, (_, index) => node(`n${index}`)) }, mentions: ['40'] },
      { label: '81 edges, naming the limit of 80', raw: { nodes: Array.from({ length: 10 }, (_, index) => node(`n${index}`)), edges: pairs(81) }, mentions: ['80'] },
      {
        label: '21 files on one node, naming the node and the limit of 20',
        raw: { nodes: [node('crowded', { files: Array.from({ length: 21 }, (_, index) => file(`src/f${index}.ts`)) })] },
        mentions: ['crowded', '20'],
      },
      { label: 'two nodes with one id', raw: { nodes: [node('dup'), node('dup')] }, mentions: ['dup'] },
      { label: 'a node without an id', raw: { nodes: [omit(node('x'), 'id')] }, mentions: [/\bid\b/] },
      { label: 'a node with a blank id', raw: { nodes: [node('  ')] }, mentions: [/\bid\b/] },
      { label: 'a node whose id is a number', raw: { nodes: [node('x', { id: 7 })] }, mentions: [/\bid\b/] },
      { label: 'a node without a title', raw: { nodes: [omit(node('x'), 'title')] }, mentions: ['x', /\btitle\b/] },
      { label: 'a node with a blank title', raw: { nodes: [node('x', { title: '   ' })] }, mentions: ['x', /\btitle\b/] },
      { label: 'a node of an unknown kind, listing the kinds', raw: { nodes: [node('x', { kind: 'robot' })] }, mentions: ['x', 'robot', ...KINDS] },
      { label: 'a node of an unknown state, listing the states', raw: { nodes: [node('x', { state: 'maybe' })] }, mentions: ['x', 'maybe', 'existing', 'modify', 'create', 'delete'] },
      { label: 'node steps that are a string', raw: { nodes: [node('x', { steps: 'a' })] }, mentions: ['x', /\bsteps\b/] },
      { label: 'node steps that are an object', raw: { nodes: [node('x', { steps: { 0: 'a' } })] }, mentions: ['x', /\bsteps\b/] },
      {
        label: 'a node step key the plan does not have, listing the step keys',
        raw: { nodes: [node('x', { state: 'create', steps: ['draft', 'zzz'] })] },
        mentions: ['x', 'zzz', 'draft', 'ship'],
        stepKeys: named,
      },
      {
        label: 'a step key the plan does not have on an existing node',
        raw: { nodes: [node('x', { steps: ['zzz'] })] },
        mentions: ['x', 'zzz', 'draft', 'ship'],
        stepKeys: named,
      },
      { label: 'a create node without steps', raw: { nodes: [node('x', { state: 'create' })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a create node with empty steps', raw: { nodes: [node('x', { state: 'create', steps: [] })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a modify node without steps', raw: { nodes: [node('x', { state: 'modify' })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a modify node with empty steps', raw: { nodes: [node('x', { state: 'modify', steps: [] })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a delete node without steps', raw: { nodes: [node('x', { state: 'delete' })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a delete node with empty steps', raw: { nodes: [node('x', { state: 'delete', steps: [] })] }, mentions: ['x', /\bsteps?\b/] },
      { label: 'a file with an unknown op, listing the ops', raw: { nodes: [node('x', { files: [file('src/x.ts', { op: 'rename' })] })] }, mentions: ['x', 'rename', '+', '~', '-'] },
      { label: 'an edge from an unknown node, listing the node ids', raw: { nodes: [route, db], edges: [edge('ghost', 'db')] }, mentions: ['ghost', 'route', 'db'] },
      { label: 'an edge to an unknown node, listing the node ids', raw: { nodes: [route, db], edges: [edge('route', 'ghost')] }, mentions: ['ghost', 'route', 'db'] },
      { label: 'an edge from a node to itself', raw: { nodes: [route, db], edges: [edge('db', 'db')] }, mentions: ['db'] },
      { label: 'an edge of an unknown state, listing the states', raw: { nodes: [route, db], edges: [edge('route', 'db', { state: 'fuzzy' })] }, mentions: ['fuzzy', 'existing', /\bnew\b/, /\bremoved\b/] },
      { label: 'a new edge without a step', raw: { nodes: [route, db], edges: [edge('route', 'db', { state: 'new' })] }, mentions: [/\bstep\b/] },
      { label: 'a removed edge without a step', raw: { nodes: [route, db], edges: [edge('route', 'db', { state: 'removed' })] }, mentions: [/\bstep\b/] },
      {
        label: 'a new edge with a step key the plan does not have, listing the step keys',
        raw: { nodes: [db, node('cache')], edges: [edge('db', 'cache', { state: 'new', step: 'zzz' })] },
        mentions: ['zzz', 'draft', 'ship'],
        stepKeys: named,
      },
      {
        label: 'an existing edge with a step key the plan does not have',
        raw: { nodes: [db, node('cache')], edges: [edge('db', 'cache', { step: 'zzz' })] },
        mentions: ['zzz', 'draft', 'ship'],
        stepKeys: named,
      },
    ];

    it.each(cases)('$label', ({ raw, mentions, stepKeys }) => {
      refused(parse(raw, stepKeys), ...mentions);
    });
  });

  it('accepts an existing node with no steps and an existing edge with no step', () => {
    expect(parsed({ nodes: [node('x'), node('y')], edges: [edge('x', 'y')] })).toEqual({
      nodes: [
        { id: 'x', title: 'Title x', sub: '', kind: 'service', state: 'existing', steps: [], files: [] },
        { id: 'y', title: 'Title y', sub: '', kind: 'service', state: 'existing', steps: [], files: [] },
      ],
      edges: [{ from: 'x', to: 'y', label: '', state: 'existing' }],
    });
  });

  it('accepts the largest flow: 40 nodes, 80 edges and 20 files on a node', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => node(`n${index}`, index === 0 ? { files: Array.from({ length: 20 }, (_, n) => file(`src/f${n}.ts`)) } : {}));
    const flow = parsed({ nodes, edges: pairs(80) });
    expect([flow.nodes.length, flow.edges.length, flow.nodes[0]!.files.length]).toEqual([40, 80, 20]);
  });

  describe('a step key listed twice on a node', () => {
    it('is kept once', () => {
      expect(parsed({ nodes: [node('x', { state: 'modify', steps: ['a', 'a'] })] }).nodes[0]!.steps).toEqual(['a']);
    });

    it('keeps the first place of each key', () => {
      expect(parsed({ nodes: [node('x', { state: 'modify', steps: ['b', 'a', 'b'] })] }).nodes[0]!.steps).toEqual(['b', 'a']);
    });
  });

  describe('long texts', () => {
    const one = (nodeExtra: Record<string, unknown>, edgeExtra: Record<string, unknown> = {}) =>
      parsed({ nodes: [node('x', nodeExtra), node('y')], edges: [edge('x', 'y', edgeExtra)] });

    it('cuts a title over 60 characters to 60', () => {
      expect(one({ title: `${'a'.repeat(60)}${'b'.repeat(40)}` }).nodes[0]!.title).toBe('a'.repeat(60));
    });

    it('cuts a sub over 80 characters to 80', () => {
      expect(one({ sub: `${'a'.repeat(80)}${'b'.repeat(40)}` }).nodes[0]!.sub).toBe('a'.repeat(80));
    });

    it('cuts an edge label over 60 characters to 60', () => {
      expect(one({}, { label: `${'a'.repeat(60)}${'b'.repeat(40)}` }).edges[0]!.label).toBe('a'.repeat(60));
    });

    it('cuts a file note over 120 characters to 120', () => {
      expect(one({ files: [file('src/x.ts', { note: `${'a'.repeat(120)}${'b'.repeat(40)}` })] }).nodes[0]!.files[0]!.note).toBe('a'.repeat(120));
    });

    it('keeps texts exactly at their limits whole', () => {
      const flow = one({ title: 'a'.repeat(60), sub: 'b'.repeat(80), files: [file('src/x.ts', { note: 'c'.repeat(120) })] }, { label: 'd'.repeat(60) });
      expect([flow.nodes[0]!.title, flow.nodes[0]!.sub, flow.nodes[0]!.files[0]!.note, flow.edges[0]!.label])
        .toEqual(['a'.repeat(60), 'b'.repeat(80), 'c'.repeat(120), 'd'.repeat(60)]);
    });
  });

  describe('ids that Object.prototype also has', () => {
    const reserved = ['constructor', '__proto__', 'toString'];

    it('keeps nodes and the edges between them', () => {
      const flow = parsed({
        nodes: reserved.map((id) => node(id)),
        edges: [edge('constructor', '__proto__', { label: 'x' }), edge('__proto__', 'toString'), edge('toString', 'constructor')],
      });
      expect([flow.nodes.map((n) => n.id), flow.edges.map((e) => [e.from, e.to])])
        .toEqual([reserved, [['constructor', '__proto__'], ['__proto__', 'toString'], ['toString', 'constructor']]]);
    });

    it.each(reserved)('refuses an edge to %s when no node has that id', (id) => {
      refused(parse({ nodes: [route, db], edges: [edge('route', id)] }), id, 'route', 'db');
    });

    it.each(reserved)('refuses an edge from %s when no node has that id', (id) => {
      refused(parse({ nodes: [route, db], edges: [edge(id, 'db')] }), id, 'route', 'db');
    });

    it('still refuses two nodes with such an id', () => {
      refused(parse({ nodes: [node('constructor'), node('constructor')] }), 'constructor');
    });

    it('accepts a step key of the plan that has such a name', () => {
      expect(parsed({ nodes: [node('x', { state: 'modify', steps: ['toString'] })] }, new Set(['toString'])).nodes[0]!.steps).toEqual(['toString']);
    });
  });

  describe('a flow of one node', () => {
    it.each([
      ['with no edges field', { nodes: [node('solo')] }],
      ['with an empty edge list', { nodes: [node('solo')], edges: [] }],
    ])('is accepted %s', (_label, raw) => {
      expect(parsed(raw)).toEqual({ nodes: [{ id: 'solo', title: 'Title solo', sub: '', kind: 'service', state: 'existing', steps: [], files: [] }], edges: [] });
    });
  });
});

const fileNode = (id: string, ...paths: string[]): PlanFlowNode => ({
  id, title: id, sub: '', kind: 'service', state: 'modify', steps: ['s'], files: paths.map((path) => ({ op: '~', path })),
});
const flowOf = (...nodes: PlanFlowNode[]): PlanFlow => ({ nodes, edges: [] });
const stepOf = (...targets: PlanTarget[]): PlanStep => ({ key: 's', order: 1, title: 'S', rationale: '', targets });
const modify = (path: string): PlanTarget => ({ path, op: 'modify' });
const scopeOf = (paths: string[], globs: string[] = []): FrozenScope => ({ paths, globs });
const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}.ts`);

const FILES_NOTE_START = 'the flow lists ';
const FILES_NOTE_END = 'which no step targets';

describe('flowNotes', () => {
  it('gives no notes for no flow', () => {
    expect(flowNotes(null, [stepOf(modify('src/app.ts'))], scopeOf(['src/app.ts']))).toEqual([]);
  });

  it('gives no notes when every file is in scope and every path target is listed or above a listed file', () => {
    const flow = flowOf(fileNode('app', 'src/app.ts'), fileNode('deep', 'src/lib/deep/x.ts'));
    expect(flowNotes(flow, [stepOf(modify('src/app.ts'), modify('src/lib'))], scopeOf(['src/app.ts'], ['src/lib/**']))).toEqual([]);
  });

  it('counts a file as in scope when a glob such as src/** matches it', () => {
    const flow = flowOf(fileNode('deep', 'src/a/b/c.ts'));
    expect(flowNotes(flow, [stepOf({ componentId: 'core', op: 'modify' })], scopeOf([], ['src/**']))).toEqual([]);
  });

  describe('files outside the scope', () => {
    const steps = [stepOf(modify('src/app.ts'))];
    const scope = scopeOf(['src/app.ts']);
    const outside = (paths: string[]) => flowNotes(flowOf(fileNode('app', 'src/app.ts'), fileNode('extra', ...paths)), steps, scope);

    it('give one note that names the file and leaves the files in scope out', () => {
      const notes = outside(['src/extra.ts']);
      expect(notes).toEqual([expect.stringMatching(new RegExp(`^${FILES_NOTE_START}.*src/extra\\.ts.*${FILES_NOTE_END}$`))]);
      expect(notes[0]).not.toContain('src/app.ts');
    });

    it('give a single note for several files', () => {
      const notes = outside(['src/x1.ts', 'src/x2.ts']);
      expect(notes).toHaveLength(1);
      expect([notes[0]!.startsWith(FILES_NOTE_START), notes[0]!.includes('src/x1.ts'), notes[0]!.includes('src/x2.ts'), notes[0]!.endsWith(FILES_NOTE_END)])
        .toEqual([true, true, true, true]);
    });

    it('name all five when there are five and add no "and N more"', () => {
      const [note] = outside(many('src/x', 5));
      expect([many('src/x', 5).every((path) => note!.includes(path)), /more/.test(note!)]).toEqual([true, false]);
    });

    it('name the first five of six, then say "and 1 more"', () => {
      const [note] = outside(many('src/x', 6));
      expect(many('src/x', 5).every((path) => note!.includes(path))).toBe(true);
      expect(note!.includes('src/x6.ts')).toBe(false);
      expect(note).toMatch(/and 1 more/);
    });

    it('name the first five of eight, then say "and 3 more"', () => {
      const [note] = outside(many('src/x', 8));
      expect(many('src/x', 5).every((path) => note!.includes(path))).toBe(true);
      expect(['src/x6.ts', 'src/x7.ts', 'src/x8.ts'].some((path) => note!.includes(path))).toBe(false);
      expect(note).toMatch(/and 3 more/);
      expect(note!.endsWith(FILES_NOTE_END)).toBe(true);
    });
  });

  describe('path targets no node lists', () => {
    const scope = scopeOf(['src/app.ts', 'src/other.ts', 'src/lib/util.ts']);
    const listed = flowOf(fileNode('other', 'src/other.ts'));

    it('give one note, "is a step target", for one path', () => {
      const notes = flowNotes(listed, [stepOf(modify('src/app.ts'), modify('src/other.ts'))], scope);
      expect(notes).toEqual([expect.stringMatching(/src\/app\.ts is a step target that no flow node lists$/)]);
      expect(notes[0]).not.toContain('src/other.ts');
    });

    it('give one note, "are step targets", for paths of several steps and ops', () => {
      const steps = [stepOf(modify('src/app.ts')), { ...stepOf({ path: 'src/lib/util.ts', op: 'delete' }), key: 't', order: 2 }];
      const notes = flowNotes(listed, steps, scope);
      expect(notes).toHaveLength(1);
      expect([notes[0]!.includes('src/app.ts'), notes[0]!.includes('src/lib/util.ts'), notes[0]!.endsWith('are step targets that no flow node lists')])
        .toEqual([true, true, true]);
    });

    it('cut a long list to five, then say "and N more"', () => {
      const paths = many('src/t', 7);
      const notes = flowNotes(flowOf(fileNode('other', 'src/other.ts')), [stepOf(...paths.map(modify))], scopeOf([...paths, 'src/other.ts']));
      expect(notes).toHaveLength(1);
      const [note] = notes;
      expect(paths.slice(0, 5).every((path) => note!.includes(path))).toBe(true);
      expect(paths.slice(5).some((path) => note!.includes(path))).toBe(false);
      expect(note).toMatch(/and 2 more/);
      expect(note!.endsWith('are step targets that no flow node lists')).toBe(true);
    });

    it('do not count a directory whose name only starts like the directory of a listed file', () => {
      const notes = flowNotes(flowOf(fileNode('lib', 'src/library/x.ts')), [stepOf(modify('src/lib'))], scopeOf(['src/library/x.ts']));
      expect(notes).toEqual([expect.stringMatching(/src\/lib is a step target that no flow node lists$/)]);
    });

    it('never come from component targets', () => {
      const steps = [stepOf({ componentId: 'app', op: 'modify' }, { componentId: 'lib', op: 'delete' })];
      expect(flowNotes(listed, steps, scope)).toEqual([]);
    });

    it('come only from the path targets when the step also targets a component', () => {
      const steps = [stepOf({ componentId: 'app', op: 'modify' }, modify('src/lib/util.ts'))];
      expect(flowNotes(listed, steps, scope)).toEqual([expect.stringMatching(/src\/lib\/util\.ts is a step target that no flow node lists$/)]);
    });
  });

  it('puts the note about files before the note about targets', () => {
    const notes = flowNotes(flowOf(fileNode('extra', 'src/extra.ts')), [stepOf(modify('src/app.ts'))], scopeOf(['src/app.ts']));
    expect(notes).toHaveLength(2);
    expect([notes[0]!.startsWith(FILES_NOTE_START), notes[0]!.endsWith(FILES_NOTE_END), notes[1]!.endsWith('is a step target that no flow node lists')])
      .toEqual([true, true, true]);
  });
});
