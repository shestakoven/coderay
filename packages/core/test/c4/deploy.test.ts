import { rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { describe, expect, it, vi, type TestContext } from 'vitest';
import { stringify } from 'yaml';
import { readBuilds, readDeploy, watchDeploy, type ServiceDef } from '../../src/c4/deploy';
import { k8sWorkload, tempDir, waitFor, writeTree } from '../helpers';

async function project(files: Record<string, string>, context?: TestContext): Promise<string> {
  const root = tempDir('ide-c4-deploy-', context);
  await writeTree(root, files);
  return root;
}

function service(root: string, name: string): ServiceDef {
  const defs = readDeploy(root).services.get(name) ?? [];
  if (defs.length !== 1) throw new Error(`expected one definition of ${name}, found ${defs.length}`);
  return defs[0]!;
}

const launch = (def: ServiceDef) => def.commands.join('\n');

describe('readDeploy: compose discovery', () => {
  it('reads docker-compose*.yml and compose*.yml files at the project root', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  a:\n    image: a\n',
      'docker-compose.linux.yml': 'services:\n  b:\n    image: b\n',
      'compose.yaml': 'services:\n  c:\n    image: c\n',
      'compose.dev.yml': 'services:\n  d:\n    image: d\n',
    });
    expect([...readDeploy(root).services.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores other YAML files and compose files in subdirectories', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  a:\n    image: a\n',
      'mkdocs.yml': 'services:\n  docs:\n    image: docs\n',
      'deploy/docker-compose.yml': 'services:\n  nested:\n    image: nested\n',
    });
    expect([...readDeploy(root).services.keys()]).toEqual(['a']);
  });

  it('reads a file listed under include:', async () => {
    const root = await project({
      'docker-compose.yml': 'include:\n  - infra/services.yml\nservices:\n  a:\n    image: a\n',
      'infra/services.yml': 'services:\n  b:\n    image: b\n',
    });
    expect([...readDeploy(root).services.keys()].sort()).toEqual(['a', 'b']);
  });

  it('reads an include given with path:, relative to the including file', async () => {
    const root = await project({
      'docker-compose.yml': 'include:\n  - infra/services.yml\n',
      'infra/services.yml': 'include:\n  - path: ./more.yml\nservices:\n  b:\n    image: b\n',
      'infra/more.yml': 'services:\n  c:\n    image: c\n',
    });
    expect([...readDeploy(root).services.keys()].sort()).toEqual(['b', 'c']);
  });

  it('reports every compose file it read, included ones too', async () => {
    const root = await project({
      'docker-compose.yml': 'include:\n  - infra/services.yml\n',
      'infra/services.yml': 'services:\n  b:\n    image: b\n',
    });
    expect(readDeploy(root).files.sort()).toEqual(['docker-compose.yml', 'infra/services.yml']);
  });

  it('keeps every definition of a service that several compose files define', async () => {
    const root = await project({
      'docker-compose.linux.yml': 'services:\n  backend:\n    build: ./backend\n    command: python -m app.linux\n',
      'docker-compose.macos.yml': 'services:\n  backend:\n    build: ./backend\n    command: python -m app.macos\n',
    });
    const defs = readDeploy(root).services.get('backend') ?? [];
    expect(defs.map((d) => [d.file, launch(d)]).sort()).toEqual([
      ['docker-compose.linux.yml', 'python -m app.linux'],
      ['docker-compose.macos.yml', 'python -m app.macos'],
    ]);
  });

  it('warns about an unparsable compose file and names it', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  a:\n    image: a\n',
      'docker-compose.broken.yml': 'services:\n  b: [unclosed\n',
    });
    expect(readDeploy(root).warnings.some((w) => w.includes('docker-compose.broken.yml'))).toBe(true);
  });

  it('still reads the other compose files when one is unparsable', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  a:\n    image: a\n',
      'docker-compose.broken.yml': 'services:\n  b: [unclosed\n',
    });
    expect([...readDeploy(root).services.keys()]).toEqual(['a']);
  });
});

