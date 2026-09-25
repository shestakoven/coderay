import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { C4Container, C4Link, C4Model, ExternalKind, MapComponent } from '@ide/protocol';
import type { Classification, Classify, Identifier } from '../../src/c4/classify';
import { buildC4 } from '../../src/c4/model';
import type { IndexedFile } from '../../src/model';
import { indexed, tempDir, writeTree } from '../helpers';

interface Project {
  root: string;
  files: IndexedFile[];
}

interface Inputs {
  imports?: [string, string][];
  components?: MapComponent[];
  unresolved?: Record<string, string[]>;
  classify?: Classify;
}

// Sources are written to disk too: URL literals are read from them.
async function project(deploy: Record<string, string>, sources: string[] | Record<string, string>): Promise<Project> {
  const root = tempDir('ide-c4-model-');
  const code = Array.isArray(sources) ? Object.fromEntries(sources.map((path) => [path, ''])) : sources;
  await writeTree(root, { ...deploy, ...code });
  const files = Object.entries(code).map(([path, content]) =>
    indexed(path, path.endsWith('.py') ? 'python' : 'typescript', [], { contentHash: createHash('sha1').update(content).digest('hex') }),
  );
  return { root, files };
}

function build(p: Project, inputs: Inputs = {}) {
  return buildC4(
    p.root,
    p.files,
    (inputs.imports ?? []).map(([from, to]) => ({ from, to, kind: 'import' as const })),
    inputs.components ?? [],
    new Map(Object.entries(inputs.unresolved ?? {})),
    inputs.classify ?? (() => undefined),
  );
}

const compose = (services: Record<string, Record<string, unknown>>, file = 'docker-compose.yml') => ({ [file]: stringify({ services }) });

// Names missing from the table are not classified yet; null means "not an external system".
function names(table: Record<string, Classification | null>) {
  const asked: Identifier[] = [];
  const classify: Classify = (id) => {
    asked.push(id);
    const key = id.type === 'image' ? id.name.split(':')[0]! : id.name;
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };
  const hosts = () => [...new Set(asked.filter((id) => id.type === 'host').map((id) => id.name))].sort();
  const packages = () => [...new Set(asked.filter((id) => id.type === 'package').map((id) => `${id.ecosystem}:${id.name}`))].sort();
  return { classify, hosts, packages };
}

const system = (name: string, kind: ExternalKind, extra: Partial<Classification> = {}): Classification => ({
  system: name,
  kind,
  generic: false,
  protocol: '',
  ...extra,
});

const component = (id: string, files: string[]): MapComponent => ({
  id,
  name: id,
  summary: '',
  description: '',
  files,
  keyFiles: [],
  globs: [],
  source: 'folder',
  stale: false,
});

function containerNamed(model: C4Model, name: string): C4Container {
  const found = model.containers.find((c) => c.name === name);
  if (!found) throw new Error(`no container ${name} in ${model.containers.map((c) => c.name).join(', ')}`);
  return found;
}

const idOf = (model: C4Model, name: string) =>
  name === 'users' ? 'users' : (model.containers.find((c) => c.name === name)?.id ?? model.externals.find((e) => e.name === name)?.id);

const linkBetween = (model: C4Model, from: string, to: string): C4Link | undefined =>
  model.links.find((l) => l.from === idOf(model, from) && l.to === idOf(model, to));

const targetsOf = (model: C4Model, from: string) =>
  model.links
    .filter((l) => l.from === idOf(model, from))
    .map((l) => [...model.containers, ...model.externals].find((x) => x.id === l.to)?.name ?? l.to)
    .sort();

const API = { build: './backend', command: 'uvicorn app.main:app' };
const MAIN = 'backend/app/main.py';
const NGINX = 'FROM nginx:alpine\nCMD ["nginx", "-g", "daemon off;"]\n';
const api = (sources: string[] | Record<string, string> = []) =>
  project(compose({ backend: API }), Array.isArray(sources) ? [MAIN, ...sources] : { [MAIN]: '', ...sources });

