import { describe, expect, it } from 'vitest';
import type { C4Container, C4ContainerComponent, C4External, C4Link, C4Model, ContainerRole, ExternalKind, MapSnapshot } from '@ide/protocol';
import { c4Graph, c4RootGraph, type EdgeKind } from '../src/c4/c4-graph';
import { folderStatus } from './snapshot';

type Graph = ReturnType<typeof c4Graph>;

const container = (name: string, role: ContainerRole, overrides: Partial<C4Container> = {}): C4Container => ({
  id: `container:${name}`,
  name,
  role,
  tech: 'Python',
  launch: [],
  entryFiles: [],
  entryMissing: [],
  files: 1,
  components: [],
  componentLinks: [],
  group: null,
  evidence: [],
  ...overrides,
});
const external = (name: string, kind: ExternalKind): C4External => ({ id: `ext:${name}`, name, kind, identifiers: [name] });
const link = (from: string, to: string, overrides: Partial<C4Link> = {}): C4Link => ({
  id: `${from}->${to}`,
  from,
  to,
  protocol: 'HTTP',
  strength: 1,
  evidence: [],
  ...overrides,
});
const model = (parts: Partial<C4Model>): C4Model => ({ containers: [], externals: [], links: [], tooling: [], warnings: [], ...parts });
const part = (id: string, near: number, files = near + 1): C4ContainerComponent => ({ id, files, near, containers: 1 });

// Components are named after their ids and own the files listed.
function snapshot(components: Record<string, string[]> = {}): MapSnapshot {
  return {
    version: 1,
    projectName: 'demo',
    status: folderStatus,
    fileEdges: [],
    components: Object.entries(components).map(([id, files]) => ({
      id,
      name: id,
      summary: `${id} summary`,
      description: '',
      files,
      keyFiles: [],
      globs: [],
      source: 'folder' as const,
      stale: false,
    })),
    files: Object.entries(components).flatMap(([id, files]) =>
      files.map((path) => ({ path, lang: 'python' as const, componentId: id, manualAssignment: false, symbols: [], parseError: false })),
    ),
  };
}