describe('readDeploy: launch command', () => {
  it('uses the compose command given as a list', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n    command: ["python", "-m", "app.worker"]\n',
    });
    expect(launch(service(root, 'worker'))).toContain('python -m app.worker');
  });

  it('launches with the compose entrypoint followed by the compose command', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build: ./backend\n    entrypoint: ["poetry", "run"]\n    command: uvicorn app.main:app\n',
    });
    expect(launch(service(root, 'api'))).toMatch(/poetry run\s+uvicorn app\.main:app/);
  });

  it('falls back to the CMD of the Dockerfile the service builds', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build: ./backend\n',
      'backend/Dockerfile': 'FROM python:3.12\nCMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]\n',
    });
    expect(launch(service(root, 'api'))).toContain('uvicorn app.main:app');
  });

  it('runs the Dockerfile CMD through its ENTRYPOINT', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n',
      'backend/Dockerfile': 'FROM python:3.12\nENTRYPOINT ["python"]\nCMD ["-m", "app.worker"]\n',
    });
    expect(launch(service(root, 'worker'))).toMatch(/python\s+-m app\.worker/);
  });

  it('keeps the Dockerfile ENTRYPOINT when compose overrides only the command', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n    command: -A app.tasks worker\n',
      'backend/Dockerfile': 'FROM python:3.12\nENTRYPOINT ["celery"]\nCMD ["--help"]\n',
    });
    expect(launch(service(root, 'worker'))).toMatch(/celery\s+-A app\.tasks worker/);
  });

  it('reads the Dockerfile that build.dockerfile names inside the context', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build:\n      context: ./backend\n      dockerfile: docker/api.Dockerfile\n',
      'backend/Dockerfile': 'FROM python:3.12\nCMD ["python", "-m", "wrong"]\n',
      'backend/docker/api.Dockerfile': 'FROM python:3.12\nCMD ["uvicorn", "app.main:app"]\n',
    });
    expect(launch(service(root, 'api'))).toContain('uvicorn app.main:app');
  });

  it('follows FROM <stage> to the CMD a build target inherits', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build:\n      context: ./backend\n      target: api\n',
      'backend/Dockerfile': [
        'FROM python:3.12 AS base',
        'CMD ["uvicorn", "app.main:app"]',
        'FROM base AS api',
        'RUN pip install gunicorn',
        'FROM base AS worker',
        'CMD ["python", "-m", "app.worker"]',
        '',
      ].join('\n'),
    });
    const text = launch(service(root, 'api'));
    expect([text.includes('uvicorn app.main:app'), text.includes('app.worker')]).toEqual([true, false]);
  });

  it('uses the last stage of the Dockerfile when the build names no target', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n',
      'backend/Dockerfile': [
        'FROM python:3.12 AS base',
        'CMD ["uvicorn", "app.main:app"]',
        'FROM base AS worker',
        'CMD ["python", "-m", "app.worker"]',
        '',
      ].join('\n'),
    });
    expect(launch(service(root, 'worker'))).toContain('python -m app.worker');
  });

  it('reads a startup script that a Dockerfile heredoc writes and the command runs', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build: ./backend\n',
      'backend/Dockerfile': [
        'FROM python:3.12',
        'RUN cat <<EOF > /usr/local/bin/startup.sh',
        '#!/bin/sh',
        'alembic upgrade head',
        'exec uvicorn src.main:app --host 0.0.0.0',
        'EOF',
        'RUN chmod +x /usr/local/bin/startup.sh',
        'CMD ["/usr/local/bin/startup.sh"]',
        '',
      ].join('\n'),
    });
    expect(launch(service(root, 'api'))).toContain('uvicorn src.main:app');
  });

  it('reads a heredoc script written with the redirect before the heredoc marker', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build: ./backend\n',
      'backend/Dockerfile': [
        'FROM python:3.12',
        "RUN cat > /usr/local/bin/startup.sh <<'EOF'",
        '#!/bin/sh',
        'exec uvicorn src.main:app --host 0.0.0.0',
        'EOF',
        'CMD ["/usr/local/bin/startup.sh"]',
        '',
      ].join('\n'),
    });
    expect(launch(service(root, 'api'))).toContain('uvicorn src.main:app');
  });

  it('reads a heredoc script that the command runs by its name on the PATH', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    build: ./backend\n',
      'backend/Dockerfile': [
        'FROM python:3.12',
        'RUN cat <<EOF > /usr/local/bin/startup.sh',
        '#!/bin/sh',
        'exec uvicorn src.main:app --host 0.0.0.0',
        'EOF',
        'CMD ["startup.sh"]',
        '',
      ].join('\n'),
    });
    expect(launch(service(root, 'api'))).toContain('uvicorn src.main:app');
  });

  it('reads a script from the repository that the command runs', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n    command: ./scripts/start.sh\n',
      'backend/scripts/start.sh': '#!/bin/sh\nexec python -m app.worker\n',
    });
    expect(launch(service(root, 'worker'))).toContain('python -m app.worker');
  });

  it('reads scripts one level deep only', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  worker:\n    build: ./backend\n    command: ./scripts/start.sh\n',
      'backend/scripts/start.sh': '#!/bin/sh\nexec ./scripts/inner.sh\n',
      'backend/scripts/inner.sh': '#!/bin/sh\nexec celery -A app.deep worker\n',
    });
    expect(launch(service(root, 'worker'))).not.toContain('celery -A app.deep');
  });
});