describe('buildC4: containers', () => {
  it('treats a service that builds from the repository as a container', async () => {
    const p = await project(compose({ backend: API }), [MAIN]);
    expect(build(p).model.containers.map((c) => c.name)).toEqual(['backend']);
  });

  it('treats a service that runs a command over a bind-mounted source directory as a container', async () => {
    const p = await project(
      compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' } }),
      ['frontend/src/main.ts'],
    );
    expect(build(p).model.containers.map((c) => c.name)).toEqual(['frontend-dev']);
  });

  it('does not treat a service that mounts a directory without indexed sources as a container', async () => {
    const p = await project(
      compose({
        backend: API,
        postgres: { image: 'postgres:16', volumes: ['./db/init:/docker-entrypoint-initdb.d'], command: 'postgres -c max_connections=200' },
      }),
      [MAIN],
    );
    expect(build(p).model.containers.map((c) => c.name)).toEqual(['backend']);
  });

  it('does not treat a mounted source directory as a container when the service runs no command', async () => {
    const p = await project(compose({ backend: API, docs: { image: 'nginx:alpine', volumes: ['./frontend:/usr/share/nginx/html'] } }), [
      MAIN,
      'frontend/src/main.ts',
    ]);
    expect(build(p).model.containers.map((c) => c.name)).toEqual(['backend']);
  });

  it('does not treat a service that only runs an image as a container', async () => {
    const p = await project(compose({ backend: API, postgres: { image: 'postgres:16' } }), [MAIN]);
    expect(build(p).model.containers.map((c) => c.name)).toEqual(['backend']);
  });

  it('lists services named test, e2e, lint or migrate as tooling instead of containers', async () => {
    const service = { build: './backend', command: 'python -m app.main' };
    const p = await project(compose({ test: service, e2e: service, lint: service, migrate: service }), [MAIN]);
    const { model } = build(p);
    expect([[...model.tooling].sort(), model.containers]).toEqual([['e2e', 'lint', 'migrate', 'test'], []]);
  });

  it.each(['pytest -q', 'npx vitest run', 'npx jest --ci'])('lists a service that runs %s as tooling', async (command) => {
    const p = await project(compose({ checks: { build: './backend', command } }), [MAIN]);
    const { model } = build(p);
    expect([model.tooling, model.containers]).toEqual([['checks'], []]);
  });

  it('cites every compose file that defines a container', async () => {
    const p = await project(
      { ...compose({ backend: API }, 'docker-compose.linux.yml'), ...compose({ backend: API }, 'docker-compose.macos.yml') },
      [MAIN],
    );
    const paths = containerNamed(build(p).model, 'backend').evidence.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['docker-compose.linux.yml', 'docker-compose.macos.yml']));
  });

  it('reports an unparsable compose file among the warnings', async () => {
    const p = await project({ ...compose({ backend: API }), 'docker-compose.broken.yml': 'services:\n  b: [unclosed\n' }, [MAIN]);
    expect(build(p).model.warnings.some((w) => w.includes('docker-compose.broken.yml'))).toBe(true);
  });
});

