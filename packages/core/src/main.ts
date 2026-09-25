import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ClientMessage, MapSnapshot, ServerMessage } from '@ide/protocol';
import { AgentSession } from './agent/agent-session';
import { computeFileEdges, unresolvedImports } from './graph/edges';
import { defaultIdeHome, projectDir, runDir } from './home';
import { Indexer } from './indexer/indexer';
import { createPythonAdapter } from './lang/python';
import { createTypeScriptAdapter } from './lang/typescript';
import { acquireCoreLock } from './lock';
import { MapService } from './map/map-service';
import { buildSnapshot } from './map/snapshot';
import { IdentifierClassifier } from './c4/classify';
import { watchDeploy } from './c4/deploy';
import { buildC4 } from './c4/model';
import { McpRegistry } from './mcp/registry';
import { removeStaleModelDirs } from './models/claude-cli';
import { createModelProvider } from './models/provider';
import { ProgressReporter } from './progress';
import { startServer, type RunningServer } from './server/server';
import { openStore } from './store/store';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: ['.'] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    'ide-home': { type: 'string' },
    claude: { type: 'string', default: 'claude' },
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

const lock = acquireCoreLock(projectDir(home, root));
if (!lock.acquired) {
  console.error(`IDE core: another IDE core (pid ${lock.holder}) is already running for ${root}.`);
  console.error(`  Stop it first, or delete ${lock.path} if that process is not an IDE core.`);
  process.exit(1);
}
const token = randomBytes(24).toString('base64url');

try {
  const store = openStore(projectDir(home, root));
  const registry = new McpRegistry({ home, root });
  const session = new AgentSession({
    root, home, store,
    claude: { command: values.claude, args: [] },
    mcpServers: () => registry.sessionServers(),
  });
  await session.start();
  const models = createModelProvider(home);

  const settingsSnapshot = (): ServerMessage => ({ type: 'settings.snapshot', settings: registry.view() });

  const changeSettings = (message: Extract<ClientMessage, { requestId: string; type: `mcp.${string}` }>): void => {
    switch (message.type) {
      case 'mcp.save':
        registry.save(message.level, message.name, message.entry, message.previousName);
        return;
      case 'mcp.remove':
        registry.remove(message.level, message.name);
        return;
      case 'mcp.approve':
        registry.approve(message.name, message.entryHash);
        return;
      case 'mcp.confirm-external-edits':
        registry.confirmExternalEdits(message.fileHashes);
        return;
    }
  };

  let server: RunningServer | undefined;
  let closing: Promise<void> | undefined;
  let snapshot: MapSnapshot | undefined;
  let indexer: Indexer | undefined;
  let mapService: MapService | undefined;
  let classifier: IdentifierClassifier | undefined;
  let deployWatch: { close(): Promise<void> } | undefined;
  const progress = new ProgressReporter((current) => server?.broadcast({ type: 'map.progress', progress: current }));

  const handle = async (message: ClientMessage, reply: (message: ServerMessage) => void): Promise<void> => {
    switch (message.type) {
      case 'chat.send':
        session.send(message.text);
        return;
      case 'chat.stop':
        session.stop();
        return;
      case 'session.restart':
        await session.restart();
        return;
      case 'session.new':
        await session.newSession();
        return;
      case 'prompt.answer':
        session.answerPrompt(message.requestId, message.answer);
        return;
      case 'settings.get':
        reply(settingsSnapshot());
        return;
      default: {
        let error: string | null = null;
        try {
          changeSettings(message);
        } catch (failure) {
          error = (failure as Error).message;
        }
        reply({ type: 'settings.result', requestId: message.requestId, error });
        server?.broadcast(settingsSnapshot());
      }
    }
  };

  const running = await startServer({
    port,
    token,
    staticDir: values.ui ? resolve(values.ui) : undefined,
    allowedOrigins: values['allow-origin'],
    snapshot: () => snapshot ?? null,
    greeting: () => [
      { type: 'map.progress', progress: progress.get() },
      { type: 'session.snapshot', state: session.state() },
      settingsSnapshot(),
    ],
    onClientMessage: (message, reply) => {
      if (closing) {
        reply({ type: 'error', message: 'The IDE core is shutting down.' });
        return;
      }
      handle(message, reply).catch((error: unknown) => reply({ type: 'error', message: (error as Error).message }));
    },
  });
  server = running;
  session.onMessage((message) => running.broadcast(message));

  const shutdown = async (): Promise<void> => {
    await session.close();
    progress.stop();
    classifier?.stop();
    await deployWatch?.close();
    const stopping = mapService?.stop();
    await models.close();
    await stopping;
    await indexer?.stop();
    await running.close();
    store.close();
    lock.release();
    process.exit(0);
  };
  let firstInterrupt = 0;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (signal === 'SIGINT') {
        if (firstInterrupt && Date.now() - firstInterrupt > 1000) process.exit(130);
        firstInterrupt ||= Date.now();
      }
      closing ??= shutdown();
    });
  }

  console.log(`IDE core: ${root}`);
  console.log(`  agent: ${values.claude} (unguarded until Plan 4) · IDE home: ${home}`);
  if (values.ui) console.log(`  open: http://127.0.0.1:${running.port}/#token=${token}`);
  for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);

  progress.set({ indexing: { indexed: 0 } });
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const index = new Indexer({ root, adapters, onProgress: (indexed) => progress.set({ indexing: { indexed } }) });
  indexer = index;
  await index.start();
  progress.set({ indexing: null });
  await removeStaleModelDirs(runDir(home));

  // A shutdown that began while indexing must not start the map service, whose model calls it could no longer stop.
  if (!closing) {
    let files = index.files();
    let edges = computeFileEdges(files, adapters);
    let unresolved = unresolvedImports(files, adapters);
    let version = 0;
    const names = new IdentifierClassifier({
      model: models.fast,
      cachePath: join(home, 'c4-classification.json'),
      onChange: () => {
        if (snapshot) publish();
      },
    });
    classifier = names;
    const service = new MapService({
      root,
      projectName,
      stateDir: projectDir(home, root),
      reasoning: models.reasoning,
      embed: models.embed,
      isAgentIdle: () => true,
      onChange: () => publish(),
      onEmbeddingProgress: (embedding) => progress.set({ embedding }),
    });
    mapService = service;
    function publish(): MapSnapshot {
      version += 1;
      const view = service.view();
      const c4 = buildC4(root, files, edges, view.components, unresolved, names.lookup);
      names.request(c4.pending);
      const status = names.status();
      if (status.waiting > 0) c4.model.warnings.push(`Classifying ${status.waiting} package, image and host names with Haiku (names only)`);
      if (status.failure) c4.model.warnings.push(`Could not classify names: ${status.failure}`);
      snapshot = { ...buildSnapshot(version, projectName, files, edges, view), c4: c4.model };
      running.broadcast({ type: 'map.snapshot', snapshot });
      return snapshot;
    }
    index.onChange(() => {
      files = index.files();
      edges = computeFileEdges(files, adapters);
      unresolved = unresolvedImports(files, adapters);
      service.update(files, edges);
      if (snapshot) publish();
    });
    deployWatch = watchDeploy(root, () => {
      if (snapshot) publish();
    });
    await service.start(files, edges);
    if (!closing) {
      const initial = publish();
      console.log(`  ${initial.files.length} files, ${initial.components.length} components (${initial.status.layer} map)`);
    }
  }
} catch (error) {
  lock.release();
  console.error(`IDE core failed to start: ${(error as Error).message}`);
  process.exit(1);
}