describe('readDeploy: service details', () => {
  it('lists bind-mounted repository directories and skips named volumes and host paths', async () => {
    const root = await project({
      'docker-compose.yml': [
        'services:',
        '  frontend-dev:',
        '    image: node:20-alpine',
        '    volumes:',
        '      - ./frontend:/app',
        '      - node_modules:/app/node_modules',
        '      - /var/run/docker.sock:/var/run/docker.sock',
        'volumes:',
        '  node_modules: {}',
        '',
      ].join('\n'),
    });
    expect(service(root, 'frontend-dev').mounts).toEqual(['frontend']);
  });

  it('lists bind mounts given in the long syntax', async () => {
    const root = await project({
      'docker-compose.yml': [
        'services:',
        '  worker:',
        '    image: python:3.12',
        '    volumes:',
        '      - type: bind',
        '        source: ./backend',
        '        target: /app',
        '      - type: volume',
        '        source: data',
        '        target: /data',
        '',
      ].join('\n'),
    });
    expect(service(root, 'worker').mounts).toEqual(['backend']);
  });

  it('resolves the build context and mounts of an included file relative to that file', async () => {
    const root = await project({
      'docker-compose.yml': 'include:\n  - infra/services.yml\n',
      'infra/services.yml': 'services:\n  api:\n    build: ../backend\n    volumes:\n      - ../frontend:/app\n',
    });
    const def = service(root, 'api');
    expect([def.build?.context, def.mounts]).toEqual(['backend', ['frontend']]);
  });

  it('reads environment given as a list of KEY=value', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  proxy:\n    image: nginx\n    environment:\n      - BACKEND_URL=http://backend:8008\n',
    });
    expect(service(root, 'proxy').env).toContainEqual(['BACKEND_URL', 'http://backend:8008']);
  });

  it('reads environment given as a map, numbers as text', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  api:\n    image: api\n    environment:\n      POSTGRES_HOST: postgres\n      POSTGRES_PORT: 5432\n',
    });
    expect(service(root, 'api').env).toEqual([
      ['POSTGRES_HOST', 'postgres'],
      ['POSTGRES_PORT', '5432'],
    ]);
  });

  it('applies YAML merge keys', async () => {
    const root = await project({
      'docker-compose.yml': [
        'x-common: &common',
        '  environment:',
        '    NATS_URL: nats://nats:4222',
        'services:',
        '  worker:',
        '    <<: *common',
        '    build: ./backend',
        '',
      ].join('\n'),
    });
    expect(service(root, 'worker').env).toContainEqual(['NATS_URL', 'nats://nats:4222']);
  });

  it('marks the services that publish ports', async () => {
    const root = await project({
      'docker-compose.yml': 'services:\n  proxy:\n    image: nginx\n    ports: ["80:80"]\n  api:\n    image: api\n',
    });
    expect([service(root, 'proxy').ports, service(root, 'api').ports]).toEqual([true, false]);
  });
});