describe('buildC4: entry detection', () => {
  it.each([
    'uvicorn app.main:app --host 0.0.0.0',
    'gunicorn -k uvicorn.workers.UvicornWorker app.main:app',
    'hypercorn app.main:app',
    'granian --interface asgi app.main:app',
    'python -m uvicorn app.main:app',
    'sh -c "alembic upgrade head && uvicorn app.main:app"',
  ])('gives the api role to a container launched with %s', async (command) => {
    const p = await project(compose({ backend: { build: './backend', command } }), [MAIN]);
    expect(containerNamed(build(p).model, 'backend').role).toBe('api');
  });

  it.each(['python -m app.worker', 'python3 -m app.worker', 'celery -A app.worker worker -l info', 'python -m celery -A app.worker worker', 'python app/worker.py'])(
    'gives the worker role to a container launched with %s',
    async (command) => {
      const p = await project(compose({ worker: { build: './backend', command } }), ['backend/app/worker.py']);
      expect(containerNamed(build(p).model, 'worker').role).toBe('worker');
    },
  );

  it.each(['npm run dev', 'pnpm dev', 'yarn dev', 'npx vite --host 0.0.0.0'])('gives the ui role to a dev server launched with %s', async (command) => {
    const p = await project(compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command } }), ['frontend/src/main.ts']);
    expect(containerNamed(build(p).model, 'frontend-dev').role).toBe('ui');
  });

  it('gives a dev server every indexed file of its mounted source directory', async () => {
    const p = await project(
      compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' } }),
      ['frontend/src/a.ts', 'frontend/src/b.ts', 'frontend/vite.config.ts', MAIN],
    );
    expect(containerNamed(build(p).model, 'frontend-dev').files).toBe(3);
  });

  it('gives the ui role to a container that runs nginx', async () => {
    const p = await project({ ...compose({ 'frontend-proxy': { build: './frontend', ports: ['80:80'] } }), 'frontend/Dockerfile': NGINX }, [
      'frontend/src/main.ts',
    ]);
    expect(containerNamed(build(p).model, 'frontend-proxy').role).toBe('ui');
  });

  it.each(['poetry run uvicorn app.main:app', 'uv run uvicorn app.main:app'])('finds the entry behind the runner prefix in %s', async (command) => {
    const p = await project(compose({ backend: { build: './backend', command } }), [MAIN]);
    expect(containerNamed(build(p).model, 'backend').entryFiles).toEqual([MAIN]);
  });

  it('matches the entry module by path suffix', async () => {
    const p = await project(compose({ backend: { build: './backend', command: 'uvicorn src.main:app' } }), ['backend/src/main.py', 'backend/src/other.py']);
    expect(containerNamed(build(p).model, 'backend').entryFiles).toEqual(['backend/src/main.py']);
  });

  it('matches a package run with python -m through its __main__.py', async () => {
    const p = await project(compose({ worker: { build: './backend', command: 'python -m app.worker' } }), [
      'backend/app/worker/__main__.py',
      'backend/app/worker/tasks.py',
    ]);
    expect(containerNamed(build(p).model, 'worker').entryFiles).toEqual(['backend/app/worker/__main__.py']);
  });

  it('matches a Celery app package through its __init__.py', async () => {
    const p = await project(compose({ worker: { build: './backend', command: 'celery -A app.tasks worker' } }), [
      'backend/app/tasks/__init__.py',
      'backend/app/tasks/mail.py',
    ]);
    expect(containerNamed(build(p).model, 'worker').entryFiles).toEqual(['backend/app/tasks/__init__.py']);
  });

  it('finds the script of a python path.py launch', async () => {
    const p = await project(compose({ worker: { build: './backend', command: 'python scripts/run_worker.py' } }), ['backend/scripts/run_worker.py']);
    expect(containerNamed(build(p).model, 'worker').entryFiles).toEqual(['backend/scripts/run_worker.py']);
  });

  it('prefers the entry module under the build context', async () => {
    const p = await project(compose({ backend: { build: './backend', command: 'uvicorn src.main:app' } }), ['src/main.py', 'backend/src/main.py']);
    expect(containerNamed(build(p).model, 'backend').entryFiles).toEqual(['backend/src/main.py']);
  });

  it('prefers the entry module under a bind mount', async () => {
    const p = await project(compose({ worker: { image: 'python:3.12', volumes: ['./worker:/app'], command: 'python -m src.main' } }), [
      'src/main.py',
      'worker/src/main.py',
    ]);
    expect(containerNamed(build(p).model, 'worker').entryFiles).toEqual(['worker/src/main.py']);
  });

  it('takes entries from every definition of a service', async () => {
    const p = await project(
      {
        ...compose({ worker: { build: './backend', command: 'python -m app.linux_worker' } }, 'docker-compose.linux.yml'),
        ...compose({ worker: { build: './backend', command: 'python -m app.mac_worker' } }, 'docker-compose.macos.yml'),
      },
      ['backend/app/linux_worker.py', 'backend/app/mac_worker.py'],
    );
    expect([...containerNamed(build(p).model, 'worker').entryFiles].sort()).toEqual(['backend/app/linux_worker.py', 'backend/app/mac_worker.py']);
  });
});

describe('buildC4: entry not found', () => {
  const DRAFT = compose({ 'draft-worker': { build: '.', command: 'python -m app.draft_worker' } });
  const SOURCES = ['backend/app/worker.py', 'backend/app/db.py', 'frontend/src/main.ts'];

  it('flags a container whose entry module does not exist', async () => {
    const c = containerNamed(build(await project(DRAFT, SOURCES)).model, 'draft-worker');
    expect([c.entryFiles, c.entryMissing.length > 0]).toEqual([[], true]);
  });

  it('gives a container whose entry is not found no files, not its whole build context', async () => {
    const c = containerNamed(build(await project(DRAFT, SOURCES)).model, 'draft-worker');
    expect([c.files, c.components]).toEqual([0, []]);
  });

  it('warns about a container whose entry is not found', async () => {
    const { warnings } = build(await project(DRAFT, SOURCES)).model;
    expect(warnings.some((w) => w.includes('draft-worker') && /entry not found/i.test(w))).toBe(true);
  });
});

