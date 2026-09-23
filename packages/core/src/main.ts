import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Indexer } from './indexer/indexer';
import { createPythonAdapter } from './lang/python';
import { createTypeScriptAdapter } from './lang/typescript';
import { buildSnapshot } from './map/snapshot';
import { startServer } from './server/server';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: ['.'] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`IDE core: invalid --port "${values.port}"`);
  process.exit(1);
}

const root = resolve(values.project.at(-1) ?? '.');
const projectName = basename(root);

try {
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const indexer = new Indexer({ root, adapters });
  await indexer.start();

  let version = 1;
  let snapshot = buildSnapshot(version, projectName, indexer.files(), adapters);
  const server = await startServer({
    port,
    staticDir: values.ui ? resolve(values.ui) : undefined,
    allowedOrigins: values['allow-origin'],
    snapshot: () => snapshot,
  });

  indexer.onChange(() => {
    version += 1;
    snapshot = buildSnapshot(version, projectName, indexer.files(), adapters);
    server.broadcast({ type: 'map.snapshot', snapshot });
  });

  console.log(`IDE core: ${root}`);
  console.log(`  ${snapshot.files.length} files, ${snapshot.components.length} components`);
  console.log(`  http://127.0.0.1:${server.port}`);

  const shutdown = async (): Promise<void> => {
    await indexer.stop();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(`IDE core failed to start: ${(error as Error).message}`);
  process.exit(1);
}
