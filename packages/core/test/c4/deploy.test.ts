import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { readDeploy, watchDeploy, type ServiceDef } from '../../src/c4/deploy';
import { tempDir, waitFor, writeTree } from '../helpers';

async function project(files: Record<string, string>): Promise<string> {
  const root = tempDir('ide-c4-deploy-');
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

  async function armed(root: string, context: TestContext) {
    const w = watch(root, context);
    await writeUntilReported(join(root, 'docker-compose.yml'), COMPOSE, () => w.calls() > 0, 'compose change reported');
    await pause(QUIET_MS);
    w.reset();
    return w;
  }

  it('reports a change to a compose file', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE });
    const w = watch(root, context);
    await writeUntilReported(join(root, 'docker-compose.yml'), COMPOSE, () => w.calls() > 0, 'compose change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a change to a file that a compose file includes', async (context) => {
    const { expect } = context;
    const included = COMPOSE.replace('./backend', '../backend');
    const root = await project({ 'docker-compose.yml': 'include:\n  - infra/services.yml\n', 'infra/services.yml': included, 'backend/Dockerfile': DOCKERFILE });
    const w = watch(root, context);
    await writeUntilReported(join(root, 'infra/services.yml'), included, () => w.calls() > 0, 'include change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a change to a Dockerfile that a service builds', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE });
    const w = watch(root, context);
    await writeUntilReported(join(root, 'backend/Dockerfile'), DOCKERFILE, () => w.calls() > 0, 'Dockerfile change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('reports a compose file that appears after the watch started', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE });
    const w = watch(root, context);
    await writeUntilReported(join(root, 'compose.override.yml'), 'services:\n  extra:\n    image: redis\n', () => w.calls() > 0, 'new compose file reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 15_000);

  it('starts watching a Dockerfile that an edited compose file begins to build', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE, 'worker/Dockerfile': DOCKERFILE });
    const w = watch(root, context);
    await writeUntilReported(join(root, 'docker-compose.yml'), `${COMPOSE}  worker:\n    build: ./worker\n`, () => w.calls() > 0, 'compose edit reported');
    await pause(QUIET_MS);
    w.reset();
    await writeUntilReported(join(root, 'worker/Dockerfile'), DOCKERFILE, () => w.calls() > 0, 'new Dockerfile change reported');
    expect(w.calls()).toBeGreaterThan(0);
  }, 20_000);

  it('reports a burst of writes once', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE });
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
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE, 'backend/app/main.py': '', 'README.md': '' });
    const w = await armed(root, context);
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(root, 'README.md'), `# readme ${i}\n`);
      writeFileSync(join(root, 'backend/app/main.py'), `x = ${i}\n`);
      await pause(150);
    }
    await pause(QUIET_MS);
    expect(w.calls()).toBe(0);
  }, 20_000);

  it('stops reporting once closed', async (context) => {
    const { expect } = context;
    const root = await project({ 'docker-compose.yml': COMPOSE, 'backend/Dockerfile': DOCKERFILE });
    const w = await armed(root, context);
    await w.watcher.close();
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(root, 'docker-compose.yml'), `${COMPOSE}# after close ${i}\n`);
      await pause(150);
    }
    await pause(QUIET_MS);
    expect(w.calls()).toBe(0);
  }, 20_000);
});