describe('buildC4: components', () => {
  it('counts the files its entry reaches through imports', async () => {
    const p = await api(['backend/app/a.py', 'backend/app/b.py', 'backend/app/unused.py']);
    const { model } = build(p, { imports: [[MAIN, 'backend/app/a.py'], ['backend/app/a.py', 'backend/app/b.py']] });
    expect(containerNamed(model, 'backend').files).toBe(3);
  });

  it('stops at import cycles', async () => {
    const p = await api(['backend/app/a.py']);
    const { model } = build(p, { imports: [[MAIN, 'backend/app/a.py'], ['backend/app/a.py', MAIN]] });
    expect(containerNamed(model, 'backend').files).toBe(2);
  });

  it('gives each component the number of its files the entry reaches', async () => {
    const a = ['backend/app/api/a1.py', 'backend/app/api/a2.py', 'backend/app/api/unused.py'];
    const p = await api(a);
    const { model } = build(p, {
      imports: [[MAIN, a[0]!], [MAIN, a[1]!]],
      components: [component('E', [MAIN]), component('A', a)],
    });
    expect(containerNamed(model, 'backend').components.find((c) => c.id === 'A')?.files).toBe(2);
  });

  it('counts as near the files at most two imports from the entry', async () => {
    const [one, two, three] = ['backend/app/one.py', 'backend/app/two.py', 'backend/app/three.py'];
    const p = await api([one!, two!, three!]);
    const { model } = build(p, {
      imports: [[MAIN, one!], [one!, two!], [two!, three!]],
      components: [component('E', [MAIN]), component('B', [one!]), component('C', [two!]), component('D', [three!])],
    });
    const near = Object.fromEntries(containerNamed(model, 'backend').components.map((c) => [c.id, c.near]));
    expect(near).toEqual({ E: 1, B: 1, C: 1, D: 0 });
  });

  it('counts the containers that reach each component', async () => {
    const [worker, db, only] = ['backend/app/worker.py', 'backend/app/db.py', 'backend/app/api_only.py'];
    const p = await project(compose({ backend: API, worker: { build: './backend', command: 'python -m app.worker' } }), [MAIN, worker!, db!, only!]);
    const { model } = build(p, {
      imports: [[MAIN, db!], [MAIN, only!], [worker!, db!]],
      components: [component('E', [MAIN]), component('W', [worker!]), component('S', [db!]), component('P', [only!])],
    });
    const reach = Object.fromEntries(containerNamed(model, 'backend').components.map((c) => [c.id, c.containers]));
    expect(reach).toEqual({ E: 1, S: 2, P: 1 });
  });

  it('ranks components by their files near the entry, not by their size', async () => {
    const [q, p1, p2, p3, mid] = ['q.py', 'p1.py', 'p2.py', 'p3.py', 'mid.py'].map((name) => `backend/app/${name}`) as [string, string, string, string, string];
    const libs = Array.from({ length: 6 }, (_, i) => `backend/lib/l${i}.py`);
    const p = await api([q, p1, p2, p3, mid, ...libs]);
    const { model } = build(p, {
      imports: [[MAIN, q], [MAIN, p1], [MAIN, p2], [MAIN, p3], [p1, mid], [mid, libs[0]!], ...libs.slice(1).map((lib, i) => [libs[i]!, lib] as [string, string])],
      components: [component('L', libs), component('Q', [q]), component('E', [MAIN]), component('P', [p1, p2, p3, mid])],
    });
    const ids = containerNamed(model, 'backend').components.map((c) => c.id);
    expect([ids[0], ids.at(-1)]).toEqual(['P', 'L']);
  });

  it('links components by the number of imports between their files', async () => {
    const [a1, a2, b] = ['backend/app/a1.py', 'backend/app/a2.py', 'backend/app/b.py'];
    const p = await api([a1!, a2!, b!]);
    const { model } = build(p, {
      imports: [[MAIN, a1!], [MAIN, a2!], [a1!, b!]],
      components: [component('E', [MAIN]), component('A', [a1!, a2!]), component('B', [b!])],
    });
    const links = containerNamed(model, 'backend').componentLinks.map((l) => `${l.from}->${l.to}:${l.count}`).sort();
    expect(links).toEqual(['A->B:1', 'E->A:2']);
  });

  it('leaves imports inside a component out of its links', async () => {
    const [a1, a2] = ['backend/app/a1.py', 'backend/app/a2.py'];
    const p = await api([a1!, a2!]);
    const { model } = build(p, {
      imports: [[MAIN, a1!], [a1!, a2!]],
      components: [component('E', [MAIN]), component('A', [a1!, a2!])],
    });
    expect(containerNamed(model, 'backend').componentLinks.map((l) => `${l.from}->${l.to}`)).toEqual(['E->A']);
  });

  it('links the components of a dev server only among its mounted files', async () => {
    const [app, shared] = ['frontend/src/app.ts', 'shared/src/format.ts'];
    const p = await project(compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' } }), [
      'frontend/src/main.ts',
      app!,
      shared!,
    ]);
    const { model } = build(p, {
      imports: [['frontend/src/main.ts', app!], [app!, shared!]],
      components: [component('Shell', ['frontend/src/main.ts']), component('App', [app!]), component('Shared', [shared!])],
    });
    expect(containerNamed(model, 'frontend-dev').componentLinks.map((l) => `${l.from}->${l.to}`)).toEqual(['Shell->App']);
  });

  it('counts only imports between files its entry reaches', async () => {
    const [unused, lib] = ['backend/app/unused.py', 'backend/lib/x.py'];
    const p = await api([unused!, lib!]);
    const { model } = build(p, {
      imports: [[MAIN, lib!], [unused!, lib!]],
      components: [component('E', [MAIN, unused!]), component('L', [lib!])],
    });
    expect(containerNamed(model, 'backend').componentLinks).toEqual([{ from: 'E', to: 'L', count: 1 }]);
  });
});

