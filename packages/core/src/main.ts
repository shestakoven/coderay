import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { MapSnapshot } from '@ide/protocol';
import { computeFileEdges } from './graph/edges';
import { defaultIdeHome, projectDir, runDir } from './home';
import { Indexer } from './indexer/indexer';
import { createPythonAdapter } from './lang/python';
import { createTypeScriptAdapter } from './lang/typescript';
import { MapService } from './map/map-service';
import { buildSnapshot } from './map/snapshot';
import { removeStaleModelDirs } from './models/claude-cli';
import { createModelProvider } from './models/provider';
import { startServer, type RunningServer } from './server/server';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: ['.'] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    'ide-home': { type: 'string' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`IDE core: invalid --port "${values.port}"`);
  process.exit(1);
}

const projectArg = resolve(values.project.at(-1) ?? '.');
let root: string;
try {
  root = realpathSync(projectArg);
  if (!statSync(root).isDirectory()) throw new Error('not a directory');
} catch {
  console.error(`IDE core: project directory not found: ${projectArg}`);
  process.exit(1);
}
const projectName = basename(root);
const home = resolve(values['ide-home'] ?? defaultIdeHome());

try {
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const indexer = new Indexer({ root, adapters });
  await indexer.start();
  await removeStaleModelDirs(runDir(home));

  let files = indexer.files();
  let edges = computeFileEdges(files, adapters);
  let version = 0;
  let snapshot: MapSnapshot | undefined;
  let server: RunningServer | undefined;
  const publish = (): MapSnapshot => {
    version += 1;
    snapshot = buildSnapshot(version, projectName, files, edges, mapService.view());
    server?.broadcast({ type: 'map.snapshot', snapshot });
    return snapshot;
  };

  const models = createModelProvider(home);
  const mapService = new MapService({
    root,
    projectName,
    stateDir: projectDir(home, root),
    reasoning: models.reasoning,
    embed: models.embed,
    isAgentIdle: () => true,
    onChange: publish,
  });
  indexer.onChange(() => {
    files = indexer.files();
    edges = computeFileEdges(files, adapters);
    mapService.update(files, edges);
    if (snapshot) publish();
  });
  await mapService.start(files, edges);
  const initial = publish();
  const running = await startServer({
    port,
    staticDir: values.ui ? resolve(values.ui) : undefined,
    allowedOrigins: values['allow-origin'],
    snapshot: () => snapshot ?? initial,
  });
  server = running;

  console.log(`IDE core: ${root}`);
  console.log(`  ${initial.files.length} files, ${initial.components.length} components (${initial.status.layer} map)`);
  console.log(`  IDE home: ${home}`);
  console.log(`  http://127.0.0.1:${running.port}`);

  const shutdown = async (): Promise<void> => {
    const stopping = mapService.stop();
    await models.close();
    await stopping;
    await indexer.stop();
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(`IDE core failed to start: ${(error as Error).message}`);
  process.exit(1);
}