describe('readBuilds', () => {
  const PY = 'FROM python:3.12\nCMD ["python", "-m", "app.main"]\n';
  const HELM = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: {{ include "chart.fullname" . }}',
    '  labels:',
    '    {{- include "chart.labels" . | nindent 4 }}',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: api',
    '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
    '          env:',
    '            - name: FROM_MANIFEST',
    '              value: "1"',
    '',
  ].join('\n');
  const MARKED = [{ name: 'FROM_MANIFEST', value: '1' }];

  const perService = <T,>(root: string, of: (def: ServiceDef) => T) => Object.fromEntries([...readBuilds(root).services].map(([name, defs]) => [name, defs.map(of)]));
  const builtFrom = (def: ServiceDef) => (def.build ? posix.join(def.build.context, def.build.dockerfile) : null);
  const definedIn = (root: string, file: string) =>
    [...readBuilds(root).services].filter(([, defs]) => defs.some((d) => d.file === file)).map(([name]) => name);

  it('names the service of each Dockerfile after its directory and suffix, and of a Dockerfile at the root after the project', async () => {
    const root = await project({
      Dockerfile: PY,
      'api/Dockerfile': PY,
      'api/Dockerfile.dockerignore': 'node_modules\n',
      'web/Dockerfile': PY,
      'web/Dockerfile.dev': PY,
      'worker/Dockerfile.gpu': PY,
    });
    expect(perService(root, builtFrom)).toEqual({
      [basename(root)]: ['Dockerfile'],
      api: ['api/Dockerfile'],
      web: ['web/Dockerfile'],
      'web-dev': ['web/Dockerfile.dev'],
      'worker-gpu': ['worker/Dockerfile.gpu'],
    });
  });

  it('looks three directories deep, past hidden, vendored, test and gitignored directories', async () => {
    const root = await project({
      '.gitignore': 'generated/\nDockerfile.local\n',
      'app/Dockerfile': PY,
      'a/b/c/Dockerfile': PY,
      'a/b/c/d/Dockerfile': PY,
      '.claude/worktrees/feature/Dockerfile': PY,
      'vendor/lib/Dockerfile': PY,
      'tests/Dockerfile': PY,
      'test/Dockerfile': PY,
      '__tests__/Dockerfile': PY,
      'e2e/Dockerfile': PY,
      'fixtures/Dockerfile': PY,
      'testdata/Dockerfile': PY,
      'generated/Dockerfile': PY,
      'svc/Dockerfile.local': PY,
    });
    expect([...readBuilds(root).services.keys()].sort()).toEqual(['app', 'c']);
  });

  it('keeps the names of the compose services in a subdirectory, and draws no service of its own for the Dockerfile they build', async () => {
    const root = await project({
      'api/Dockerfile': PY,
      'api/docker-compose.yml': stringify({
        services: { backend: { build: '.', command: 'uvicorn app.main:app' }, checks: { build: '.', command: 'pytest -q' }, cache: { image: 'redis:7' } },
      }),
    });
    expect(perService(root, (d) => d.file)).toEqual({ backend: ['api/docker-compose.yml'], checks: ['api/docker-compose.yml'], cache: ['api/docker-compose.yml'] });
  });

  it('adds the environment and ports of a Kubernetes container named after a service', async () => {
    const env = [
      { name: 'LOG_LEVEL', value: 'info' },
      { name: 'PORT', value: 8000 },
      { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db', key: 'url' } } },
    ];
    const root = await project({
      'api/Dockerfile': PY,
      'k8s/api.yaml': k8sWorkload('Deployment', [{ name: 'api', image: 'registry.example.com/acme/api:1.4.2', ports: [{ containerPort: 8000 }], env }]),
    });
    const def = readBuilds(root).services.get('api')?.find((d) => d.file === 'k8s/api.yaml');
    expect([def?.env, def?.ports]).toEqual([[['LOG_LEVEL', 'info'], ['PORT', '8000'], ['DATABASE_URL', '']], true]);
  });

  it.each([
    ['main', 'registry:5000/acme/worker:1.2', 'worker'],
    ['main', 'ghcr.io/acme/acme-worker@sha256:0123abcd', 'worker'],
    ['api', 'ghcr.io/acme/worker:1', 'api'],
    ['main', 'ghcr.io/acme/coworker:1', null],
    ['main', 'ghcr.io/acme/workers:1', null],
  ])('gives the Kubernetes container %s running %s to service %s', async (name, image, owner) => {
    const root = await project({ 'api/Dockerfile': PY, 'worker/Dockerfile': PY, 'k8s/app.yaml': k8sWorkload('Deployment', [{ name, image, env: MARKED }]) });
    expect(definedIn(root, 'k8s/app.yaml')).toEqual(owner ? [owner] : []);
  });

  it('reads the containers of a CronJob in a manifest of several documents', async () => {
    const service = stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'reports' }, spec: { ports: [{ port: 80 }] } });
    const cron = k8sWorkload('CronJob', [{ name: 'reports', image: 'acme/reports:1', env: [{ name: 'TZ', value: 'UTC' }] }]);
    const root = await project({ 'reports/Dockerfile': PY, 'k8s/reports.yaml': `${service}---\n${cron}` });
    expect(readBuilds(root).services.get('reports')?.find((d) => d.file === 'k8s/reports.yaml')?.env).toEqual([['TZ', 'UTC']]);
  });

  it.each([
    ['a Helm template', 'chart/templates/deployment.yaml', HELM],
    ['a manifest over 256 KB', 'k8s/api.yaml', `${k8sWorkload('Deployment', [{ name: 'api', image: 'acme/api:1', env: MARKED }])}# ${'x'.repeat(256 * 1024)}\n`],
    ['a workload of a service that only runs an image', 'k8s/cache.yaml', k8sWorkload('Deployment', [{ name: 'cache', image: 'redis:7', env: MARKED }])],
  ])('takes nothing from %s', async (_, path, manifest) => {
    const root = await project({
      'api/Dockerfile': PY,
      'api/docker-compose.yml': stringify({ services: { api: { build: '.' }, cache: { image: 'redis:7' } } }),
      [path]: manifest,
    });
    expect(definedIn(root, path)).toEqual([]);
  });

  it.each([
    ['COPY docker/start.sh /usr/local/bin/start.sh', '/usr/local/bin/start.sh', 'app/docker/start.sh'],
    ['COPY --chown=app:app docker/start.sh /start.sh', '/start.sh', 'app/docker/start.sh'],
    ['COPY docker/start.sh /usr/local/bin/', '/usr/local/bin/start.sh', 'app/docker/start.sh'],
    ['COPY docker /opt/docker', '/opt/docker/start.sh', 'app/docker/start.sh'],
    ['COPY --from=build /src/docker/start.sh /start.sh', '/start.sh', null],
  ])('after %s finds the repository script that runs as %s', async (copy, script, path) => {
    const root = await project({
      'app/Dockerfile': `FROM python:3.12\n${copy}\nCMD ["${script}"]\n`,
      'app/docker/start.sh': '#!/bin/sh\nexec python -m app.worker\n',
      'app/src/docker/start.sh': '#!/bin/sh\nexec python -m app.built\n',
    });
    expect(readBuilds(root).services.get('app')?.[0]?.scripts).toEqual(path ? [path] : []);
  });

  it('reports the Dockerfiles, compose files and workload manifests it read', async () => {
    const root = await project({
      'api/Dockerfile': PY,
      'api/compose.yaml': stringify({ services: { cache: { image: 'redis:7' } } }),
      'k8s/api.yaml': k8sWorkload('Deployment', [{ name: 'api', image: 'acme/api:1' }]),
      'k8s/config.yaml': stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'app' }, data: { LOG_LEVEL: 'info' } }),
      'docs/mkdocs.yml': 'site_name: docs\n',
      'chart/templates/deployment.yaml': HELM,
    });
    expect(readBuilds(root).files.sort()).toEqual(['api/Dockerfile', 'api/compose.yaml', 'k8s/api.yaml']);
  });

  it('warns about a manifest whose aliases expand without bound, and reads the others', async () => {
    const levels = ['a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]'];
    for (const [i, name] of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].entries()) levels.push(`${name}: &${name} [${Array(9).fill(`*${'abcdefgh'[i]}`).join(', ')}]`);
    const bomb = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: bomb\n${levels.join('\n')}\nspec: {}\n`;
    const root = await project({ 'api/Dockerfile': PY, 'k8s/bomb.yaml': bomb, 'k8s/api.yaml': k8sWorkload('Deployment', [{ name: 'api', image: 'acme/api:1', env: MARKED }]) });
    const { warnings } = readBuilds(root);
    await watchDeploy(root, () => {}).close();
    expect([warnings.some((w) => w.startsWith('k8s/bomb.yaml')), definedIn(root, 'k8s/api.yaml')]).toEqual([true, ['api']]);
  });

  it('reads the project once, and again when a watch starts or closes', async () => {
    const root = await project({ 'api/Dockerfile': PY });
    const names = () => [...readBuilds(root).services.keys()].sort();
    names();
    await writeTree(root, { 'worker/Dockerfile': PY });
    const cached = names();
    const watcher = watchDeploy(root, () => {});
    const started = names();
    await watcher.close();
    await writeTree(root, { 'extra/Dockerfile': PY });
    expect([cached, started, names()]).toEqual([['api'], ['api', 'worker'], ['api', 'extra', 'worker']]);
  });

  it.each([
    ['same-named compose services in same-named directories', { 'backend/docker/compose.yml': 'services:\n  app:\n    build: ..\n', 'frontend/docker/compose.yml': 'services:\n  app:\n    build: ..\n' }, { 'backend/docker/app': ['backend/docker/compose.yml'], 'frontend/docker/app': ['frontend/docker/compose.yml'] }],
    ['Dockerfiles whose prefixed names clash', { 'x-api/Dockerfile': PY, 'x/api/Dockerfile': PY, 'y/api/Dockerfile': PY }, { 'x-api/Dockerfile': ['x-api/Dockerfile'], 'x/api/Dockerfile': ['x/api/Dockerfile'], 'y-api': ['y/api/Dockerfile'] }],
  ])('keeps %s apart, each under one name', async (_, files, expected) => {
    expect(perService(await project(files), (d) => d.file)).toEqual(expected);
  });

  it('takes no lockfile or hidden YAML file for a manifest', async () => {
    const workload = k8sWorkload('Deployment', [{ name: 'api', image: 'acme/api:1', env: MARKED }]);
    const notManifests = ['pnpm-lock.yaml', 'lock.yaml', 'deploy/x.lock.yaml', '.gitlab-ci.yml', '.pre-commit-config.yaml'];
    const root = await project({ 'api/Dockerfile': PY, 'k8s/api.yaml': workload, ...Object.fromEntries(notManifests.map((path) => [path, workload])) });
    expect(readBuilds(root).files.sort()).toEqual(['api/Dockerfile', 'k8s/api.yaml']);
  });

  it.each([
    ['a script copied from outside the build context', { 'repo/app/Dockerfile': 'FROM debian:12\nCOPY ../../outside.sh /start.sh\nCMD ["/start.sh"]\n' }, { app: [['app', [], ['/start.sh']]] }],
    ['a build context outside the project', { 'repo/deploy/docker-compose.yml': 'services:\n  svc:\n    build: ../..\n' }, { svc: [[null, [], []]] }],
    ['a Dockerfile outside the project', { 'repo/deploy/docker-compose.yml': 'services:\n  svc:\n    build:\n      context: .\n      dockerfile: ../../Dockerfile\n' }, { svc: [['deploy', [], []]] }],
  ])('ignores %s', async (_, files, expected) => {
    const parent = await project({ 'outside.sh': '#!/bin/sh\nexec cron -f\n', Dockerfile: PY, ...files });
    expect(perService(join(parent, 'repo'), (d) => [d.build?.context ?? null, d.scripts, d.commands])).toEqual(expected);
  });
});

// Each test owns its project directory and watcher, so the file-event waits run side by side.
describe.concurrent('watchDeploy', () => {
  function watch(root: string, context: TestContext) {
    let calls = 0;
    const watcher = watchDeploy(root, () => {
      calls += 1;
    });
    context.onTestFinished(() => watcher.close());
    return {
      watcher,
      calls: () => calls,
      reset: () => {
        calls = 0;
      },
    };
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // macOS arms file events a moment after the watch starts, so one early write can be missed: write until reported.
  // Rewrites are spaced wider than the debounce, which a steady stream of writes would keep postponing.
  async function writeUntilReported(path: string, content: string, reported: () => boolean, label: string): Promise<void> {
    let n = 0;
    const write = () => writeFileSync(path, `${content}\n# ${(n += 1)}\n`);
    write();
    const timer = setInterval(write, 500);
    try {
      await waitFor(reported, label, 6000);
    } finally {
      clearInterval(timer);
    }
  }

  const COMPOSE = 'services:\n  api:\n    build: ./backend\n';
  const DOCKERFILE = 'FROM python:3.12\nCMD ["uvicorn", "app.main:app"]';
  const QUIET_MS = 700;

  async function armed(root: string, context: TestContext, file = 'docker-compose.yml', content = COMPOSE) {
    const w = watch(root, context);
    await writeUntilReported(join(root, file), content, () => w.calls() > 0, `${file} change reported`);
    await quiet(w);
    w.reset();
    return w;
  }

  // macOS may report the files the project was just written with: those reports are let pass before counting.
  async function settled(root: string, context: TestContext) {
    const w = watch(root, context);
    await quiet(w);
    w.reset();
    return w;
  }

  // Under load a report can lag the write by more than the pause, so the pause repeats until it passes without one.
  async function quiet(w: { calls(): number }) {
    for (let seen = -1; seen !== w.calls(); ) {
      seen = w.calls();
      await pause(QUIET_MS);
    }
  }

  it('reports a change to a compose file', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE }, context);
    const w = watch(root, context);
    await writeUntilReported(join(root, 'docker-compose.yml'), COMPOSE, () => w.calls() > 0, 'compose change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a change to a file that a compose file includes', async (context) => {
    const { expect } = context;
    const included = COMPOSE.replace('./backend', '../backend');
    const root = await project({ 'docker-compose.yml': 'include:\n  - infra/services.yml\n', 'infra/services.yml': included, 'backend/Dockerfile': DOCKERFILE }, context);
    const w = watch(root, context);
    await writeUntilReported(join(root, 'infra/services.yml'), included, () => w.calls() > 0, 'include change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a change to a Dockerfile that a service builds', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE }, context);
    const w = watch(root, context);
    await writeUntilReported(join(root, 'backend/Dockerfile'), DOCKERFILE, () => w.calls() > 0, 'Dockerfile change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a compose file that appears after the watch started', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE }, context);
    // Armed first: macOS may report the files the project was just written with, which would pass for the new one.
    const w = await armed(root, context);
    await writeUntilReported(join(root, 'compose.override.yml'), 'services:\n  extra:\n    image: redis\n', () => w.calls() > 0, 'new compose file reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('starts watching a Dockerfile that an edited compose file begins to build', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE, 'worker/Dockerfile': DOCKERFILE }, context);
    const w = watch(root, context);
    await writeUntilReported(join(root, 'docker-compose.yml'), `${COMPOSE}  worker:\n    build: ./worker\n`, () => w.calls() > 0, 'compose edit reported');
    await pause(QUIET_MS);
    w.reset();
    await writeUntilReported(join(root, 'worker/Dockerfile'), DOCKERFILE, () => w.calls() > 0, 'new Dockerfile change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 20_000);

  it('reports a burst of writes once', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE }, context);
    const w = await armed(root, context);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(root, 'docker-compose.yml'), `${COMPOSE}# burst ${i}\n`);
      await pause(40);
    }
    await waitFor(() => w.calls() > 0, 'burst reported', 5000);
    await pause(QUIET_MS);
    expect(w.calls()).toBe(1);
  }, 20_000);

  it('does not report changes to files that are neither compose files nor built Dockerfiles', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE, 'backend/app/main.py': '', 'README.md': '', 'worker/Dockerfile': DOCKERFILE }, context);
    const w = await armed(root, context);
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(root, 'README.md'), `# readme ${i}\n`);
      writeFileSync(join(root, 'backend/app/main.py'), `x = ${i}\n`);
      writeFileSync(join(root, 'worker/Dockerfile'), `${DOCKERFILE}\n# ${i}\n`);
      await pause(150);
    }
    await pause(QUIET_MS);
    expect(w.calls()).toBe(0);
  }, 20_000);

  it('stops reporting once closed', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE }, context);
    const w = await armed(root, context);
    await w.watcher.close();
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(root, 'docker-compose.yml'), `${COMPOSE}# after close ${i}\n`);
      await pause(150);
    }
    await pause(QUIET_MS);
    expect(w.calls()).toBe(0);
  }, 20_000);

  it.for([
    ['no compose file', {}],
    ['a compose file that only runs tests', { 'docker-compose.yml': 'services:\n  tests:\n    build: ./backend\n    command: pytest -q\n' }],
  ] as const)('reads a changed Dockerfile in a subdirectory again when the root has %s', { timeout: 15_000 }, async ([, files], context) => {
    const { expect } = context;
    const root = await project({ ...files, 'worker/Dockerfile': 'FROM python:3.12\nCMD ["python", "-m", "app.old"]\n' }, context);
    const launch = () => readBuilds(root).services.get('worker')?.[0]?.commands[0];
    const w = await settled(root, context);
    const before = launch();
    await writeUntilReported(join(root, 'worker/Dockerfile'), 'FROM python:3.12\nCMD ["python", "-m", "app.new"]', () => w.calls() > 0, 'Dockerfile change reported');
    expect([before, launch()]).toEqual(['python -m app.old', 'python -m app.new']);
  });

  // A project deployed from its Dockerfiles: app/Dockerfile runs app/start.sh.
  const APP = { 'app/Dockerfile': 'FROM python:3.12\nCOPY start.sh /start.sh\nCMD ["/start.sh"]\n', 'app/start.sh': '#!/bin/sh\nexec python -m app.old\n' };
  const app = (root: string) => readBuilds(root).services.get('app')?.[0];

  it.for([
    ['a Dockerfile in an empty directory', 'services/new/Dockerfile', 'FROM python:3.12', (root: string) => readBuilds(root).services.has('new')],
    ['a compose file in an existing directory', 'app/compose.yml', 'services:\n  worker:\n    build: .\n', (root: string) => readBuilds(root).services.has('worker')],
    ['an edit of the start script', 'app/start.sh', '#!/bin/sh\nexec python -m app.new\n', (root: string) => app(root)?.commands.some((c) => c.includes('app.new'))],
  ] as const)('reads the project again after %s', { timeout: 15_000 }, async ([, path, content, seen], context) => {
    const { expect } = context;
    const root = await project(APP, context);
    // A directory made before the watch is armed is never seen, and a rewrite cannot bring it back: it exists from the start.
    await mkdir(dirname(join(root, path)), { recursive: true });
    const w = await settled(root, context);
    await writeUntilReported(join(root, path), content, () => w.calls() > 0, `${path} reported`);
    expect(seen(root)).toBe(true);
  });

  it('reads the project again after its start script is deleted', { timeout: 15_000 }, async (context) => {
    const { expect } = context;
    const root = await project(APP, context);
    const w = await armed(root, context, 'app/start.sh', APP['app/start.sh']);
    rmSync(join(root, 'app/start.sh'));
    await waitFor(() => w.calls() > 0, 'start script deletion reported', 6000);
    expect(app(root)?.scripts).toEqual([]);
  });

  it('does not report changes to lockfiles and hidden YAML files of a project deployed from its Dockerfiles', { timeout: 20_000 }, async (context) => {
    const { expect } = context;
    const root = await project(APP, context);
    const w = await armed(root, context, 'app/start.sh', APP['app/start.sh']);
    for (let i = 0; i < 3; i += 1) {
      for (const file of ['pnpm-lock.yaml', 'lock.yaml', 'app/x.lock.yaml', '.gitlab-ci.yml', '.pre-commit-config.yaml']) writeFileSync(join(root, file), `# ${i}\n`);
      await pause(150);
    }
    await pause(QUIET_MS);
    expect(w.calls()).toBe(0);
  });

  it('reports a change even when reading the project again fails', { timeout: 15_000 }, async (context) => {
    const { expect } = context;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    context.onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const root = await project(APP, context);
    const w = await armed(root, context, 'app/start.sh', APP['app/start.sh']);
    rmSync(root, { recursive: true, force: true });
    await waitFor(() => w.calls() > 0, 'removal reported', 6000);
    expect(w.calls()).toBeGreaterThan(0);
  });
});