describe('buildC4: links from the environment', () => {
  const STACK = {
    ...compose({
      'frontend-proxy': { build: './frontend', ports: ['80:80'], environment: { BACKEND_URL: 'http://backend:8008' } },
      backend: { ...API, environment: ['POSTGRES_HOST=postgres', 'NATS_URL=nats://nats:4222', 'MINIO_ENDPOINT=minio:9000', 'LOG_LEVEL=info'] },
      postgres: { image: 'postgres:16' },
      nats: { image: 'nats:2.10' },
      minio: { image: 'minio/minio:latest' },
      redis: { image: 'redis:7' },
    }),
    'frontend/Dockerfile': NGINX,
  };
  const SOURCES = ['frontend/src/main.ts', MAIN];
  const SYSTEMS = {
    postgres: system('PostgreSQL', 'database'),
    nats: system('NATS', 'broker'),
    'minio/minio': system('MinIO', 'storage'),
    redis: system('Redis', 'cache'),
  };
  const stack = async () => build(await project(STACK, SOURCES), { classify: names(SYSTEMS).classify });

  it('links a container to another container that its environment names', async () => {
    expect(linkBetween((await stack()).model, 'frontend-proxy', 'backend')).toBeDefined();
  });

  it('takes the protocol of a link to a container from the URL scheme', async () => {
    expect(linkBetween((await stack()).model, 'frontend-proxy', 'backend')?.protocol).toBe('HTTP');
  });

  it('takes an https scheme as the protocol of a link to a container', async () => {
    const p = await project(
      { ...compose({ 'frontend-proxy': { build: './frontend', environment: { BACKEND_URL: 'https://backend:8443' } }, backend: API }), 'frontend/Dockerfile': NGINX },
      SOURCES,
    );
    expect(linkBetween(build(p).model, 'frontend-proxy', 'backend')?.protocol).toBe('HTTPS');
  });

  it('cites the environment variable and its compose file as evidence of a link', async () => {
    const evidence = linkBetween((await stack()).model, 'frontend-proxy', 'backend')?.evidence ?? [];
    expect(evidence.some((e) => e.path === 'docker-compose.yml' && e.note.includes('BACKEND_URL'))).toBe(true);
  });

  it('links a container to the external system of a compose service its environment names', async () => {
    expect(linkBetween((await stack()).model, 'backend', 'PostgreSQL')).toBeDefined();
  });

  it('links a container to a compose service named in a host:port value', async () => {
    expect(linkBetween((await stack()).model, 'backend', 'MinIO')).toBeDefined();
  });

  it('takes the protocol of an environment link from the URL scheme', async () => {
    expect(linkBetween((await stack()).model, 'backend', 'NATS')?.protocol).toBe('NATS');
  });

  it('links through a database URL that carries credentials', async () => {
    const p = await project(
      compose({ backend: { ...API, environment: { DATABASE_URL: 'postgresql://app:secret@postgres:5432/app' } }, postgres: { image: 'postgres:16' } }),
      SOURCES,
    );
    expect(linkBetween(build(p, { classify: names(SYSTEMS).classify }).model, 'backend', 'PostgreSQL')?.protocol).toBe('SQL');
  });

  it('takes the protocol from the kind of the target when the value has no scheme', async () => {
    const { model } = await stack();
    expect([linkBetween(model, 'backend', 'PostgreSQL')?.protocol, linkBetween(model, 'backend', 'MinIO')?.protocol]).toEqual(['SQL', 'S3']);
  });

  it('draws only the external services that a container links to', async () => {
    expect((await stack()).model.externals.map((e) => e.name).sort()).toEqual(['MinIO', 'NATS', 'PostgreSQL']);
  });

  it('names an external system after its image until the image is classified', async () => {
    const { model } = build(await project(STACK, SOURCES));
    expect(model.externals.map((e) => e.name)).toContain('postgres');
  });

  it('lists a compose image it could not classify as pending', async () => {
    const { pending } = build(await project(STACK, SOURCES));
    expect(pending.some((id) => id.type === 'image' && id.name.startsWith('postgres'))).toBe(true);
  });
});