function nodeOf(graph: Graph, id: string) {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id} in ${graph.nodes.map((n) => n.id).join(', ')}`);
  return found;
}
const titleOf = (graph: Graph, id: string) => graph.nodes.find((n) => n.id === id)?.data.title ?? id;
const has = (graph: Graph, id: string) => graph.nodes.some((n) => n.id === id);
const edgesOf = (graph: Graph, kind?: EdgeKind, keep: (e: Graph['edges'][number]) => boolean = () => true) =>
  graph.edges
    .filter((e) => (kind === undefined || e.kind === kind) && keep(e))
    .map((e) => `${titleOf(graph, e.from)}->${titleOf(graph, e.to)}`)
    .sort();
const childrenOf = (graph: Graph, parentId: string, kind?: string) => graph.nodes.filter((n) => n.parentId === parentId && (!kind || n.kind === kind));

describe('c4Graph: overview', () => {
  const overview = model({
    containers: [container('proxy', 'ui'), container('backend', 'api'), container('mailer', 'worker'), container('scheduler', 'service')],
    externals: [external('PostgreSQL', 'database')],
    links: [
      link('users', 'container:proxy'),
      link('container:proxy', 'container:backend'),
      link('container:backend', 'ext:PostgreSQL'),
      link('container:mailer', 'ext:PostgreSQL'),
      link('container:scheduler', 'ext:PostgreSQL'),
    ],
  });

  it('places Users, ui, api, workers and external systems in columns from left to right', () => {
    const graph = c4Graph(snapshot(), overview, null);
    const columns = ['users', 'container:proxy', 'container:backend', 'container:mailer', 'ext:PostgreSQL'].map((id) => nodeOf(graph, id).column);
    expect(columns.slice(1).map((column, i) => column > columns[i]!)).toEqual([true, true, true, true]);
  });

  it('puts services in the workers column', () => {
    const graph = c4Graph(snapshot(), overview, null);
    expect(nodeOf(graph, 'container:scheduler').column).toBe(nodeOf(graph, 'container:mailer').column);
  });

  it('flags a container whose entry was not found', () => {
    const draft = container('draft-worker', 'worker', { entryMissing: ['app.draft_worker'], files: 0 });
    expect(nodeOf(c4Graph(snapshot(), model({ containers: [draft] }), null), draft.id).data.warn).toBe(true);
  });
});

describe('c4Graph: worker groups', () => {
  const members = ['chat', 'mail', 'sync'].map((name) => container(`${name}-worker`, 'worker', { group: 'group:workers' }));
  const workers = model({
    containers: [container('backend', 'api'), ...members],
    externals: [external('NATS', 'broker')],
    links: members.map((m) => link(m.id, 'ext:NATS', { protocol: 'NATS', strength: 2 })),
  });
  const [chat, mail] = members as [C4Container, C4Container, C4Container];

  it('draws the workers of a closed group as one group node', () => {
    const graph = c4Graph(snapshot(), workers, null);
    expect([nodeOf(graph, 'group:workers').kind, members.filter((m) => has(graph, m.id))]).toEqual(['group', []]);
  });

  it('titles a worker group with its member count', () => {
    expect(nodeOf(c4Graph(snapshot(), workers, null), 'group:workers').data.title).toBe('Workers ×3');
  });

  it('routes the links of a closed group through the group with their strength combined', () => {
    const graph = c4Graph(snapshot(), workers, null);
    expect(graph.edges.map((e) => [e.from, e.to, e.strength])).toEqual([['group:workers', 'ext:NATS', 6]]);
  });

  it('shows the members of an opened group inside it', () => {
    const graph = c4Graph(snapshot(), workers, 'group:workers');
    expect(childrenOf(graph, 'group:workers').map((n) => n.id).sort()).toEqual(members.map((m) => m.id).sort());
  });

  it('draws the links of an opened group from its members', () => {
    expect(edgesOf(c4Graph(snapshot(), workers, 'group:workers'))).toEqual(['chat-worker->NATS', 'mail-worker->NATS', 'sync-worker->NATS']);
  });

  it('opens a group member beside its group', () => {
    const graph = c4Graph(snapshot(), workers, chat.id);
    expect([nodeOf(graph, chat.id).parentId, has(graph, 'group:workers')]).toEqual([undefined, true]);
  });

  it('keeps the other members in the group while one member is open', () => {
    const graph = c4Graph(snapshot(), workers, chat.id);
    expect([nodeOf(graph, 'group:workers').data.title, has(graph, mail.id)]).toEqual(['Workers ×2', false]);
  });
});

describe('c4Graph: an opened container', () => {
  const files = { chat: ['backend/chat/engine.py'], auth: ['backend/auth/jwt.py'], utils: ['backend/utils/text.py'] };
  const backend = container('backend', 'api', { components: [part('chat', 12), part('auth', 3), part('utils', 0, 40)] });
  const opened = model({
    containers: [container('proxy', 'ui'), backend],
    externals: [external('PostgreSQL', 'database'), external('NATS', 'broker')],
    links: [
      link('container:proxy', backend.id),
      link(backend.id, 'ext:PostgreSQL', {
        protocol: 'SQL',
        strength: 3,
        evidence: [
          { path: 'backend/chat/engine.py', note: 'imports sqlalchemy' },
          { path: 'backend/auth/jwt.py', note: 'imports sqlalchemy' },
          { path: 'backend/utils/text.py', note: 'imports sqlalchemy' },
        ],
      }),
      link(backend.id, 'ext:NATS', { protocol: 'NATS', evidence: [{ path: 'backend/chat/engine.py', note: 'imports nats' }] }),
    ],
  });
  const open = () => c4Graph(snapshot(files), opened, backend.id);
  const libraries = (graph: Graph) => childrenOf(graph, backend.id, 'shared');

  it('shows the components near its entry as cards inside it, nearest first', () => {
    expect(childrenOf(open(), backend.id, 'component').map((n) => n.data.title)).toEqual(['chat', 'auth']);
  });

  it('folds the components with nothing near the entry into one Libraries card', () => {
    const cards = libraries(open());
    expect([cards.length, cards[0]?.data.title.startsWith('Libraries')]).toEqual([1, true]);
  });

  it('draws at most fourteen component cards', () => {
    const many = container('backend', 'api', { components: Array.from({ length: 20 }, (_, i) => part(`c${i}`, 20 - i)) });
    const graph = c4Graph(snapshot(), model({ containers: [many] }), many.id);
    expect(childrenOf(graph, many.id, 'component').map((n) => n.data.title)).toEqual(Array.from({ length: 14 }, (_, i) => `c${i}`));
  });

  it('folds the components beyond the fourteenth into the Libraries card', () => {
    const many = container('backend', 'api', { components: Array.from({ length: 20 }, (_, i) => part(`c${i}`, 20 - i)) });
    const cards = childrenOf(c4Graph(snapshot(), model({ containers: [many] }), many.id), many.id, 'shared');
    expect(cards.map((n) => /\b6\b/.test(n.data.title))).toEqual([true]);
  });

  it('shows no Libraries card when every component is near the entry', () => {
    const near = container('backend', 'api', { components: [part('chat', 2), part('auth', 1)] });
    expect(childrenOf(c4Graph(snapshot(), model({ containers: [near] }), near.id), near.id, 'shared')).toEqual([]);
  });

  it('keeps one summary edge per outside target', () => {
    const graph = open();
    const fromBackend = graph.edges.filter((e) => e.from === backend.id).map((e) => `${e.kind}:${titleOf(graph, e.to)}`).sort();
    expect(fromBackend).toEqual(['summary:NATS', 'summary:PostgreSQL']);
  });

  it('adds a detail edge from each component card holding evidence of an outside link', () => {
    const graph = open();
    expect(edgesOf(graph, 'detail', (e) => nodeOf(graph, e.from).kind === 'component')).toEqual(['auth->PostgreSQL', 'chat->NATS', 'chat->PostgreSQL']);
  });

  it('attributes evidence from folded components to the Libraries card', () => {
    const graph = open();
    const card = libraries(graph)[0]!;
    expect(graph.edges.filter((e) => e.from === card.id && e.kind === 'detail').map((e) => e.to)).toEqual(['ext:PostgreSQL']);
  });

  it('keeps an incoming link whole', () => {
    const graph = open();
    expect(graph.edges.filter((e) => e.from === 'container:proxy').map((e) => e.to)).toEqual([backend.id]);
  });

  it('draws plain edges to its targets while it is closed', () => {
    const graph = c4Graph(snapshot(files), opened, null);
    expect(graph.edges.filter((e) => e.from === backend.id).map((e) => `${e.kind}:${titleOf(graph, e.to)}`).sort()).toEqual(['plain:NATS', 'plain:PostgreSQL']);
  });
});

describe('c4Graph: connectors', () => {
  const sources = ['Microsoft 365', 'Google Workspace', 'Box'].map((name) => external(name, 'source'));
  const worker = container('sync-worker', 'worker');
  const connectors = model({
    containers: [worker],
    externals: [...sources, external('PostgreSQL', 'database')],
    links: [...sources.map((e) => link(worker.id, e.id, { protocol: 'HTTPS', strength: 2 })), link(worker.id, 'ext:PostgreSQL', { protocol: 'SQL' })],
  });
  const groupOf = (graph: Graph) => graph.nodes.find((n) => n.kind === 'group' && n.data.external);

  it('draws three or more connectors as one group node', () => {
    const graph = c4Graph(snapshot(), connectors, null);
    expect([groupOf(graph) !== undefined, sources.filter((e) => has(graph, e.id))]).toEqual([true, []]);
  });

  it('titles the connector group with its count', () => {
    expect(groupOf(c4Graph(snapshot(), connectors, null))?.data.title).toBe('Connectors ×3');
  });

  it('draws fewer than three connectors individually', () => {
    const two = model({ containers: [worker], externals: sources.slice(0, 2), links: sources.slice(0, 2).map((e) => link(worker.id, e.id)) });
    const graph = c4Graph(snapshot(), two, null);
    expect([groupOf(graph), sources.slice(0, 2).every((e) => has(graph, e.id))]).toEqual([undefined, true]);
  });

  it('does not group external systems of other kinds', () => {
    const databases = ['PostgreSQL', 'Snowflake', 'Oracle'].map((name) => external(name, 'database'));
    const graph = c4Graph(snapshot(), model({ containers: [worker], externals: databases, links: databases.map((e) => link(worker.id, e.id)) }), null);
    expect(databases.every((e) => has(graph, e.id))).toBe(true);
  });

  it('routes links to grouped connectors through the group with their strength combined', () => {
    const graph = c4Graph(snapshot(), connectors, null);
    const group = groupOf(graph)!;
    expect(graph.edges.filter((e) => e.to === group.id).map((e) => [e.from, e.strength])).toEqual([[worker.id, 6]]);
  });

  it('shows the connectors of an opened connector group inside it', () => {
    const groupId = groupOf(c4Graph(snapshot(), connectors, null))!.id;
    const graph = c4Graph(snapshot(), connectors, groupId);
    expect(childrenOf(graph, groupId).map((n) => n.id).sort()).toEqual(sources.map((e) => e.id).sort());
  });

  it('gives an opened connector group one summary edge per caller', () => {
    const groupId = groupOf(c4Graph(snapshot(), connectors, null))!.id;
    const graph = c4Graph(snapshot(), connectors, groupId);
    expect(graph.edges.filter((e) => e.to === groupId).map((e) => [e.from, e.kind])).toEqual([[worker.id, 'summary']]);
  });

  it('adds a detail edge per connector to an opened connector group', () => {
    const groupId = groupOf(c4Graph(snapshot(), connectors, null))!.id;
    expect(edgesOf(c4Graph(snapshot(), connectors, groupId), 'detail')).toEqual([
      'sync-worker->Box',
      'sync-worker->Google Workspace',
      'sync-worker->Microsoft 365',
    ]);
  });
});

describe('c4RootGraph', () => {
  const files = {
    Engine: ['backend/app/main.py', 'backend/chat/engine.py'],
    Auth: ['backend/auth/jwt.py'],
    Search: ['backend/search/index.py'],
    Utils: ['backend/utils/text.py'],
  };
  const backend = container('backend', 'api', {
    launch: ['uvicorn app.main:app --port 8008'],
    entryFiles: ['backend/app/main.py'],
    components: [part('Engine', 2), part('Auth', 1), part('Search', 1), part('Utils', 0)],
    componentLinks: [
      { from: 'Engine', to: 'Auth', count: 5 },
      { from: 'Engine', to: 'Search', count: 1 },
      { from: 'Auth', to: 'Search', count: 3 },
      { from: 'Auth', to: 'Engine', count: 2 },
      { from: 'Search', to: 'Utils', count: 1 },
    ],
  });
  const frontend = container('frontend', 'ui');
  const mailer = container('mailer', 'worker');
  const base = model({
    containers: [frontend, backend, mailer],
    externals: [external('PostgreSQL', 'database'), external('NATS', 'broker'), external('Mail', 'email')],
    links: [
      link('users', frontend.id),
      link(frontend.id, backend.id),
      link(mailer.id, backend.id),
      link(backend.id, 'ext:PostgreSQL', { protocol: 'SQL', evidence: [{ path: 'backend/auth/jwt.py', note: 'imports sqlalchemy' }] }),
      link(backend.id, 'ext:NATS', {
        protocol: 'NATS',
        strength: 2,
        evidence: [
          { path: 'backend/chat/engine.py', note: 'imports nats' },
          { path: 'backend/search/index.py', note: 'imports nats' },
        ],
      }),
      link(mailer.id, 'ext:Mail', { protocol: 'SMTP' }),
    ],
  });
  const root = (m: C4Model = base, expanded: string | null = null) => c4RootGraph(snapshot(files), m, backend.id, expanded);
  const componentNode = (graph: Graph, title: string) => {
    const found = graph.nodes.find((n) => n.kind === 'component' && n.data.title === title);
    if (!found) throw new Error(`no component ${title}`);
    return found;
  };
  const betweenComponents = (graph: Graph) => (e: Graph['edges'][number]) => nodeOf(graph, e.from).kind === 'component' && nodeOf(graph, e.to).kind === 'component';
  const componentToExternal = (graph: Graph) => (e: Graph['edges'][number]) => nodeOf(graph, e.from).kind === 'component' && nodeOf(graph, e.to).kind === 'external';

  it('places the callers of the root in the leftmost column', () => {
    const graph = root();
    const leftmost = Math.min(...graph.nodes.map((n) => n.column));
    expect([nodeOf(graph, frontend.id).column, nodeOf(graph, mailer.id).column]).toEqual([leftmost, leftmost]);
  });

  it('keeps a caller in the leftmost column when the root also calls it', () => {
    const graph = root({ ...base, links: [...base.links, link(backend.id, frontend.id, { protocol: 'WebSocket' })] });
    const leftmost = Math.min(...graph.nodes.map((n) => n.column));
    expect([graph.nodes.filter((n) => n.id === frontend.id).length, nodeOf(graph, frontend.id).column]).toEqual([1, leftmost]);
  });

  it('draws the root container with its launch line', () => {
    expect(nodeOf(root(), backend.id).data.detail).toBe('uvicorn app.main:app --port 8008');
  });

  it('draws a card for each component of the root', () => {
    expect(root().nodes.filter((n) => n.kind === 'component').map((n) => n.data.title).sort()).toEqual(['Auth', 'Engine', 'Search', 'Utils']);
  });

  it('places the components right of the root and the external systems right of the components', () => {
    const graph = root();
    const columns = [nodeOf(graph, backend.id).column, componentNode(graph, 'Engine').column, nodeOf(graph, 'ext:PostgreSQL').column];
    expect([columns[0]! < columns[1]!, columns[1]! < columns[2]!]).toEqual([true, true]);
  });

  it('starts the backbone at the entry component', () => {
    const graph = root();
    const engine = componentNode(graph, 'Engine');
    expect(graph.edges.filter((e) => e.from === backend.id && e.to === engine.id).map((e) => e.kind)).toEqual(['plain']);
  });

  it('hangs each component under the component that imports it most', () => {
    const graph = root();
    expect(edgesOf(graph, 'plain', betweenComponents(graph))).toEqual(['Auth->Search', 'Engine->Auth', 'Search->Utils']);
  });

  it('shows the other imports between components as detail edges', () => {
    const graph = root();
    expect(edgesOf(graph, 'detail', betweenComponents(graph))).toEqual(['Auth->Engine', 'Engine->Search']);
  });

  it('links the root to each external system it uses with one summary edge', () => {
    const graph = root();
    const toExternals = graph.edges.filter((e) => e.from === backend.id && nodeOf(graph, e.to).kind === 'external');
    expect(toExternals.map((e) => `${e.kind}:${titleOf(graph, e.to)}`).sort()).toEqual(['summary:NATS', 'summary:PostgreSQL']);
  });

  it('links components to the external systems their files use with detail edges', () => {
    const graph = root();
    expect(edgesOf(graph, 'detail', componentToExternal(graph))).toEqual(['Auth->PostgreSQL', 'Engine->NATS', 'Search->NATS']);
  });

  it('shows only the external systems the root uses', () => {
    expect(has(root(), 'ext:Mail')).toBe(false);
  });

  it('keeps connectors grouped', () => {
    const sources = ['Microsoft 365', 'Google Workspace', 'Box'].map((name) => external(name, 'source'));
    const graph = root({ ...base, externals: [...base.externals, ...sources], links: [...base.links, ...sources.map((e) => link(backend.id, e.id))] });
    const group = graph.nodes.find((n) => n.kind === 'group' && n.data.external);
    expect([group !== undefined, sources.filter((e) => has(graph, e.id)), graph.edges.filter((e) => e.to === group?.id).map((e) => e.from)]).toEqual([
      true,
      [],
      [backend.id],
    ]);
  });

  it('starts no component at an entry script that no component holds', () => {
    const jobs = container('jobs', 'worker', { entryFiles: ['jobs/docker/start.sh'], components: [part('Engine', 1), part('unassigned', 1)] });
    const graph = c4RootGraph(snapshot(files), model({ containers: [jobs] }), jobs.id, null);
    expect(graph.edges.filter((e) => e.protocols.includes('starts'))).toEqual([]);
  });

  it('returns an empty map for a root that is not a container', () => {
    expect(c4RootGraph(snapshot(files), base, 'container:missing', null)).toEqual({ nodes: [], edges: [] });
  });
});