describe('buildC4: links from imports', () => {
  const DB = 'backend/app/db.py';
  const REPO = 'backend/app/repo.py';

  it('links a container to the system of a package its files import', async () => {
    const { model } = build(await api([DB]), {
      imports: [[MAIN, DB]],
      unresolved: { [DB]: ['sqlalchemy.orm'] },
      classify: names({ sqlalchemy: system('PostgreSQL', 'database') }).classify,
    });
    expect(linkBetween(model, 'backend', 'PostgreSQL')).toBeDefined();
  });

  it('cites the importing file as evidence of an import link', async () => {
    const { model } = build(await api([DB]), {
      imports: [[MAIN, DB]],
      unresolved: { [DB]: ['sqlalchemy.orm'] },
      classify: names({ sqlalchemy: system('PostgreSQL', 'database') }).classify,
    });
    const evidence = linkBetween(model, 'backend', 'PostgreSQL')?.evidence ?? [];
    expect(evidence.some((e) => e.path === DB && e.note.includes('sqlalchemy'))).toBe(true);
  });

  it('asks about the top-level package of a Python import', async () => {
    const asked = names({});
    build(await api([DB]), { imports: [[MAIN, DB]], unresolved: { [DB]: ['sqlalchemy.orm', 'google.cloud.storage'] }, classify: asked.classify });
    expect(asked.packages()).toEqual(['python:google', 'python:sqlalchemy']);
  });

  it('asks about an npm package by its scope and name', async () => {
    const asked = names({});
    const p = await project(compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' } }), [
      'frontend/src/api.ts',
    ]);
    build(p, { unresolved: { 'frontend/src/api.ts': ['@aws-sdk/client-s3', 'lodash/merge'] }, classify: asked.classify });
    expect(asked.packages()).toEqual(['npm:@aws-sdk/client-s3', 'npm:lodash']);
  });

  it('never asks about relative imports or path aliases', async () => {
    const asked = names({});
    const p = await project(
      {
        ...compose({
          backend: API,
          'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' },
        }),
      },
      [MAIN, 'frontend/src/api.ts'],
    );
    build(p, {
      unresolved: { [MAIN]: ['.missing', '..gone.module', 'sqlalchemy'], 'frontend/src/api.ts': ['./missing', '../gone', '@/lib/api'] },
      classify: asked.classify,
    });
    expect(asked.packages()).toEqual(['python:sqlalchemy']);
  });

  it('does not link packages imported only by files its entry does not reach', async () => {
    const seed = 'backend/tools/seed.py';
    const { model } = build(await api([seed]), {
      unresolved: { [MAIN]: ['openai'], [seed]: ['boto3'] },
      classify: names({ openai: system('LLM providers', 'ai'), boto3: system('Amazon S3', 'storage') }).classify,
    });
    expect(targetsOf(model, 'backend')).toEqual(['LLM providers']);
  });

  it('does not link a package classified as not an external system', async () => {
    const { model } = build(await api(), {
      unresolved: { [MAIN]: ['fastapi', 'openai'] },
      classify: names({ fastapi: null, openai: system('LLM providers', 'ai') }).classify,
    });
    expect(model.externals.map((e) => e.name)).toEqual(['LLM providers']);
  });

  it('counts link strength by distinct evidence sites', async () => {
    const { model } = build(await api([DB, REPO]), {
      imports: [[MAIN, DB], [MAIN, REPO]],
      unresolved: { [DB]: ['sqlalchemy', 'sqlalchemy.orm'], [REPO]: ['sqlalchemy'] },
      classify: names({ sqlalchemy: system('PostgreSQL', 'database') }).classify,
    });
    expect(linkBetween(model, 'backend', 'PostgreSQL')?.strength).toBe(2);
  });

  it('lists as pending only the identifiers classify has no answer for', async () => {
    const { pending } = build(await api(), {
      unresolved: { [MAIN]: ['sqlalchemy', 'fastapi', 'openai'] },
      classify: names({ fastapi: null, openai: system('LLM providers', 'ai') }).classify,
    });
    expect(pending.map((id) => id.name)).toEqual(['sqlalchemy']);
  });

  it('lists each pending identifier once', async () => {
    const { pending } = build(await api([DB]), { imports: [[MAIN, DB]], unresolved: { [MAIN]: ['sqlalchemy'], [DB]: ['sqlalchemy.orm'] } });
    expect(pending.map((id) => id.name)).toEqual(['sqlalchemy']);
  });
});

describe('buildC4: links from URL literals', () => {
  const GRAPH = 'backend/app/connectors/graph.py';
  const graph = async () => {
    const asked = names({ 'graph.microsoft.com': system('Microsoft 365', 'source') });
    const p = await api({ [GRAPH]: 'BASE = "https://graph.microsoft.com/v1.0/me/drive?select=id"\n' });
    return { asked, result: build(p, { imports: [[MAIN, GRAPH]], classify: asked.classify }) };
  };

  it('links a container to the system that a URL literal in its code names', async () => {
    expect(linkBetween((await graph()).result.model, 'backend', 'Microsoft 365')).toBeDefined();
  });

  it('cites the file holding the URL literal as evidence', async () => {
    const evidence = linkBetween((await graph()).result.model, 'backend', 'Microsoft 365')?.evidence ?? [];
    expect(evidence.some((e) => e.path === GRAPH && e.note.includes('graph.microsoft.com'))).toBe(true);
  });

  it('passes only the host of a URL literal to classify', async () => {
    expect((await graph()).asked.hosts()).toEqual(['graph.microsoft.com']);
  });

  it('takes the host of a URL literal that carries user info, and nothing else of it', async () => {
    const asked = names({});
    const p = await api({ 'backend/app/billing.py': 'URL = "https://svc:token@api.stripe.com/v1/charges"\n' });
    build(p, { imports: [[MAIN, 'backend/app/billing.py']], classify: asked.classify });
    expect(asked.hosts()).toEqual(['api.stripe.com']);
  });

  it.each(['frontend/src/api.test.ts', 'frontend/src/api.spec.ts', 'frontend/tests/api.ts', 'frontend/src/__tests__/api.ts', 'frontend/scripts/test_api.py'])(
    'ignores URL literals in the test file %s',
    async (testFile) => {
      const asked = names({});
      const p = await project(compose({ 'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev' } }), {
        'frontend/src/client.ts': 'export const API = "https://api.dropboxapi.com/2";\n',
        [testFile]: 'const url = "https://api.box.com/2.0";\n',
      });
      build(p, { classify: asked.classify });
      expect(asked.hosts()).toEqual(['api.dropboxapi.com']);
    },
  );

  describe('in a module every container loads', () => {
    const [mail, sync, settings, gdrive] = ['mail.py', 'sync.py', 'settings.py', 'gdrive.py'].map((name) => `backend/app/${name}`) as [string, string, string, string];
    const threeContainers = async () => {
      const asked = names({ 'accounts.google.com': system('Google Workspace', 'source'), 'www.googleapis.com': system('Google Workspace', 'source') });
      const p = await project(
        compose({
          backend: API,
          'mail-worker': { build: './backend', command: 'python -m app.mail' },
          'sync-worker': { build: './backend', command: 'python -m app.sync' },
        }),
        {
          [MAIN]: '',
          [mail]: '',
          [sync]: '',
          [settings]: 'GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth"\n',
          [gdrive]: 'API = "https://www.googleapis.com/drive/v3"\n',
        },
      );
      const result = build(p, { imports: [[MAIN, settings], [mail, settings], [sync, settings], [sync, gdrive]], classify: asked.classify });
      return { asked, model: result.model };
    };

    it('ignores its URL literals', async () => {
      expect((await threeContainers()).asked.hosts()).not.toContain('accounts.google.com');
    });

    it('still links the URL literals of a module only some containers load', async () => {
      const { model } = await threeContainers();
      const callers = model.links.filter((l) => l.to === idOf(model, 'Google Workspace')).map((l) => model.containers.find((c) => c.id === l.from)?.name);
      expect(callers).toEqual(['sync-worker']);
    });
  });

  it('never passes private or placeholder hosts to classify', async () => {
    const asked = names({});
    const literals = [
      'http://localhost:8000',
      'http://127.0.0.1:9000',
      'http://10.0.0.5/api',
      'http://minio:9000',
      'https://app.example.com/callback',
      'https://example.org',
      'http://printer.local',
      'http://api.internal/v1',
      'https://nas.lan/share',
      'http://db.default.svc.cluster.local',
      'https://site.test',
      'https://thing.invalid',
      'https://api.openai.com/v1',
    ];
    const p = await api({ 'backend/app/hosts.py': literals.map((url, i) => `URL_${i} = "${url}"`).join('\n') });
    build(p, { imports: [[MAIN, 'backend/app/hosts.py']], classify: asked.classify });
    expect(asked.hosts()).toEqual(['api.openai.com']);
  });
});

describe('buildC4: Users', () => {
  it('links Users to the published ui entrance that no other ui container proxies to', async () => {
    const p = await project(
      {
        ...compose({
          'frontend-proxy': {
            build: './frontend',
            ports: ['80:80'],
            environment: { FRONTEND_DEV_URL: 'http://frontend-dev:5173', BACKEND_URL: 'http://backend:8008' },
          },
          'frontend-dev': { image: 'node:20-alpine', volumes: ['./frontend:/app'], command: 'npm run dev', ports: ['5173:5173'] },
          backend: { ...API, ports: ['8008:8008'] },
        }),
        'frontend/Dockerfile': NGINX,
      },
      ['frontend/src/main.ts', MAIN],
    );
    expect(targetsOf(build(p).model, 'users')).toEqual(['frontend-proxy']);
  });

  it('does not link Users to a ui container that publishes no ports', async () => {
    const p = await project(
      {
        ...compose({ web: { build: './frontend', ports: ['80:80'] }, admin: { build: './admin' } }),
        'frontend/Dockerfile': NGINX,
        'admin/Dockerfile': NGINX,
      },
      ['frontend/src/main.ts', 'admin/src/main.ts'],
    );
    expect(targetsOf(build(p).model, 'users')).toEqual(['web']);
  });
});

describe('buildC4: worker groups', () => {
  const WORKERS = ['chat', 'mail', 'sync'].map((name) => `backend/app/workers/${name}.py`);
  const worker = (name: string, buildDef: unknown = './backend') => ({ build: buildDef, command: `python -m app.workers.${name}` });
  const groups = (model: C4Model) => model.containers.map((c) => c.group);

  it('puts three or more workers from the same build into one group', async () => {
    const p = await project(compose({ chat: worker('chat'), mail: worker('mail'), sync: worker('sync') }), WORKERS);
    const found = groups(build(p).model);
    expect([new Set(found).size, found[0] !== null]).toEqual([1, true]);
  });

  it('leaves two workers from the same build ungrouped', async () => {
    const p = await project(compose({ chat: worker('chat'), mail: worker('mail') }), WORKERS);
    expect(groups(build(p).model)).toEqual([null, null]);
  });

  it('does not group workers built from different Dockerfiles in one context', async () => {
    const p = await project(
      compose({
        chat: worker('chat', { context: './backend' }),
        mail: worker('mail', { context: './backend' }),
        sync: worker('sync', { context: './backend', dockerfile: 'Dockerfile.gpu' }),
      }),
      WORKERS,
    );
    expect(groups(build(p).model)).toEqual([null, null, null]);
  });

  it('gives workers from different builds different groups', async () => {
    const agents = ['a', 'b', 'c'].map((name) => `agents/app/workers/${name}.py`);
    const agent = (name: string) => ({ build: './agents', command: `python -m app.workers.${name}` });
    const p = await project(
      compose({ chat: worker('chat'), mail: worker('mail'), sync: worker('sync'), 'agent-a': agent('a'), 'agent-b': agent('b'), 'agent-c': agent('c') }),
      [...WORKERS, ...agents],
    );
    const { model } = build(p);
    const chat = containerNamed(model, 'chat').group;
    const agentA = containerNamed(model, 'agent-a').group;
    expect([chat !== null, agentA !== null, chat === agentA]).toEqual([true, true, false]);
  });

  it('does not group api containers', async () => {
    const p = await project(compose({ 'api-a': API, 'api-b': API, 'api-c': API }), [MAIN]);
    expect(groups(build(p).model)).toEqual([null, null, null]);
  });
});

describe('buildC4: generic systems', () => {
  const DB = 'backend/app/db.py';
  const SQL = system('SQL database', 'database', { generic: true });
  const withPostgres = compose({ backend: { ...API, environment: { POSTGRES_HOST: 'postgres' } }, postgres: { image: 'postgres:16' } });
  const run = async (deploy: Record<string, string>, packages: string[]) =>
    build(await project(deploy, [MAIN, DB]), {
      imports: [[MAIN, DB]],
      unresolved: { [DB]: packages },
      classify: names({
        sqlalchemy: SQL,
        postgres: system('PostgreSQL', 'database'),
        snowflake: system('Snowflake', 'database'),
        oracledb: system('Oracle Database', 'database'),
      }).classify,
    }).model;

  it('merges a generic client into the one specific system of its kind', async () => {
    const model = await run(withPostgres, ['sqlalchemy']);
    expect(model.externals.map((e) => e.name)).toEqual(['PostgreSQL']);
  });

  it('keeps the identifiers of the generic client on the system it merged into', async () => {
    const model = await run(withPostgres, ['sqlalchemy']);
    expect(model.externals.find((e) => e.name === 'PostgreSQL')?.identifiers.some((i) => i.includes('sqlalchemy'))).toBe(true);
  });

  it('moves the links of a generic client onto the system it merged into', async () => {
    const model = await run(withPostgres, ['sqlalchemy']);
    const notes = (linkBetween(model, 'backend', 'PostgreSQL')?.evidence ?? []).map((e) => e.note);
    expect([targetsOf(model, 'backend'), notes.some((n) => n.includes('sqlalchemy'))]).toEqual([['PostgreSQL'], true]);
  });

  it('prefers the specific system that a compose service runs', async () => {
    const model = await run(withPostgres, ['sqlalchemy', 'snowflake.connector']);
    const postgres = model.externals.find((e) => e.name === 'PostgreSQL');
    expect([model.externals.map((e) => e.name).sort(), postgres?.identifiers.some((i) => i.includes('sqlalchemy'))]).toEqual([
      ['PostgreSQL', 'Snowflake'],
      true,
    ]);
  });

  it('merges a generic client into the only specific system of its kind when no compose service runs one', async () => {
    const model = await run(compose({ backend: API }), ['sqlalchemy', 'snowflake.connector']);
    expect(model.externals.map((e) => e.name)).toEqual(['Snowflake']);
  });

  it('keeps a generic system that no single specific system can own', async () => {
    const model = await run(compose({ backend: API }), ['sqlalchemy', 'snowflake.connector', 'oracledb']);
    expect(model.externals.map((e) => e.name)).toContain('SQL database');
  });
});
